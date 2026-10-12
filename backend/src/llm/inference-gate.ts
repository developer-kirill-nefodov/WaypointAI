/**
 * One local inference at a time across the chat and the investigation query endpoint.
 * The local model runs a single generation; parallel calls would only queue inside Ollama and time out.
 */
let busy = false;

export function tryAcquireInference(): boolean {
  if (busy) return false;
  busy = true;
  return true;
}

export function releaseInference(): void {
  busy = false;
}
