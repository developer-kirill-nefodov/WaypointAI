import type { EventDetailsResponse, InvestigationEvent, SourceView } from "@waypoint-ai/shared";
import { RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { makeT, type Language } from "../../shared/i18n";
import MapPanel, { type SearchRadius } from "../../widgets/map/MapPanel";
import ElapsedSeconds from "./ElapsedSeconds";
import { errorMessage, queryErrorMessage } from "./errors";
import EventDetails from "./EventDetails";
import EventFilters from "./EventFilters";
import EventModal from "./EventModal";
import { isEventSource } from "./format";
import InterpretationCard from "./InterpretationCard";
import QueryBar from "./QueryBar";
import ResultsList from "./ResultsList";
import ResultsSummary from "./ResultsSummary";
import SyncStatus, { FailedImportWarning } from "./SyncStatus";
import type { EventFilterState, MapFocus, MapFocusTarget } from "./types";
import { useEventDetails } from "./useEventDetails";
import { useEventSearch } from "./useEventSearch";
import { useInvestigationQuery } from "./useInvestigationQuery";
import { useSources } from "./useSources";

const INITIAL_FILTERS: EventFilterState = {
  days: 7,
  minMagnitude: null,
  sourceIds: [],
  near: null,
};
const NO_EVENTS: InvestigationEvent[] = [];
const NO_SOURCES: SourceView[] = [];

type InvestigationWorkspaceProps = {
  language: Language;
};

export default function InvestigationWorkspace({ language }: InvestigationWorkspaceProps) {
  const t = makeT(language);
  const [filters, setFilters] = useState<EventFilterState>(INITIAL_FILTERS);
  // Bumped by refresh, retry, and "Clear query": reloads sources and re-runs the filter search.
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  // A point the user asked to see on the map from the details dialog.
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);

  const sourcesState = useSources(reloadKey);
  const eventSearch = useEventSearch(filters, reloadKey);
  const { search, refreshing } = eventSearch;
  const { details, headingRef } = useEventDetails(selectedId);
  const selectedEvent = details.status === "ready" ? details.details.event : null;
  const selection = useMemo(() => selectedEvent
    ? { lat: selectedEvent.lat, lon: selectedEvent.lon, label: selectedEvent.label.slice(0, 200) }
    : null, [selectedEvent]);
  const query = useInvestigationQuery({ language, selection, search: eventSearch });
  const { queryInfo, queryError, resetQuery } = query;

  const openEvent = useCallback((id: string) => {
    setSelectedId(id);
    setMapFocus(null);
    setModalOpen(true);
  }, []);

  /** Refresh and retry: reload sources and re-run the filter search; a query result is replaced. */
  const refresh = useCallback(() => {
    resetQuery();
    setReloadKey((value) => value + 1);
  }, [resetQuery]);
  // "Clear query" returns to the filter form, which needs exactly a fresh filter search.
  const clearQuery = refresh;

  /** New filters start a new search; the dialog and any map focus belong to the previous results. */
  const applyFilters = (next: EventFilterState) => {
    resetQuery();
    setFilters(next);
    setModalOpen(false);
    setMapFocus(null);
  };
  const changeFilters = (next: EventFilterState) => {
    setSelectedId(null);
    applyFilters(next);
  };
  // The pivot keeps the event selected, so its linked places stay on the map around the new radius.
  const searchNearby = (event: EventDetailsResponse["event"], radiusKm: number) => applyFilters({
    ...filters,
    near: { lat: event.lat, lon: event.lon, radiusKm, label: event.label },
  });
  const showOnMap = (target: MapFocusTarget) => {
    setModalOpen(false);
    setMapFocus((current) => ({ ...target, revision: (current?.revision ?? 0) + 1 }));
  };
  const selectMapResult = useCallback((key: string) => {
    if (key.startsWith("record:")) openEvent(key.slice("record:".length));
  }, [openEvent]);
  const closeModal = useCallback(() => setModalOpen(false), []);

  const sources = sourcesState.status === "ready" ? sourcesState.sources : NO_SOURCES;
  const eventSources = useMemo(() => sources.filter(isEventSource), [sources]);
  const placeCoverage = useMemo(() => sources
    .filter((source) => source.mode === "public_snapshot")
    .map((source) => source.label), [sources]);
  const searchSources = search.status === "ready" ? search.sources : NO_SOURCES;
  const sourcesById = useMemo(
    () => new Map([...sources, ...searchSources].map((source) => [source.id, source])),
    [searchSources, sources],
  );
  const events = search.status === "ready" ? search.events : NO_EVENTS;
  const hasSynthetic = events.some((event) => sourcesById.get(event.sourceId)?.mode === "synthetic_local");
  // An event whose source metadata is missing is labelled unverified rather than shown as ordinary data.
  const hasUnverified = events.some((event) => !sourcesById.has(event.sourceId));

  const linkedPlaces = useMemo(
    () => details.status === "ready" ? details.details.linkedPlaces.map((link) => link.place) : [],
    [details],
  );
  const recordSourceModes = useMemo(() => Object.fromEntries(events.map((event) => [
    event.sourceId,
    sourcesById.get(event.sourceId)?.mode ?? "unverified" as const,
  ])), [events, sourcesById]);
  const sourceLabels = useMemo(
    () => Object.fromEntries([...sourcesById.values()].map((source) => [source.id, source.label])),
    [sourcesById],
  );
  const appliedNear = search.status === "ready" ? search.appliedFilters.near : undefined;
  const radiusLabel = queryInfo?.resolvedPlace?.name
    ?? filters.near?.label
    ?? (queryInfo ? t("выбранное событие", "selected event") : "");
  // The circle shows the radius the server actually applied, labelled with its center.
  const radius = useMemo<SearchRadius | null>(
    () => appliedNear ? { ...appliedNear, label: radiusLabel } : null,
    [appliedNear, radiusLabel],
  );
  // A place chosen from the dialog takes the map highlight from the selected event.
  const selectedResultKey = mapFocus?.kind === "place"
    ? `place:${mapFocus.id}`
    : selectedEvent ? `record:${selectedEvent.id}` : null;

  return (
    <div className="content-grid investigation-grid">
      <section className="chat-panel investigation-panel" aria-label={t("Обзор событий", "Event explorer")}>
        <div className="investigation-controls">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("ОБЗОР СОБЫТИЙ · ОТКРЫТЫЕ ДАННЫЕ", "EVENT EXPLORER · OPEN DATA")}</span>
              <h2>{t("Сейсмические события", "Seismic events")}</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t("Обновить", "Refresh")}
              title={t("Обновить", "Refresh")}
              onClick={refresh}
            >
              <RefreshCw size={15} />
            </button>
          </div>

          <SyncStatus language={language} sources={eventSources} state={sourcesState.status} />
          <FailedImportWarning language={language} sources={eventSources} />

          <QueryBar
            language={language}
            running={query.queryRunning}
            hasSelection={details.status === "ready"}
            onSubmit={(text) => void query.runQuery(text)}
          />
          {queryError && (
            <p className="investigation-state error" role="alert">
              {queryErrorMessage(queryError, language, placeCoverage)}
            </p>
          )}
          {queryInfo && <InterpretationCard language={language} info={queryInfo} onClear={clearQuery} />}

          {!queryInfo && (
            <EventFilters language={language} filters={filters} sources={eventSources} onChange={changeFilters} />
          )}

          <ResultsSummary
            language={language}
            search={search}
            refreshing={refreshing}
            lastDurationMs={eventSearch.lastDurationMs}
            hasSynthetic={hasSynthetic}
            hasUnverified={hasUnverified}
          />
        </div>

        <ResultsList
          language={language}
          search={search}
          events={events}
          sourcesById={sourcesById}
          selectedId={selectedId}
          refreshing={refreshing}
          loadingMore={eventSearch.loadingMore}
          loadMoreError={eventSearch.loadMoreError}
          onSelect={openEvent}
          onLoadMore={() => void eventSearch.loadMore()}
          onRetry={refresh}
        />
      </section>

      <MapPanel
        language={language}
        variant="investigation"
        records={events}
        recordSourceModes={recordSourceModes}
        highlights={linkedPlaces}
        radius={radius}
        focus={mapFocus}
        selectedResultKey={selectedResultKey}
        onSelectResult={selectMapResult}
        sourceLabels={sourceLabels}
        resultsLoaded={search.status === "ready"}
      />

      <EventModal language={language} open={modalOpen && selectedId !== null} onClose={closeModal}>
        {details.status === "loading" && (
          <p className="investigation-state" role="status">
            {t("Загружаем детали…", "Loading details…")} <ElapsedSeconds running language={language} />
          </p>
        )}
        {details.status === "error" && (
          <p className="investigation-state error" role="alert">{errorMessage(details.code, language)}</p>
        )}
        {details.status === "ready" && (
          <EventDetails
            language={language}
            headingRef={headingRef}
            details={details.details}
            onSearchNearby={(radiusKm) => searchNearby(details.details.event, radiusKm)}
            onShowOnMap={showOnMap}
          />
        )}
      </EventModal>
    </div>
  );
}
