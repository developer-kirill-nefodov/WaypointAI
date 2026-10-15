import type { SourceOutcome, SourceProgress } from "./import-jobs.js";

/** Datasets imported from the app; the built-in regional extracts and the event sources are never deleted. */
const DELETABLE_DATASET = /^osm-(area|region)-[a-z0-9-]{1,100}$/;

export function isDeletableDataset(datasetId: string): boolean {
  return DELETABLE_DATASET.test(datasetId);
}

export interface DatasetDeleteStore {
  countPlaces(datasetId: string): Promise<number>;
  /**
   * Deletes the dataset's places in batches inside one transaction and hides the dataset; `onBatch` runs after
   * each batch with the running total, and an error thrown from it rolls the whole deletion back.
   */
  deleteDataset(datasetId: string, onBatch: (deleted: number) => void): Promise<number>;
}

export class DatasetNotDeletableError extends Error {
  readonly code = "dataset_not_deletable";
}

/** Deletes an imported dataset as a job: progress per batch, and cancelling rolls back so nothing is half deleted. */
export async function deleteDataset(input: {
  datasetId: string;
  store: DatasetDeleteStore;
  signal: AbortSignal;
  onProgress(progress: SourceProgress): void;
}): Promise<SourceOutcome> {
  if (!isDeletableDataset(input.datasetId)) throw new DatasetNotDeletableError("dataset_not_deletable");
  const total = await input.store.countPlaces(input.datasetId);
  input.onProgress({ phase: "saving", fraction: 0, fetched: 0, stepsDone: 0, stepsTotal: total });
  const deleted = await input.store.deleteDataset(input.datasetId, (done) => {
    if (input.signal.aborted) throw new Error("import_cancelled");
    // The last few percent are the commit, which is reported when the store returns.
    input.onProgress({ phase: "saving", fraction: total ? Math.min(0.95, (done / total) * 0.95) : 0.95, fetched: done, stepsDone: done, stepsTotal: total });
  });
  console.info("Dataset deleted", { datasetId: input.datasetId, places: deleted });
  return { runId: null, fetched: deleted, inserted: 0, updated: 0, linkedPlaces: 0, warning: null };
}
