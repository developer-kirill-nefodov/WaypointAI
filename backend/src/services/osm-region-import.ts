import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { GeofabrikRegion } from "../sources/osm/geofabrik.js";
import type { SourceOutcome, SourceProgress } from "./import-jobs.js";
import type { OsmAreaStore } from "./osm-area-import.js";

/** Downloading takes this share of the progress; parsing and writing the rest. */
const DOWNLOAD_SHARE = 0.35;

export interface ParserProgress { phase: "parsing" | "airports"; bytesRead: number; totalBytes: number; imported: number }
export interface ParserResult { imported: number; skipped: number; snapshotDate: string | null }

export interface OsmRegionImportInput {
  region: GeofabrikRegion;
  sourceId: string;
  file: string;
  store: Pick<OsmAreaStore, "startRun" | "finishRun">;
  download(onProgress: (bytes: number, total: number | null) => void, signal: AbortSignal): Promise<{ bytes: number }>;
  /** Parses the file and writes the places (in a child process in production). */
  parse(onProgress: (progress: ParserProgress) => void, signal: AbortSignal): Promise<ParserResult>;
  signal: AbortSignal;
  onProgress(progress: SourceProgress): void;
  now?: () => Date;
}

/** Dataset ID of a whole region: "malopolskie" becomes "osm-region-malopolskie". */
export function osmRegionSourceId(regionId: string): string {
  return `osm-region-${regionId}`.slice(0, 80);
}

/**
 * Imports a whole Geofabrik region: downloads its PBF file with progress, then parses it and writes the places in a
 * separate process, so a large file does not stall the API. The run is audited in source_sync_runs.
 */
export async function importOsmRegion(input: OsmRegionImportInput): Promise<SourceOutcome> {
  const now = input.now ?? (() => new Date());
  const runId = await input.store.startRun(input.sourceId, now());
  let imported = 0;
  try {
    input.onProgress({ phase: "fetching", fraction: 0, fetched: 0, stepsDone: 0, stepsTotal: 0 });
    await input.download((bytes, total) => input.onProgress({
      phase: "fetching",
      fraction: total ? DOWNLOAD_SHARE * Math.min(1, bytes / total) : 0,
      fetched: 0,
      // For a region the steps are megabytes, so the dock can show "120 of 320 MB".
      stepsDone: Math.round(bytes / 1_048_576),
      stepsTotal: total ? Math.round(total / 1_048_576) : 0,
    }), input.signal);
    const result = await input.parse((progress) => {
      imported = progress.imported;
      const share = progress.phase === "parsing" ? 0.9 : 0.1;
      const offset = progress.phase === "parsing" ? 0 : 0.9;
      input.onProgress({
        phase: "saving",
        fraction: DOWNLOAD_SHARE + (1 - DOWNLOAD_SHARE) * (offset + share * Math.min(1, progress.bytesRead / Math.max(1, progress.totalBytes))) * 0.98,
        fetched: progress.imported,
        // The second, shorter pass only looks up airport outlines; the file counts as read.
        stepsDone: Math.round((progress.phase === "parsing" ? progress.bytesRead : progress.totalBytes) / 1_048_576),
        stepsTotal: Math.round(progress.totalBytes / 1_048_576),
      });
    }, input.signal);
    await input.store.finishRun(runId, { status: "succeeded", fetched: result.imported + result.skipped, inserted: result.imported, updated: 0, errorCode: null, finishedAt: now() });
    input.onProgress({ phase: "done", fraction: 1, fetched: result.imported, stepsDone: 0, stepsTotal: 0 });
    return { runId, fetched: result.imported, inserted: result.imported, updated: 0, linkedPlaces: 0, warning: null };
  } catch (error) {
    const errorCode = input.signal.aborted ? "import_cancelled" : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "import_failed";
    await input.store.finishRun(runId, { status: "failed", fetched: imported, inserted: 0, updated: 0, errorCode, finishedAt: now() });
    throw error;
  }
}

/**
 * Runs the import-osm CLI on a downloaded file in a child process and reads its JSON progress lines. Cancelling kills
 * the process; its single transaction is then rolled back, so a cancelled import writes nothing.
 */
export function runOsmParser(args: { file: string; sourceId: string; sourceName: string; sourceUrl: string; countryCode: string }, onProgress: (progress: ParserProgress) => void, signal: AbortSignal): Promise<ParserResult> {
  const here = fileURLToPath(import.meta.url);
  // In development the CLI runs from TypeScript through tsx; a build runs the compiled JavaScript.
  const typescript = here.endsWith(".ts");
  const cli = resolve(here, "..", "..", "cli", typescript ? "import-osm.ts" : "import-osm.js");
  const child = spawn(process.execPath, [
    ...(typescript ? ["--import", "tsx"] : []),
    cli,
    "--file", args.file,
    "--source-id", args.sourceId,
    "--source-name", args.sourceName,
    "--source-url", args.sourceUrl,
    "--country-code", args.countryCode,
    "--progress-json",
  ], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const onAbort = () => child.kill("SIGTERM");
  signal.addEventListener("abort", onAbort, { once: true });
  return new Promise((resolvePromise, reject) => {
    let result: ParserResult | null = null;
    let stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line) as { progress?: ParserProgress; result?: ParserResult };
        if (message.progress) onProgress(message.progress);
        if (message.result) result = message.result;
      } catch {
        // Lines that are not JSON (library warnings) are ignored.
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(new DOMException("Import cancelled", "AbortError"));
      if (code === 0 && result) return resolvePromise(result);
      console.warn("OSM region parser failed", { code, stderr: stderr.slice(-500) });
      reject(Object.assign(new Error("osm_parse_failed"), { code: "osm_parse_failed" }));
    });
  });
}
