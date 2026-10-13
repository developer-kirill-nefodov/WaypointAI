import type { InvestigationEvent, SourceView } from "@waypoint-ai/shared";
import { makeT, type Language } from "../../shared/i18n";
import ElapsedSeconds from "./ElapsedSeconds";
import { errorMessage } from "./errors";
import EventTable from "./EventTable";
import type { SearchState } from "./useEventSearch";

type ResultsListProps = {
  language: Language;
  search: SearchState;
  events: InvestigationEvent[];
  sourcesById: Map<string, SourceView>;
  selectedId: string | null;
  refreshing: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

/** The scrolling part of the panel: loading, error, and empty states, or the event table. */
export default function ResultsList({
  language,
  search,
  events,
  sourcesById,
  selectedId,
  refreshing,
  loadingMore,
  loadMoreError,
  onSelect,
  onLoadMore,
  onRetry,
}: ResultsListProps) {
  const t = makeT(language);
  const ready = search.status === "ready";
  const loadMoreButton = ready && search.nextCursor ? (
    <LoadMoreButton
      language={language}
      loading={loadingMore}
      disabled={loadingMore || refreshing}
      onClick={onLoadMore}
    />
  ) : null;

  return (
    // Only the result list scrolls; the query and filters above stay in place.
    <div className="investigation-results">
      {search.status === "loading" && (
        <p className="investigation-state" role="status">
          {t("Загружаем события…", "Loading events…")} <ElapsedSeconds running language={language} />
        </p>
      )}
      {search.status === "error" && (
        <div className="investigation-state error" role="alert">
          <span>{errorMessage(search.code, language)}</span>
          <button type="button" onClick={onRetry}>{t("Повторить", "Retry")}</button>
        </div>
      )}
      {ready && events.length === 0 && (
        <p className="investigation-empty">
          {t(
            "Нет событий для этих фильтров. Расширьте период или снимите фильтры. Если список пуст всегда, импортируйте данные: npm run data:import:events",
            "No events match these filters. Widen the period or clear filters. If the list is always empty, import data: npm run data:import:events",
          )}
        </p>
      )}
      {events.length > 0 && (
        <EventTable
          language={language}
          events={events}
          sourcesById={sourcesById}
          selectedId={selectedId}
          showDistance={ready && Boolean(search.appliedFilters.near)}
          onSelect={onSelect}
          footer={loadMoreButton}
        />
      )}
      {loadMoreError && (
        <p className="investigation-state error" role="alert">{errorMessage(loadMoreError, language)}</p>
      )}
    </div>
  );
}

type LoadMoreButtonProps = {
  language: Language;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
};

function LoadMoreButton({ language, loading, disabled, onClick }: LoadMoreButtonProps) {
  const t = makeT(language);
  return (
    <button type="button" className="investigation-more" disabled={disabled} onClick={onClick}>
      {loading
        ? <>{t("Загружаем…", "Loading…")} <ElapsedSeconds running language={language} /></>
        : t("Показать ещё", "Show more")}
    </button>
  );
}
