/**
 * One local inference at a time across the chat and the investigation query endpoint.
 * The local model runs a single generation; parallel calls would only queue inside Ollama and time out.
 * Background work (follow-up suggestions after an answer) may hold the model too, but gives way to a chat turn.
 */
let busy = false;
let background: AbortController | null = null;
const waiting: Array<() => void> = [];

export function tryAcquireInference(): boolean {
  if (busy) return false;
  busy = true;
  return true;
}

export function releaseInference(): void {
  busy = false;
  background = null;
  for (const resume of waiting.splice(0)) resume();
}

/** Takes the model for background work, which is stopped when a chat turn needs the model. */
export function tryAcquireBackgroundInference(controller: AbortController): boolean {
  if (!tryAcquireInference()) return false;
  background = controller;
  return true;
}

/** For a chat turn: takes the model, stopping background work that holds it and waiting briefly until it lets go. */
export async function acquireInference(waitMs = 3_000): Promise<boolean> {
  if (tryAcquireInference()) return true;
  if (!background) return false;
  background.abort();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    waiting.push(() => { clearTimeout(timer); resolve(); });
  });
  return tryAcquireInference();
}
