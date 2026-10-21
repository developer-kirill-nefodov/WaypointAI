import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { invalidatePlaceCoverage } from "../data/coverage.js";
import { sqlDatasetDeleteStore } from "../data/dataset.repository.js";
import { sqlEventImportStore } from "../data/event-import.repository.js";
import { sqlImportJobStore } from "../data/import-job.repository.js";
import { sqlOsmAreaStore } from "../data/osm-area.repository.js";
import { deleteDataset } from "../services/dataset-delete.js";
import { importEvents } from "../services/event-import.js";
import { importJobEvents } from "../services/import-job-events.js";
import { ImportJobRunner } from "../services/import-jobs.js";
import { importOsmArea, osmAreaSourceId } from "../services/osm-area-import.js";
import { importOsmRegion, osmRegionSourceId, runOsmParser } from "../services/osm-region-import.js";
import { downloadGeofabrikFile, geofabrikFileInfo, geofabrikRegions } from "../sources/osm/geofabrik.js";
import { fetchOverpassTile } from "../sources/osm/osm-area.js";
import { createEventSourceAdapter, EVENT_SOURCE_USER_AGENT, type EventSourceId } from "../sources/registry.js";

/** Region files live only under data/local/regions, named by their catalogue ID. */
const REGION_DIRECTORY = fileURLToPath(new URL("../../../data/local/regions/", import.meta.url));

export const findRegion = async (regionId: string) => (await geofabrikRegions(EVENT_SOURCE_USER_AGENT)).find((region) => region.id === regionId) ?? null;

/** Background imports and deletions started from the app: events, OSM areas and regions, and dataset deletion. */
export const importJobRunner = new ImportJobRunner({
  store: sqlImportJobStore,
  publish: (job) => {
    importJobEvents.publish(job);
    // A new or deleted area is known to the assistant on its next turn.
    if (job.status !== "running" && job.params.kind !== "events") invalidatePlaceCoverage();
  },
  kinds: {
    events: {
      sources: ({ sourceIds }) => sourceIds.map((sourceId) => ({ sourceId, label: createEventSourceAdapter(sourceId as EventSourceId).descriptor.label })),
      run: async ({ days }, sourceId, { signal, onProgress }) => {
        const summary = await importEvents({
          adapter: createEventSourceAdapter(sourceId as EventSourceId),
          store: sqlEventImportStore,
          days,
          cooldownSeconds: env.EVENT_IMPORT_COOLDOWN_SECONDS,
          signal,
          onProgress: (progress) => onProgress({ phase: progress.phase, fraction: progress.fraction, fetched: progress.fetched, stepsDone: progress.windowsDone, stepsTotal: progress.windowsTotal, windowStart: progress.windowStart }),
        });
        return { runId: summary.runId, fetched: summary.counts.fetched, inserted: summary.counts.inserted, updated: summary.counts.updated, linkedPlaces: summary.linkedPlaces, warning: summary.truncated ? "window_truncated" : null };
      },
    },
    osm_area: {
      // The public Overpass instance asks for one heavy client at a time.
      exclusive: true,
      sources: ({ label }) => [{ sourceId: osmAreaSourceId(label), label }],
      run: (params, sourceId, { signal, onProgress }) => importOsmArea({
        ...params,
        sourceId,
        sourceUrl: env.OSM_OVERPASS_URL,
        store: sqlOsmAreaStore,
        signal,
        onProgress,
        fetchTile: (tile, tileSignal) => fetchOverpassTile(tile, params.categories, params.countryCode, { url: env.OSM_OVERPASS_URL, timeoutMs: env.OSM_REQUEST_TIMEOUT_MS, userAgent: EVENT_SOURCE_USER_AGENT, signal: tileSignal }),
      }),
    },
    osm_region: {
      // A region file is large and parsed in a child process; one at a time.
      exclusive: true,
      sources: ({ regionId, label }) => [{ sourceId: osmRegionSourceId(regionId), label }],
      run: async ({ regionId, label, countryCode }, sourceId, { signal, onProgress }) => {
        const region = await findRegion(regionId);
        if (!region) throw Object.assign(new Error("unknown_region"), { code: "unknown_region" });
        const file = resolve(REGION_DIRECTORY, `${region.id}-latest.osm.pbf`);
        return importOsmRegion({
          region,
          sourceId,
          file,
          store: sqlOsmAreaStore,
          signal,
          onProgress,
          download: async (onBytes, downloadSignal) => {
            // A file downloaded earlier is reused when it still matches the catalogue's size.
            const info = await geofabrikFileInfo(region, EVENT_SOURCE_USER_AGENT).catch(() => null);
            const existing = await stat(file).catch(() => null);
            if (existing && info?.bytes && existing.size === info.bytes) {
              onBytes(existing.size, existing.size);
              return { bytes: existing.size };
            }
            return downloadGeofabrikFile(region, file, { userAgent: EVENT_SOURCE_USER_AGENT, maxBytes: env.OSM_REGION_MAX_BYTES, signal: downloadSignal, onProgress: onBytes });
          },
          parse: (onParse, parseSignal) => runOsmParser({
            file,
            sourceId,
            sourceName: `OpenStreetMap: ${label} regional extract`,
            sourceUrl: region.pbfUrl,
            countryCode: countryCode ?? "XX",
          }, onParse, parseSignal),
        });
      },
    },
    dataset_delete: {
      sources: ({ datasetId, label }) => [{ sourceId: datasetId, label }],
      run: ({ datasetId }, _sourceId, { signal, onProgress }) => deleteDataset({ datasetId, store: sqlDatasetDeleteStore, signal, onProgress }),
    },
  },
});
