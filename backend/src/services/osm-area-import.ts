import { createHash } from "node:crypto";
import type { OsmAreaCategory } from "@waypoint-ai/shared";
import type { Bbox, OsmAreaPlace } from "../sources/osm/osm-area.js";
import { tilesFor } from "../sources/osm/osm-area.js";
import type { SourceOutcome, SourceProgress } from "./import-jobs.js";

/** Pause between Overpass requests, as the public instance's usage policy asks. */
const TILE_PAUSE_MS = 1_000;

export interface OsmAreaStore {
  /** Registers or refreshes the dataset row of the area. */
  registerAreaSource(input: { sourceId: string; label: string; sourceUrl: string; snapshotDate: string }): Promise<void>;
  startRun(sourceId: string, startedAt: Date): Promise<string>;
  /** Writes the places; rows that another dataset already holds keep their dataset. */
  upsertPlaces(sourceId: string, places: OsmAreaPlace[], importToken: string): Promise<{ inserted: number; updated: number }>;
  finishRun(runId: string, outcome: { status: "succeeded" | "failed"; fetched: number; inserted: number; updated: number; errorCode: string | null; finishedAt: Date }): Promise<void>;
}

export interface OsmAreaImportInput {
  sourceId: string;
  label: string;
  bbox: Bbox;
  countryCode: string | null;
  categories: OsmAreaCategory[];
  sourceUrl: string;
  store: OsmAreaStore;
  fetchTile(tile: Bbox, signal: AbortSignal): Promise<OsmAreaPlace[]>;
  signal: AbortSignal;
  onProgress(progress: SourceProgress): void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

/** Dataset ID of an area import, from its name: "Kraków" becomes "osm-area-krakow". */
export function osmAreaSourceId(label: string): string {
  const slug = label.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `osm-area-${slug || createHash("sha256").update(label).digest("hex").slice(0, 8)}`;
}

/**
 * Loads OpenStreetMap places of an area tile by tile from Overpass, then writes them in one step, so a failed or
 * cancelled import leaves the database as it was. Each run is audited in source_sync_runs.
 */
export async function importOsmArea(input: OsmAreaImportInput): Promise<SourceOutcome> {
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const tiles = tilesFor(input.bbox);
  const runId = await input.store.startRun(input.sourceId, now());
  const places = new Map<string, OsmAreaPlace>();
  const report = (phase: SourceProgress["phase"], fraction: number, stepsDone: number) =>
    input.onProgress({ phase, fraction, fetched: places.size, stepsDone, stepsTotal: tiles.length });
  try {
    for (const [index, tile] of tiles.entries()) {
      report("fetching", 0.85 * (index / tiles.length), index);
      if (input.signal.aborted) throw new DOMException("Import cancelled", "AbortError");
      if (index > 0) await sleep(TILE_PAUSE_MS);
      for (const place of await input.fetchTile(tile, input.signal)) places.set(place.id, place);
    }
    report("saving", 0.85, tiles.length);
    if (input.signal.aborted) throw new DOMException("Import cancelled", "AbortError");
    const snapshotDate = now().toISOString().slice(0, 10);
    await input.store.registerAreaSource({ sourceId: input.sourceId, label: `OpenStreetMap: ${input.label} (Overpass)`, sourceUrl: input.sourceUrl, snapshotDate });
    const importToken = createHash("sha256").update(`${input.sourceId}:${snapshotDate}:${input.bbox.join(",")}:${input.categories.join(",")}`).digest("hex").slice(0, 32);
    const { inserted, updated } = await input.store.upsertPlaces(input.sourceId, [...places.values()], importToken);
    await input.store.finishRun(runId, { status: "succeeded", fetched: places.size, inserted, updated, errorCode: null, finishedAt: now() });
    report("done", 1, tiles.length);
    return { runId, fetched: places.size, inserted, updated, linkedPlaces: 0, warning: null };
  } catch (error) {
    const errorCode = input.signal.aborted ? "import_cancelled" : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "import_failed";
    await input.store.finishRun(runId, { status: "failed", fetched: places.size, inserted: 0, updated: 0, errorCode, finishedAt: now() });
    throw error;
  }
}
