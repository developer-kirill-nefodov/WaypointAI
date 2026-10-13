import type { InvestigationQueryRequest } from "@waypoint-ai/shared";
import { useCallback, useState } from "react";
import {
  InvestigationApiError,
  paramsFromAppliedFilters,
  runInvestigationQuery,
} from "../../shared/api/investigations";
import type { Language } from "../../shared/i18n";
import type { QueryErrorState, QueryResultInfo } from "./types";
import type { EventSearch } from "./useEventSearch";

type QuerySearch = Pick<EventSearch, "startExternalSearch" | "showResults" | "isCurrent">;

type QueryOptions = {
  language: Language;
  /** The selected event, for queries such as "near this location". */
  selection: InvestigationQueryRequest["selection"];
  search: QuerySearch;
};

/**
 * Natural-language queries. A query starts a new search generation, so it cancels the filter
 * search in flight, and a filter change or refresh drops a late query response the same way.
 */
export function useInvestigationQuery({ language, selection, search }: QueryOptions) {
  const [queryRunning, setQueryRunning] = useState(false);
  const [queryInfo, setQueryInfo] = useState<QueryResultInfo | null>(null);
  const [queryError, setQueryError] = useState<QueryErrorState | null>(null);
  const { startExternalSearch, showResults, isCurrent } = search;

  const runQuery = useCallback(async (text: string) => {
    const { generation, controller } = startExternalSearch();
    const startedAt = performance.now();
    setQueryRunning(true);
    setQueryError(null);
    try {
      const response = await runInvestigationQuery({ text, language, selection }, controller.signal);
      if (!isCurrent(generation)) return;
      const durationMs = performance.now() - startedAt;
      // Rows come from the database search the server ran; the model only chose its filters.
      showResults({
        status: "ready",
        events: response.events,
        total: response.total,
        nextCursor: response.nextCursor,
        appliedFilters: response.appliedFilters,
        sources: response.sources,
        params: paramsFromAppliedFilters(response.appliedFilters),
      }, durationMs);
      setQueryInfo({
        text,
        interpretation: response.interpretation,
        resolvedPlace: response.resolvedPlace,
        appliedFilters: response.appliedFilters,
        durationMs,
      });
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(generation)) return;
      const apiError = error instanceof InvestigationApiError ? error : null;
      setQueryError({
        code: apiError?.code ?? "http_error",
        place: apiError?.interpretation?.arguments.place,
        fallbackReason: apiError?.fallbackReason ?? undefined,
      });
    } finally {
      if (isCurrent(generation)) setQueryRunning(false);
    }
  }, [isCurrent, language, selection, showResults, startExternalSearch]);

  /** Forgets the query result; the caller starts the filter search that replaces its rows. */
  const resetQuery = useCallback(() => {
    setQueryInfo(null);
    setQueryError(null);
    // A query superseded by a new search never reaches its own finally branch.
    setQueryRunning(false);
  }, []);

  return {
    queryRunning,
    queryInfo,
    queryError,
    runQuery,
    resetQuery,
  };
}
