import type {
  EventFetchResult,
  EventSourceAdapter,
  EventSourceDescriptor,
  NormalizedEvent,
  TimeWindow,
} from "../sources/source-adapter.js";
import { SourceFetchError } from "../sources/source-adapter.js";
import { DAY_MS, HOUR_MS } from "./time.js";

export const DEFAULT_IMPORT_DAYS = 7;
export const MAX_IMPORT_DAYS = 30;
const MAX_WINDOW_SPLIT_DEPTH = 6;
const MIN_SPLIT_WINDOW_MS = HOUR_MS;
/** A running import older than this is treated as crashed so it cannot block the source forever. */
const STALE_RUN_MS = 30 * 60 * 1000;

export interface RunCounts {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface UpsertResult {
  insertedIds: string[];
  updatedIds: string[];
  unchanged: number;
}

/** Persistence used by the import; implemented with SQL in data/event-import.repository.ts and in memory in tests. */
export interface EventImportStore {
  registerSource(descriptor: EventSourceDescriptor): Promise<void>;
  failStaleRuns(sourceId: string, startedBefore: Date): Promise<number>;
  /** Start of the latest running or succeeded run; failed runs do not delay a retry. */
  lastRunStartedAt(sourceId: string): Promise<Date | null>;
  /** Throws ImportAlreadyRunningError when another run for the source is active. */
  startRun(sourceId: string, window: TimeWindow, startedAt: Date): Promise<string>;
  upsertEvents(sourceId: string, events: NormalizedEvent[]): Promise<UpsertResult>;
  linkNearbyPlaces(recordIds: string[]): Promise<number>;
  /** Records of the source in the window without nearby-place links, for example after a failed link step. */
  findUnlinkedRecordIds(sourceId: string, window: TimeWindow): Promise<string[]>;
  finishRun(runId: string, outcome: RunOutcome): Promise<void>;
}

export interface RunOutcome {
  status: "succeeded" | "failed";
  counts: RunCounts;
  errorCode: string | null;
  finishedAt: Date;
}

export class ImportAlreadyRunningError extends Error {
  readonly code = "import_running";
}

export class ImportCooldownError extends Error {
  readonly code = "import_cooldown";
  constructor(readonly retryAfterSeconds: number) {
    super("import_cooldown");
  }
}

export interface ImportEventsInput {
  adapter: EventSourceAdapter;
  store: EventImportStore;
  days: number;
  cooldownSeconds: number;
  force?: boolean;
  now?: Date;
  signal?: AbortSignal;
  /** Called once the run row exists, so an HTTP caller can answer 202 with the run ID. */
  onRunStarted?: (runId: string) => void;
}

/** Stable error code for logs and run rows; unexpected errors become "import_failed". */
export function importErrorCode(error: unknown): string {
  if (error instanceof SourceFetchError) return error.code;
  if (error instanceof ImportAlreadyRunningError) return error.code;
  if (error instanceof ImportCooldownError) return error.code;
  return "import_failed";
}

export interface ImportSummary {
  runId: string;
  sourceId: string;
  window: TimeWindow;
  counts: RunCounts;
  linkedPlaces: number;
  truncated: boolean;
}

export async function importEvents(input: ImportEventsInput): Promise<ImportSummary> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_IMPORT_DAYS) {
    throw new RangeError(`days must be an integer from 1 to ${MAX_IMPORT_DAYS}`);
  }
  const now = input.now ?? new Date();
  const { descriptor } = input.adapter;
  const window: TimeWindow = { start: new Date(now.getTime() - input.days * DAY_MS), end: now };

  await input.store.registerSource(descriptor);
  await input.store.failStaleRuns(descriptor.id, new Date(now.getTime() - STALE_RUN_MS));
  if (!input.force && input.cooldownSeconds > 0) {
    const lastStartedAt = await input.store.lastRunStartedAt(descriptor.id);
    const elapsedSeconds = lastStartedAt
      ? (now.getTime() - lastStartedAt.getTime()) / 1000
      : Number.POSITIVE_INFINITY;
    if (elapsedSeconds < input.cooldownSeconds) {
      throw new ImportCooldownError(Math.ceil(input.cooldownSeconds - elapsedSeconds));
    }
  }

  const runId = await input.store.startRun(descriptor.id, window, now);
  input.onRunStarted?.(runId);
  const counts: RunCounts = { fetched: 0, inserted: 0, updated: 0, skipped: 0 };
  try {
    // Fetch everything before writing, so an upstream failure leaves stored data untouched.
    const fetched = await fetchWindow(input.adapter, window, 0, input.signal);
    const events = dedupeByExternalId(fetched.events);
    counts.fetched = events.length;
    counts.skipped = fetched.skipped;
    const upserted = await input.store.upsertEvents(descriptor.id, events);
    counts.inserted = upserted.insertedIds.length;
    counts.updated = upserted.updatedIds.length;
    counts.skipped += upserted.unchanged;
    // Also retries events left unlinked by an earlier failure, which a re-import would otherwise skip as unchanged.
    const unlinked = await input.store.findUnlinkedRecordIds(descriptor.id, window);
    const toLink = new Set([...upserted.insertedIds, ...upserted.updatedIds, ...unlinked]);
    const linkedPlaces = await input.store.linkNearbyPlaces([...toLink]);
    await input.store.finishRun(runId, {
      status: "succeeded",
      counts,
      errorCode: fetched.truncated ? "window_truncated" : null,
      finishedAt: new Date(),
    });
    return { runId, sourceId: descriptor.id, window, counts, linkedPlaces, truncated: fetched.truncated };
  } catch (error) {
    const cancelled = input.signal?.aborted && !(error instanceof SourceFetchError);
    const errorCode = cancelled ? "import_cancelled" : importErrorCode(error);
    await input.store.finishRun(runId, { status: "failed", counts, errorCode, finishedAt: new Date() });
    throw error;
  }
}

/**
 * Runs an import in the background and resolves when its run row exists.
 * Errors raised before that point (cooldown, already running) reject the returned promise.
 */
export function startBackgroundImport(
  run: (onRunStarted: (runId: string) => void) => Promise<ImportSummary>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let started = false;
    run((runId) => {
      started = true;
      resolve(runId);
    }).then(
      (summary) => console.info("Event import finished", {
        runId: summary.runId,
        sourceId: summary.sourceId,
        counts: summary.counts,
        truncated: summary.truncated,
      }),
      (error: unknown) => {
        if (!started) return reject(error);
        // The failed run row already holds the error code; log only the code.
        console.warn("Event import failed", { code: importErrorCode(error) });
      },
    );
  });
}

/** Splits a window in half while the source reports a truncated page. */
async function fetchWindow(
  adapter: EventSourceAdapter,
  window: TimeWindow,
  depth: number,
  signal?: AbortSignal,
): Promise<EventFetchResult> {
  const result = await adapter.fetchEvents(window, signal);
  const spanMs = window.end.getTime() - window.start.getTime();
  if (!result.truncated || depth >= MAX_WINDOW_SPLIT_DEPTH || spanMs <= MIN_SPLIT_WINDOW_MS) return result;
  const middle = new Date(window.start.getTime() + Math.floor(spanMs / 2));
  const first = await fetchWindow(adapter, { start: window.start, end: middle }, depth + 1, signal);
  const second = await fetchWindow(adapter, { start: middle, end: window.end }, depth + 1, signal);
  return {
    events: [...first.events, ...second.events],
    skipped: first.skipped + second.skipped,
    truncated: first.truncated || second.truncated,
  };
}

function dedupeByExternalId(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...new Map(events.map((event) => [event.externalId, event])).values()];
}
