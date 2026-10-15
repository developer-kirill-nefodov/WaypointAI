import type { ImportJob } from "@waypoint-ai/shared";

type Listener = (job: ImportJob) => void;
const listeners = new Set<Listener>();

/** Progress of import jobs in this process, for the WebSocket connections that show the import dock. */
export const importJobEvents = {
  publish(job: ImportJob): void {
    for (const listener of listeners) listener(job);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
