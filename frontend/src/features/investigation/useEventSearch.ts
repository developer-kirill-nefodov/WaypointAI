import type { AppliedEventFilters, InvestigationEvent, SourceView } from "@waypoint-ai/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorCode, eventQueryParams, searchEvents } from "../../shared/api/investigations";
import type { EventFilterState } from "./types";

const PAGE_SIZE = 50;

export type ReadySearch = {
  status: "ready";
  events: InvestigationEvent[];
  total: number;
  /** Smallest and largest magnitude over every match, not only the loaded pages. */
  magnitudeRange?: { min: number; max: number } | null;
  nextCursor: string | null;
  appliedFilters: AppliedEventFilters;
  sources: SourceView[];
  /** Parameters of the first page; "Show more" reuses them with the next cursor. */
  params: URLSearchParams;
};

export type SearchState =
  | { status: "loading" }
  | { status: "error"; code: string }
  | ReadySearch;

/** One result set in flight; responses for older tickets are dropped. */
export type SearchTicket = {
  generation: number;
  controller: AbortController;
};

/** Merges two lists by `id`; later items replace earlier ones and keep the first position. */
export function mergeById<T extends { id: string }>(first: T[], second: T[]): T[] {
  const byId = new Map([...first, ...second].map((item) => [item.id, item]));
  return [...byId.values()];
}

/**
 * Event search for the filter form, with paging and a generation guard: every new result set (filters or
 * refresh) gets a generation, and late responses from older ones are dropped.
 */
export function useEventSearch(filters: EventFilterState, reloadKey: number) {
  const [search, setSearch] = useState<SearchState>({ status: "loading" });
  // True while a new first page loads; the previous rows stay visible instead of flashing empty.
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // Duration of the last completed search or query, shown next to the result count.
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const generationRef = useRef(0);
  const pendingRef = useRef<AbortController | null>(null);

  const startGeneration = useCallback((): SearchTicket => {
    generationRef.current += 1;
    pendingRef.current?.abort();
    const controller = new AbortController();
    pendingRef.current = controller;
    return { generation: generationRef.current, controller };
  }, []);

  const isCurrent = useCallback((generation: number) => generation === generationRef.current, []);

  useEffect(() => () => pendingRef.current?.abort(), []);

  const showResults = useCallback((results: ReadySearch, durationMs: number) => {
    setSearch(results);
    setLastDurationMs(durationMs);
    setRefreshing(false);
    setLoadMoreError(null);
  }, []);

  useEffect(() => {
    const { generation, controller } = startGeneration();
    const params = eventQueryParams({ ...filters, limit: PAGE_SIZE });
    const startedAt = performance.now();
    setLoadMoreError(null);
    setLoadingMore(false);
    setRefreshing(true);
    searchEvents(params, controller.signal).then(
      (response) => {
        if (!isCurrent(generation)) return;
        showResults({ status: "ready", ...response, params }, performance.now() - startedAt);
      },
      (error: unknown) => {
        if (controller.signal.aborted || !isCurrent(generation)) return;
        setSearch({ status: "error", code: errorCode(error) });
        setRefreshing(false);
      },
    );
    return () => controller.abort();
  }, [filters, reloadKey, isCurrent, showResults, startGeneration]);

  const loadMore = useCallback(async () => {
    if (search.status !== "ready" || !search.nextCursor || loadingMore || refreshing) return;
    // Same window and filters as the first page; only the cursor changes.
    const params = new URLSearchParams(search.params);
    params.set("cursor", search.nextCursor);
    const generation = generationRef.current;
    const signal = pendingRef.current?.signal;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await searchEvents(params, signal);
      if (!isCurrent(generation)) return;
      setSearch((current) => current.status !== "ready" ? current : {
        ...current,
        events: mergeById(current.events, page.events),
        nextCursor: page.nextCursor,
        sources: mergeById(current.sources, page.sources),
      });
    } catch (error) {
      if (isCurrent(generation)) setLoadMoreError(errorCode(error));
    } finally {
      if (isCurrent(generation)) setLoadingMore(false);
    }
  }, [isCurrent, loadingMore, refreshing, search]);

  return {
    search,
    refreshing,
    loadingMore,
    loadMoreError,
    lastDurationMs,
    loadMore,
  };
}

export type EventSearch = ReturnType<typeof useEventSearch>;
