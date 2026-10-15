import { randomUUID } from "node:crypto";
import type { ImportJob, ImportJobParams, ImportJobSource } from "@waypoint-ai/shared";
import { importErrorCode, ImportCooldownError } from "./event-import.js";

export type { ImportJob, ImportJobParams, ImportJobSource };

/** Persistence of jobs; SQL in data/import-job.repository.ts, in memory in tests. */
export interface ImportJobStore {
  save(job: ImportJob): Promise<void>;
  get(id: string, workspaceId: string): Promise<ImportJob | null>;
  list(workspaceId: string, options: { active: boolean; limit: number }): Promise<ImportJob[]>;
  /** Removes the workspace's finished jobs from the history (not the imported data); returns how many. */
  clearFinished(workspaceId: string): Promise<number>;
  /** Jobs left running by a stopped server are marked failed at startup. */
  failInterrupted(): Promise<number>;
}

/** Progress of one source while it runs. */
export interface SourceProgress {
  phase: NonNullable<ImportJobSource["phase"]>;
  /** 0..1 for this source. */
  fraction: number;
  fetched: number;
  stepsDone: number;
  stepsTotal: number;
  windowStart?: Date;
}

export interface SourceOutcome {
  /** The sync run that recorded the import; null for a deletion, which the job itself records. */
  runId: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  linkedPlaces: number;
  /** A non-fatal note such as "window_truncated". */
  warning: string | null;
}

/** What a kind of job imports: its sources, and how one of them runs. */
export interface ImportKind<P extends ImportJobParams = ImportJobParams> {
  sources(params: P): Array<{ sourceId: string; label: string }>;
  run(params: P, sourceId: string, context: { signal: AbortSignal; onProgress(progress: SourceProgress): void }): Promise<SourceOutcome>;
  /** At most one job of this kind runs at a time across workspaces (for example to respect a public API's usage policy). */
  exclusive?: boolean;
}

export interface ImportJobRunnerDependencies {
  store: ImportJobStore;
  kinds: { [K in ImportJobParams["kind"]]: ImportKind<Extract<ImportJobParams, { kind: K }>> };
  /** Every progress change, for the WebSocket; saving to the store is throttled separately. */
  publish(job: ImportJob): void;
  now?: () => Date;
}

const SAVE_INTERVAL_MS = 1_000;
const PUBLISH_INTERVAL_MS = 200;
export const MAX_ACTIVE_JOBS_PER_WORKSPACE = 3;

export class TooManyImportJobsError extends Error {
  readonly code = "too_many_import_jobs";
}

export class ImportKindBusyError extends Error {
  readonly code = "import_kind_busy";
}

/** A dataset that a running job imports into or deletes cannot be the target of another job. */
export class DatasetBusyError extends Error {
  readonly code = "dataset_busy";
}

/**
 * Runs import jobs in the API process: sources of a job one after another, progress published as it changes and
 * saved about once a second, cancellation between fetch steps. The store keeps jobs across page reloads.
 */
export class ImportJobRunner {
  readonly #controllers = new Map<string, AbortController>();
  readonly #runningKinds = new Map<string, number>();
  /** Source IDs of each running job. */
  readonly #runningSources = new Map<string, string[]>();
  constructor(private readonly deps: ImportJobRunnerDependencies) {}

  async start(workspaceId: string, params: ImportJobParams): Promise<ImportJob> {
    const kind = this.#kind(params);
    if (kind.exclusive && (this.#runningKinds.get(params.kind) ?? 0) > 0) throw new ImportKindBusyError("import_kind_busy");
    const active = await this.deps.store.list(workspaceId, { active: true, limit: MAX_ACTIVE_JOBS_PER_WORKSPACE + 1 });
    if (active.length >= MAX_ACTIVE_JOBS_PER_WORKSPACE) throw new TooManyImportJobsError("too_many_import_jobs");
    const sources = kind.sources(params);
    if (sources.some(({ sourceId }) => this.isSourceBusy(sourceId))) throw new DatasetBusyError("dataset_busy");
    const now = this.#now().toISOString();
    const job: ImportJob = {
      id: randomUUID(),
      workspaceId,
      status: "running",
      params,
      progress: 0,
      sources: sources.map(({ sourceId, label }) => ({
        sourceId,
        label,
        status: "pending",
        progress: 0,
        phase: null,
        windowStart: null,
        stepsDone: 0,
        stepsTotal: 0,
        fetched: 0,
        inserted: 0,
        updated: 0,
        linkedPlaces: 0,
        runId: null,
        errorCode: null,
        retryAfterSeconds: null,
      })),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await this.deps.store.save(job);
    const controller = new AbortController();
    this.#controllers.set(job.id, controller);
    this.#runningKinds.set(params.kind, (this.#runningKinds.get(params.kind) ?? 0) + 1);
    this.#runningSources.set(job.id, sources.map(({ sourceId }) => sourceId));
    void this.#run(job, kind, controller.signal).finally(() => {
      this.#controllers.delete(job.id);
      this.#runningSources.delete(job.id);
      this.#runningKinds.set(params.kind, (this.#runningKinds.get(params.kind) ?? 1) - 1);
    });
    return job;
  }

  /** Whether a job running in this process imports into or deletes this source. */
  isSourceBusy(sourceId: string): boolean {
    for (const ids of this.#runningSources.values()) if (ids.includes(sourceId)) return true;
    return false;
  }

  /** Returns false when the job is not running in this process (finished, or from an earlier process). */
  cancel(jobId: string): boolean {
    const controller = this.#controllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  #kind(params: ImportJobParams): ImportKind {
    return this.deps.kinds[params.kind] as ImportKind;
  }

  async #run(job: ImportJob, kind: ImportKind, signal: AbortSignal): Promise<void> {
    let lastSaved = 0;
    let lastPublished = 0;
    const update = async (force = false) => {
      job.progress = job.sources.reduce((sum, source) => sum + source.progress, 0) / job.sources.length;
      job.updatedAt = this.#now().toISOString();
      const now = Date.now();
      if (force || now - lastPublished >= PUBLISH_INTERVAL_MS) {
        lastPublished = now;
        this.deps.publish(structuredClone(job));
      }
      if (force || now - lastSaved >= SAVE_INTERVAL_MS) {
        lastSaved = now;
        await this.deps.store.save(job).catch((error: unknown) => console.warn("Import job progress was not saved", { jobId: job.id, error: error instanceof Error ? error.message : error }));
      }
    };
    await update(true);
    for (const source of job.sources) {
      if (signal.aborted) {
        source.status = "cancelled";
        continue;
      }
      source.status = "running";
      await update(true);
      try {
        const outcome = await kind.run(job.params, source.sourceId, {
          signal,
          onProgress: (progress) => {
            const phaseChanged = progress.phase !== source.phase;
            source.progress = progress.fraction;
            source.phase = progress.phase;
            source.fetched = progress.fetched;
            source.stepsDone = progress.stepsDone;
            source.stepsTotal = progress.stepsTotal;
            source.windowStart = progress.windowStart?.toISOString() ?? source.windowStart;
            void update(phaseChanged);
          },
        });
        Object.assign(source, {
          status: "succeeded",
          progress: 1,
          phase: "done",
          runId: outcome.runId,
          fetched: outcome.fetched,
          inserted: outcome.inserted,
          updated: outcome.updated,
          linkedPlaces: outcome.linkedPlaces,
          errorCode: outcome.warning,
        } satisfies Partial<ImportJobSource>);
      } catch (error) {
        source.status = signal.aborted ? "cancelled" : "failed";
        source.errorCode = signal.aborted ? "import_cancelled" : importErrorCode(error);
        source.retryAfterSeconds = error instanceof ImportCooldownError ? error.retryAfterSeconds : null;
      }
      await update(true);
    }
    const statuses = job.sources.map((source) => source.status);
    job.status = signal.aborted ? "cancelled"
      : statuses.every((status) => status === "succeeded") ? "succeeded"
        : statuses.some((status) => status === "succeeded") ? "partial" : "failed";
    job.finishedAt = this.#now().toISOString();
    await update(true);
    console.info("Import job finished", { jobId: job.id, kind: job.params.kind, status: job.status, sources: job.sources.map(({ sourceId, status, inserted, errorCode }) => ({ sourceId, status, inserted, errorCode })) });
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
