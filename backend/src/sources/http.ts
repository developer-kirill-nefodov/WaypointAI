import { SourceFetchError } from "./source-adapter.js";

export interface FetchWithRetryOptions {
  timeoutMs: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  userAgent: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  /** Larger bodies are rejected as malformed instead of being buffered; defaults to 20 MB. */
  maxBodyBytes?: number;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_BODY_BYTES = 20 * 1024 * 1024;

class BodyTooLargeError extends Error {}

export interface FetchedBody {
  status: number;
  body: string;
}

/**
 * GET with a per-attempt timeout and bounded retries for transient failures.
 * The body is read inside the attempt, so a timeout while downloading is retried like any other.
 * Retries use exponential backoff with full jitter and respect Retry-After up to maxDelayMs.
 * Redirects are refused: the host allowlist applies to the URL that is actually fetched.
 */
export async function fetchWithRetry(url: URL, options: FetchWithRetryOptions): Promise<FetchedBody> {
  const retries = options.retries ?? 2;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  let lastError = new SourceFetchError("upstream_unavailable", true);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason;
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    let body = "";
    try {
      response = await fetchImpl(url, {
        signal,
        redirect: "error",
        headers: { accept: "application/json", "user-agent": options.userAgent },
      });
      if (response.ok) body = response.status === 204 ? "" : await readLimitedText(response, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) throw new SourceFetchError("upstream_malformed", false);
      if (options.signal?.aborted) throw error;
      lastError = timeout.aborted
        ? new SourceFetchError("upstream_timeout", true)
        : new SourceFetchError("upstream_unavailable", true);
      if (attempt < retries) await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs, random));
      continue;
    }

    if (response.ok) return { status: response.status, body };
    await response.body?.cancel();
    if (!RETRYABLE_STATUSES.has(response.status)) throw new SourceFetchError("upstream_bad_request", false);
    lastError = new SourceFetchError("upstream_unavailable", true);
    if (attempt < retries) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      await sleep(Math.min(maxDelayMs, retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs, random)));
    }
  }
  throw lastError;
}

/** Reads the body as UTF-8 text and stops as soon as it exceeds the limit. */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new BodyTooLargeError();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  return Math.round(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
}

/** Accepts delta-seconds or an HTTP date; returns milliseconds or null. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
