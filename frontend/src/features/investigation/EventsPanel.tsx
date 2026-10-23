import type { EventDetailsResponse, InvestigationEvent, SourceView } from "@waypoint-ai/shared";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { makeT, type Language } from "../../shared/i18n";
import type { PulseRequest, SearchRadius } from "../../widgets/map/MapPanel";
import type { MapScene } from "../../widgets/map/map-scene";
import ElapsedSeconds from "./ElapsedSeconds";
import { errorMessage } from "./errors";
import EventDetails from "./EventDetails";
import EventFilters from "./EventFilters";
import EventModal from "./EventModal";
import { formatEventTime, isEventSource, pick } from "./format";
import ResultsList from "./ResultsList";
import ResultsSummary from "./ResultsSummary";
import DataStatus from "./SyncStatus";
import type { EventFilterState, MapFocus, MapFocusTarget } from "./types";
import { useEventDetails } from "./useEventDetails";
import { useEventSearch } from "./useEventSearch";
import { useSources } from "./useSources";

const INITIAL_FILTERS: EventFilterState = { days: 7, minMagnitude: null, sourceIds: [], near: null };
const NO_EVENTS: InvestigationEvent[] = [];
const NO_SOURCES: SourceView[] = [];

type EventsPanelProps = {
  language: Language;
  /** The map shows this scene while the panel is active. */
  onScene: (scene: MapScene) => void;
  /** The map page calls this when a marker is clicked while the panel is active. */
  selectRef: MutableRefObject<((key: string) => void) | null>;
  /** Hands an event to the assistant as the selected map point. */
  onAsk: (event: EventDetailsResponse["event"]) => void;
};

/**
 * The events mode of the map page: a period and magnitude filter, a short summary of the period, and the list.
 * Questions in plain words go to the assistant, which searches the same events and draws the radius on the map.
 */
export default function EventsPanel({ language, onScene, selectRef, onAsk }: EventsPanelProps) {
  const t = makeT(language);
  const [filters, setFilters] = useState<EventFilterState>(INITIAL_FILTERS);
  // Bumped by refresh and retry: reloads sources and re-runs the search.
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
  // Every pick in the list or on the map waves over the event, also when it is picked again.
  const [pulse, setPulse] = useState<PulseRequest | null>(null);

  const sourcesState = useSources(reloadKey);
  const eventSearch = useEventSearch(filters, reloadKey);
  const { search, refreshing } = eventSearch;
  const { details, headingRef } = useEventDetails(selectedId);
  const selectedEvent = details.status === "ready" ? details.details.event : null;

  const openEvent = useCallback((id: string) => {
    setPulse({ key: `record:${id}`, revision: performance.now() });
    setSelectedId(id);
    setMapFocus(null);
    setModalOpen(true);
  }, []);
  const refresh = useCallback(() => setReloadKey((value) => value + 1), []);
  // A finished import changes the events and the sources' update time.
  useEffect(() => {
    window.addEventListener("waypoint:import-finished", refresh);
    return () => window.removeEventListener("waypoint:import-finished", refresh);
  }, [refresh]);

  const applyFilters = (next: EventFilterState) => {
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
    setPulse({ key: `${target.kind}:${target.id}`, revision: performance.now() });
  };
  useEffect(() => {
    selectRef.current = (key: string) => { if (key.startsWith("record:")) openEvent(key.slice("record:".length)); };
    return () => { selectRef.current = null; };
  }, [openEvent, selectRef]);
  const closeModal = useCallback(() => setModalOpen(false), []);

  const sources = sourcesState.status === "ready" ? sourcesState.sources : NO_SOURCES;
  const eventSources = useMemo(() => sources.filter(isEventSource), [sources]);
  const searchSources = search.status === "ready" ? search.sources : NO_SOURCES;
  const sourcesById = useMemo(() => new Map([...sources, ...searchSources].map((source) => [source.id, source])), [searchSources, sources]);
  const events = search.status === "ready" ? search.events : NO_EVENTS;
  const hasSynthetic = events.some((event) => sourcesById.get(event.sourceId)?.mode === "synthetic_local");
  const hasUnverified = events.some((event) => !sourcesById.has(event.sourceId));

  const linkedPlaces = useMemo(() => details.status === "ready" ? details.details.linkedPlaces.map((link) => link.place) : [], [details]);
  const recordSourceModes = useMemo(() => Object.fromEntries(events.map((event) => [
    event.sourceId,
    sourcesById.get(event.sourceId)?.mode ?? "unverified" as const,
  ])), [events, sourcesById]);
  const sourceLabels = useMemo(() => Object.fromEntries([...sourcesById.values()].map((source) => [source.id, source.label])), [sourcesById]);
  const appliedNear = search.status === "ready" ? search.appliedFilters.near : undefined;
  const radiusLabel = filters.near?.label ?? "";
  const radius = useMemo<SearchRadius | null>(() => appliedNear ? { ...appliedNear, label: radiusLabel } : null, [appliedNear, radiusLabel]);
  const selectedKey = mapFocus?.kind === "place" ? `place:${mapFocus.id}` : selectedEvent ? `record:${selectedEvent.id}` : null;

  useEffect(() => {
    onScene({ records: events, recordSourceModes, highlights: linkedPlaces, radius, focus: mapFocus, selectedKey, sourceLabels, resultsLoaded: search.status === "ready", pulse });
  }, [events, recordSourceModes, linkedPlaces, radius, mapFocus, selectedKey, sourceLabels, search.status, pulse, onScene]);

  return (
    <div className="events-panel">
      <div className="investigation-controls">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{t("СОБЫТИЯ · ОТКРЫТЫЕ ДАННЫЕ", "EVENTS · OPEN DATA")}</span>
            <h2>{t("Сейсмические события", "Seismic events")}</h2>
          </div>
          <button type="button" className="icon-button" aria-label={t("Обновить", "Refresh")} title={t("Обновить", "Refresh")} onClick={refresh}>
            <RefreshCw size={15} />
          </button>
        </div>
        <DataStatus language={language} sources={eventSources} state={sourcesState.status} />
        <EventFilters language={language} filters={filters} sources={eventSources} onChange={changeFilters} />
        {search.status === "ready" && <PeriodSummary language={language} days={filters.days} total={search.total} range={search.magnitudeRange ?? null} latest={events[0] ?? null} />}
        <ResultsSummary language={language} search={search} refreshing={refreshing} lastDurationMs={eventSearch.lastDurationMs} hasSynthetic={hasSynthetic} hasUnverified={hasUnverified} />
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

      <EventModal language={language} open={modalOpen && selectedId !== null} onClose={closeModal}>
        {details.status === "loading" && (
          <p className="investigation-state" role="status">{t("Загружаем детали…", "Loading details…")} <ElapsedSeconds running language={language} /></p>
        )}
        {details.status === "error" && <p className="investigation-state error" role="alert">{errorMessage(details.code, language)}</p>}
        {details.status === "ready" && (
          <EventDetails
            language={language}
            headingRef={headingRef}
            details={details.details}
            onSearchNearby={(radiusKm) => searchNearby(details.details.event, radiusKm)}
            onShowOnMap={showOnMap}
            onAsk={() => { setModalOpen(false); onAsk(details.details.event); }}
          />
        )}
      </EventModal>
    </div>
  );
}

/** What the period looked like at a glance: how many events, the strongest magnitude, and the latest one. */
function PeriodSummary({ language, days, total, range, latest }: { language: Language; days: number; total: number; range: { min: number; max: number } | null; latest: InvestigationEvent | null }) {
  const t = makeT(language);
  const period = days === 1 ? t("за 24 часа", "in 24 hours") : pick(language, { ru: `за ${days} дн.`, en: `in ${days} days`, de: `in ${days} Tagen` });
  return (
    <dl className="events-summary" aria-label={t("Сводка за период", "Period summary")}>
      <div><dt>{t("Событий", "Events")} {period}</dt><dd>{total.toLocaleString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US")}</dd></div>
      <div><dt>{t("Сильнейшее", "Strongest")}</dt><dd>{range ? `M${range.max.toFixed(1)}` : "—"}</dd></div>
      <div><dt>{t("Последнее", "Latest")}</dt><dd title={latest?.label}>{latest ? formatEventTime(latest.observedAt, language) : "—"}</dd></div>
    </dl>
  );
}
