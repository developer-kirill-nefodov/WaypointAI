import type { RequestHandler } from "express";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

/** Above this many tracked clients, expired entries are swept before handling a request. */
const SWEEP_THRESHOLD_CLIENTS = 10_000;

/**
 * Fixed-window, per-client request limit kept in memory. Suitable for a single-process demo;
 * a shared store such as Redis is needed when the API runs on several instances.
 */
export function createRateLimit(options: RateLimitOptions & { now?: () => number }): RequestHandler {
  const now = options.now ?? Date.now;
  const clients = new Map<string, { count: number; resetAt: number }>();
  return (request, response, next) => {
    const time = now();
    if (clients.size > SWEEP_THRESHOLD_CLIENTS) {
      for (const [key, entry] of clients) {
        if (entry.resetAt <= time) clients.delete(key);
      }
    }
    const key = request.ip ?? "unknown";
    let entry = clients.get(key);
    if (!entry || entry.resetAt <= time) {
      entry = { count: 0, resetAt: time + options.windowMs };
      clients.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > options.max) {
      response.setHeader("Retry-After", String(Math.ceil((entry.resetAt - time) / 1000)));
      response.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}
