import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * A small stale-while-revalidate cache for read-only API responses shared across pages. A page that returns to a
 * key it has seen renders the cached value at once and refreshes it quietly in the background; only the very first
 * load of a key shows a loading state. Entries live for the session (memory only).
 */
type Entry = { value?: unknown; at: number; error?: unknown; promise?: Promise<unknown> };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const MAX_ENTRIES = 200;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads a key once at a time; concurrent callers share the request. */
function load<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const entry = entries.get(key) ?? { at: 0 };
  if (entry.promise) return entry.promise as Promise<T>;
  const promise = loader().then(
    (value) => {
      entries.set(key, { value, at: Date.now() });
      return value;
    },
    (error: unknown) => {
      // A failed refresh keeps the last good value.
      entries.set(key, { ...entries.get(key), at: entries.get(key)?.at ?? 0, error, promise: undefined });
      throw error;
    },
  ).finally(() => {
    const current = entries.get(key);
    if (current?.promise) entries.set(key, { ...current, promise: undefined });
    notify();
  });
  entries.set(key, { ...entry, promise, error: undefined });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  notify();
  return promise;
}

export interface CachedQuery<T> {
  data: T | undefined;
  error: unknown;
  /** True only while a key without any value loads. */
  loading: boolean;
  /** True while a cached value is being refreshed. */
  refreshing: boolean;
  /** Reloads the key, keeping the shown value until the new one arrives. */
  refresh(): void;
}

/** Reads `key` from the cache, loading it when missing or older than `staleMs`; a null key loads nothing. */
export function useCachedQuery<T>(key: string | null, loader: () => Promise<T>, staleMs = 60_000): CachedQuery<T> {
  useSyncExternalStore(subscribe, () => version);
  const entry = key ? entries.get(key) : undefined;
  useEffect(() => {
    if (!key) return;
    const current = entries.get(key);
    if (!current || (!current.promise && Date.now() - current.at > staleMs && !current.error)) load(key, loader).catch(() => undefined);
    // The loader is recreated on every render; the key names what it loads.
  }, [key, staleMs, entry?.at]);
  const refresh = useCallback(() => { if (key) load(key, loader).catch(() => undefined); }, [key, loader]);
  return {
    data: entry?.value as T | undefined,
    error: entry?.error,
    loading: Boolean(key) && entry?.value === undefined && !entry?.error,
    refreshing: Boolean(entry?.promise) && entry?.value !== undefined,
    refresh,
  };
}

/** Marks every key that starts with `prefix` as stale, so mounted readers refresh and later readers reload. */
export function invalidateCache(prefix: string): void {
  for (const [key, entry] of entries) if (key.startsWith(prefix)) entries.set(key, { ...entry, at: 0, error: undefined });
  notify();
}

/** The cached value of a key, if any (for code outside React). */
export function peekCache<T>(key: string): T | undefined {
  return entries.get(key)?.value as T | undefined;
}
