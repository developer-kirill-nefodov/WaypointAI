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
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

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
      if (response.ok) body = response.status === 204 ? "" : await response.text();
    } catch (error) {
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
