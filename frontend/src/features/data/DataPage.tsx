import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowRight, Globe2, History, Layers3, ListTree, Loader2, MapPinned, Plus, RefreshCw, Scan, Search, Trash2, X } from "lucide-react";
import { CircleMarker, MapContainer, Rectangle, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { latLngBounds } from "leaflet";
import type { ImportJob } from "@waypoint-ai/shared";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { invalidateCache, useCachedQuery } from "../../shared/data-cache";
import { navigateTo, rememberPageSearch } from "../../shared/routing";

/** Opens the map page in its events mode. */
function openEventsMap() {
  rememberPageSearch("workspace", "?mode=events");
  navigateTo("workspace");
}
import {
  clearImportHistory, ImportRequestError, listCatalogCategories, listCountries, listDatasetEvents, listDatasets, listImports, startImport,
  type CountryCoverage, type Dataset, type DatasetEvent,
} from "../imports/import-api";
import { importStore, useImportState } from "../imports/import-store";
import { bypassCatalogServerCache, CatalogFilterBar, CatalogRows, CatalogStatus, catalogFresh, categoryName, compact, count, countryName, PlaceCard, useCatalog, useScopeCountries, type Filters } from "./catalog";

type Tab = "records" | "overview" | "history";
const TABS: Tab[] = ["records", "overview", "history"];
const ALL = "all";
const TILE_URL = import.meta.env.VITE_MAP_TILES_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const FILTER_KEYS = ["country", "city", "category", "q"] as const;


/** What the address says: the dataset, the tab, and the records filters (`/data?dataset=…&tab=…&city=…`). */
function readAddress(): { dataset: string; tab: Tab; filters: Filters } {
  const params = new URLSearchParams(window.location.pathname === "/data" ? window.location.search : "");
  rememberPageSearch("data", params.size ? `?${params}` : "");
  const tab = params.get("tab") as Tab | null;
  const filters: Filters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return { dataset: params.get("dataset") || ALL, tab: tab && TABS.includes(tab) ? tab : "records", filters };
}

function writeAddress(dataset: string, tab: Tab, filters: Filters, push: boolean) {
  const params = new URLSearchParams();
  if (dataset !== ALL) params.set("dataset", dataset);
  if (tab !== "records") params.set("tab", tab);
  for (const key of FILTER_KEYS) if (filters[key]) params.set(key, filters[key]!);
  const search = params.size ? `?${params}` : "";
  rememberPageSearch("data", search);
  if (window.location.pathname !== "/data" || window.location.search === search) return;
  if (push) window.history.pushState({ page: "data" }, "", `/data${search}`);
  else window.history.replaceState({ page: "data" }, "", `/data${search}`);
}

/**
 * The data explorer: the datasets on the left; on the right the selected one's records with filters (country, city,
 * category, search, map area), a map beside the list, and a card for the chosen record, plus an overview and the
 * import history. Data comes from a shared cache, so returning to the page shows it at once.
 */
export default function DataPage({ language }: { language: Language }) {
  const t = makeT(language);
  const [initial] = useState(readAddress);
  const [dataset, setDataset] = useState(initial.dataset);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [filtersBy, setFiltersBy] = useState<Record<string, Filters>>({ [initial.dataset]: initial.filters });
  const filters = filtersBy[dataset] ?? {};
  // Choosing a dataset or tab is a step back/forward can return to; typing in a filter only replaces the address.
  const pushNext = useRef(false);
  useEffect(() => {
    writeAddress(dataset, tab, filters, pushNext.current);
    pushNext.current = false;
  }, [dataset, tab, filters]);
  useEffect(() => {
    const onPop = () => {
      if (window.location.pathname !== "/data") return;
      const next = readAddress();
      setDataset(next.dataset);
      setTab(next.tab);
      setFiltersBy((current) => ({ ...current, [next.dataset]: { ...next.filters, bbox: current[next.dataset]?.bbox ?? null } }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const selectDataset = (id: string) => { pushNext.current = true; setDataset(id); };
  const selectTab = (id: Tab) => { pushNext.current = true; setTab(id); };
  const setFilters = useCallback((change: Partial<Filters>) => setFiltersBy((current) => ({ ...current, [dataset]: { ...current[dataset], ...change } })), [dataset]);
  /** Opens the records tab with these filters (from the overview). */
  const openRecords = (change: Partial<Filters>) => {
    pushNext.current = true;
    setFiltersBy((current) => ({ ...current, [dataset]: { country: current[dataset]?.country, ...change, bbox: null } }));
    setTab("records");
  };

  const datasets = useCachedQuery("data:datasets", () => listDatasets(catalogFresh()));
  const countries = useCachedQuery("data:countries", () => listCountries(catalogFresh()));
  const history = useCachedQuery("data:history", () => listImports(false, undefined, 50), 15_000);
  const markStale = () => {
    bypassCatalogServerCache();
    invalidateCache("data:");
  };
  useEffect(() => {
    window.addEventListener("waypoint:import-finished", markStale);
    return () => window.removeEventListener("waypoint:import-finished", markStale);
  }, []);
  useEffect(() => { if (history.data) importStore.setImportEnabled(history.data.importEnabled); }, [history.data]);

  // A cancelled first import leaves an empty dataset row; it is not listed.
  const list = useMemo(() => datasets.data?.filter((item) => item.places > 0 || item.events > 0) ?? null, [datasets.data]);
  const selected = list?.find((item) => item.id === dataset) ?? null;
  // A deleted or unknown dataset falls back to all data.
  useEffect(() => { if (list && dataset !== ALL && !selected) setDataset(ALL); }, [list, selected, dataset]);
  const totals = useMemo(() => ({
    datasets: list?.length ?? 0,
    places: list?.reduce((sum, item) => sum + item.places, 0) ?? 0,
    events: list?.reduce((sum, item) => sum + item.events, 0) ?? 0,
    countries: countries.data?.length ?? 0,
    cities: countries.data?.reduce((sum, country) => sum + country.cities + country.towns, 0) ?? 0,
  }), [list, countries.data]);
  const refreshing = datasets.refreshing || countries.refreshing || history.refreshing;
  const tabs: Array<[Tab, string, ReactNode]> = [
    ["records", t("Записи", "Records"), <ListTree key="i" size={13} />],
    ["overview", t("Обзор", "Overview"), <Layers3 key="i" size={13} />],
    ["history", t("История", "History"), <History key="i" size={13} />],
  ];

  return <div className="data-page" aria-label={t("Импортированные данные", "Imported data")}>
    <header className="data-header">
      <div className="data-title">
        <span className="eyebrow">{t("ИМПОРТИРОВАННЫЕ ДАННЫЕ", "IMPORTED DATA")}</span>
        <h2>{t("Данные и охват", "Data and coverage")}</h2>
      </div>
      <dl className="data-summary">
        {([
          [t("наборов", "datasets"), totals.datasets],
          [t("мест", "places"), totals.places],
          [t("событий", "events"), totals.events],
          [t("стран", "countries"), totals.countries],
          [t("городов и посёлков", "cities and towns"), totals.cities],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{list ? count(value, language) : "—"}</dd></div>)}
      </dl>
      <div className="data-header-actions">
        <button type="button" className="data-icon-button" onClick={markStale} aria-label={t("Обновить", "Refresh")} title={t("Обновить", "Refresh")}>{refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}</button>
        <button type="button" className="data-primary" onClick={() => importStore.openDialog(undefined, "area")}><Plus size={14} />{t("Импорт данных", "Import data")}</button>
      </div>
    </header>

    {(datasets.error !== undefined && !list) && <p className="data-note error" role="alert">{t("Не удалось загрузить данные. Проверьте, что API и PostgreSQL запущены.", "Could not load the data. Check that the API and PostgreSQL are running.")}</p>}

    <div className="data-layout">
      <DatasetList language={language} datasets={list} selectedId={dataset} totalPlaces={totals.places} onSelect={selectDataset} />
      <section className="data-detail" aria-label={t("Подробности набора", "Dataset details")}>
        <DetailHeader language={language} dataset={selected} totals={totals} loading={!list} />
        <div className="data-tabs" role="tablist">
          {tabs.map(([id, label, icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => selectTab(id)}>{icon}{label}</button>)}
        </div>
        <div className="data-tab-body" role="tabpanel">
          {!list ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p> : <>
            {tab === "records" && (selected?.kind === "events"
              ? <EventExplorer key={selected.id} language={language} dataset={selected} />
              : <PlaceExplorer key={dataset} language={language} dataset={selected} filters={filters} onFilters={setFilters} />)}
            {tab === "overview" && (selected
              ? selected.kind === "places" ? <PlacesOverview key={selected.id} language={language} dataset={selected} onOpen={openRecords} /> : <EventsOverview language={language} dataset={selected} />
              : <AllOverview language={language} countries={countries.data ?? null} datasets={list} onCountry={(country) => openRecords({ country, city: undefined, category: undefined })} onDataset={selectDataset} />)}
            {tab === "history" && <HistoryList language={language} jobs={history.data?.jobs ?? null} datasetId={selected?.id ?? null} onCleared={history.refresh} />}
          </>}
        </div>
      </section>
    </div>
  </div>;
}

function DatasetList({ language, datasets, selectedId, totalPlaces, onSelect }: { language: Language; datasets: Dataset[] | null; selectedId: string; totalPlaces: number; onSelect(id: string): void }) {
  const t = makeT(language);
  const [kind, setKind] = useState<"all" | "places" | "events">("all");
  const [query, setQuery] = useState("");
  const jobs = useImportState((value) => value.jobs);
  const working = new Set(jobs.filter((job) => job.status === "running").flatMap((job) => job.sources.map((source) => source.sourceId)));
  const needle = query.trim().toLowerCase();
  const items = datasets?.filter((dataset) => (kind === "all" || dataset.kind === kind) && (!needle || `${dataset.label} ${dataset.id} ${dataset.countries.join(" ")}`.toLowerCase().includes(needle))) ?? null;
  const groups: Array<[string, Dataset[]]> = items ? [
    [t("Импортированы из приложения", "Imported from the app"), items.filter((dataset) => dataset.deletable)],
    [t("Встроенные регионы", "Built-in regions"), items.filter((dataset) => !dataset.deletable && dataset.kind === "places")],
    [t("События", "Events"), items.filter((dataset) => dataset.kind === "events")],
  ] : [];
  return <aside className="data-sidebar" aria-label={t("Наборы данных", "Datasets")}>
    <div className="data-sidebar-tools">
      <div className="data-segments" role="radiogroup" aria-label={t("Тип", "Type")}>
        {([["all", t("Все", "All")], ["places", t("Места", "Places")], ["events", t("События", "Events")]] as const).map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={kind === id} className={kind === id ? "active" : ""} onClick={() => setKind(id)}>{label}</button>)}
      </div>
      <label className="data-search"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Поиск набора", "Find a dataset")} aria-label={t("Поиск набора", "Find a dataset")} /></label>
    </div>
    <nav className="data-dataset-nav">
      <button type="button" className={`data-nav-item all${selectedId === ALL ? " active" : ""}`} aria-current={selectedId === ALL} onClick={() => onSelect(ALL)}>
        <span className="data-dataset-icon"><Globe2 size={13} /></span>
        <span className="data-nav-name"><strong>{t("Все данные", "All data")}</strong></span>
        <span className="data-nav-count">{datasets ? compact(totalPlaces, language) : "—"}</span>
      </button>
      {!items && <p className="data-empty">{t("Загружаю…", "Loading…")}</p>}
      {items && !items.length && <p className="data-empty">{t("Ничего не нашлось.", "Nothing found.")}</p>}
      {groups.map(([title, group]) => group.length > 0 && <div key={title} className="data-nav-group">
        <h3>{title}<span>{group.length}</span></h3>
        {group.map((dataset) => <button key={dataset.id} type="button" className={`data-nav-item${dataset.id === selectedId ? " active" : ""}`} aria-current={dataset.id === selectedId} onClick={() => onSelect(dataset.id)} title={dataset.label}>
          <span className={`data-dataset-icon ${dataset.kind}`}>{dataset.kind === "places" ? <MapPinned size={13} /> : <Activity size={13} />}</span>
          <span className="data-nav-name"><strong>{datasetName(dataset.label)}</strong>{dataset.countries.length > 0 && <small>{dataset.countries.slice(0, 4).join(" · ")}{dataset.countries.length > 4 ? ` +${dataset.countries.length - 4}` : ""}</small>}</span>
          {working.has(dataset.id) ? <Loader2 size={13} className="spin data-nav-busy" /> : <span className="data-nav-count">{compact(dataset.kind === "places" ? dataset.places : dataset.events, language)}</span>}
        </button>)}
      </div>)}
    </nav>
  </aside>;
}

function DetailHeader({ language, dataset, totals, loading }: { language: Language; dataset: Dataset | null; totals: { datasets: number; places: number; events: number; countries: number }; loading: boolean }) {
  const t = makeT(language);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importEnabled = useImportState((value) => value.importEnabled);
  const deleting = useImportState((value) => dataset ? value.jobs.some((job) => job.status === "running" && job.params.kind === "dataset_delete" && job.params.datasetId === dataset.id) : false);
  const busy = useImportState((value) => dataset ? value.jobs.some((job) => job.status === "running" && job.sources.some((source) => source.sourceId === dataset.id)) : false);
  useEffect(() => { setConfirming(false); setError(null); }, [dataset?.id]);
  if (loading) {
    return <div className="data-detail-head">
      <span className="data-detail-icon"><Loader2 size={16} className="spin" /></span>
      <div className="data-detail-title"><h3>{t("Загружаю…", "Loading…")}</h3></div>
    </div>;
  }
  if (!dataset) {
    return <div className="data-detail-head">
      <span className="data-detail-icon"><Globe2 size={16} /></span>
      <div className="data-detail-title">
        <h3>{t("Все данные", "All data")}</h3>
        <p>{t(`${count(totals.datasets, language)} наборов · ${count(totals.places, language)} мест · ${count(totals.events, language)} событий · ${totals.countries} стран`, `${count(totals.datasets, language)} datasets · ${count(totals.places, language)} places · ${count(totals.events, language)} events · ${totals.countries} countries`)}</p>
      </div>
    </div>;
  }
  const remove = async () => {
    setError(null);
    try {
      importStore.upsert(await startImport({ kind: "dataset_delete", datasetId: dataset.id }));
      setConfirming(false);
    } catch (caught) {
      const code = caught instanceof ImportRequestError ? caught.code : "import_failed";
      setError(code === "dataset_busy" ? t("С этим набором сейчас работает другая задача.", "Another job is working on this dataset right now.")
        : code === "import_disabled" ? t("Удаление выключено: включите INVESTIGATION_IMPORT_ENABLED=true в .env.", "Deleting is off: set INVESTIGATION_IMPORT_ENABLED=true in .env.")
          : code === "too_many_import_jobs" ? t("Уже идут три задачи, дождитесь их окончания.", "Three jobs are already running; wait for them to finish.")
            : t("Не удалось начать удаление.", "Could not start the deletion."));
    }
  };
  return <div className="data-detail-head">
    <span className={`data-detail-icon ${dataset.kind}`}>{dataset.kind === "places" ? <MapPinned size={16} /> : <Activity size={16} />}</span>
    <div className="data-detail-title">
      <h3 title={dataset.label}>{datasetName(dataset.label)}</h3>
      <p>{[
        datasetOrigin(dataset, t),
        dataset.kind === "places" ? t(`${count(dataset.places, language)} мест`, `${count(dataset.places, language)} places`) : t(`${count(dataset.events, language)} событий`, `${count(dataset.events, language)} events`),
        dataset.license,
        dataset.snapshotDate ? `${t("снимок", "snapshot")} ${dataset.snapshotDate}` : dataset.lastImportAt ? `${t("синхр.", "synced")} ${formatDateTime(dataset.lastImportAt, language)}` : null,
      ].filter(Boolean).join(" · ")}</p>
    </div>
    <div className="data-detail-actions">
      {dataset.kind === "events" && <button type="button" className="data-text-button" onClick={openEventsMap}>{t("События на карте", "Events on the map")}<ArrowRight size={12} /></button>}
      {deleting && <span className="data-deleting"><Loader2 size={13} className="spin" />{t("удаляется", "deleting")}</span>}
      {dataset.deletable && importEnabled !== false && !deleting && <button type="button" className="data-text-button danger" disabled={busy} onClick={() => setConfirming((value) => !value)}><Trash2 size={12} />{t("Удалить", "Delete")}</button>}
    </div>
    {confirming && <div className="data-confirm" role="alertdialog" aria-label={t("Подтверждение удаления", "Confirm deletion")}>
      <p>{t(`Удалить «${datasetName(dataset.label)}» — ${count(dataset.places, language)} мест? Чат перестанет находить эти места, а планы поездок потеряют их точки. Набор можно импортировать снова.`, `Delete "${datasetName(dataset.label)}" with ${count(dataset.places, language)} places? The chat will no longer find them, and trip plans lose those stops. You can import the dataset again.`)}</p>
      <div>
        <button type="button" onClick={() => setConfirming(false)}>{t("Отмена", "Cancel")}</button>
        <button type="button" className="danger" onClick={() => void remove()}><Trash2 size={12} />{t("Удалить", "Delete")}</button>
      </div>
    </div>}
    {error && <p className="data-note error" role="alert">{error}</p>}
  </div>;
}

/** Records of a place dataset or of all data: filters on top, the list beside a map, and a card for the chosen place. */
function PlaceExplorer({ language, dataset, filters, onFilters }: { language: Language; dataset: Dataset | null; filters: Filters; onFilters(change: Partial<Filters>): void }) {
  const t = makeT(language);
  const catalog = useCatalog(dataset?.id, filters, onFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = catalog.rows.find((place) => place.id === selectedId) ?? null;
  const unselect = () => setSelectedId(null);
  if (catalog.countries.loading) return <p className="data-empty">{t("Загружаю…", "Loading…")}</p>;
  if (!catalog.country && !dataset) return <p className="data-empty">{t("Мест пока нет. Импортируйте город или регион.", "No places yet. Import a city or a region.")}</p>;
  return <div className="data-explorer">
    <CatalogFilterBar language={language} catalog={catalog} onChange={unselect} />
    <CatalogStatus language={language} catalog={catalog} onChange={unselect} />
    <div className="data-explorer-body">
      <CatalogRows language={language} catalog={catalog} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="data-explorer-map">
        <ExplorerMap
          language={language}
          points={catalog.rows.map((place) => ({ id: place.id, lat: place.lat, lon: place.lon }))}
          fitKey={filters.bbox ? null : `${catalog.filterKey}|${catalog.first.data?.places.length ?? 0}`}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSearchArea={(bbox) => { onFilters({ bbox }); unselect(); }}
        />
        {selected && <PlaceCard language={language} place={selected} onClose={unselect} />}
      </div>
    </div>
  </div>;
}

/** The current page of records on a map; it frames each new result and offers to search the area the user moved to. */
function ExplorerMap({ language, points, fitKey, selectedId, onSelect, onSearchArea }: { language: Language; points: Array<{ id: string; lat: number; lon: number }>; fitKey: string | null; selectedId: string | null; onSelect(id: string): void; onSearchArea?: (bbox: [number, number, number, number]) => void }) {
  const t = makeT(language);
  const [moved, setMoved] = useState<[number, number, number, number] | null>(null);
  return <div className="data-map">
    <MapContainer center={[49.8, 15.5]} zoom={4} minZoom={3} maxZoom={18} scrollWheelZoom preferCanvas fadeAnimation={false}>
      <TileLayer url={TILE_URL} maxZoom={18} keepBuffer={6} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' />
      <MapBehaviour points={points} fitKey={fitKey} selectedId={selectedId} onMoved={setMoved} />
      {points.map((point) => <CircleMarker key={point.id} center={[point.lat, point.lon]} radius={point.id === selectedId ? 9 : 5} eventHandlers={{ click: () => onSelect(point.id) }}
        pathOptions={{ color: point.id === selectedId ? "#ffffff" : "#8bdbb3", weight: point.id === selectedId ? 3 : 1, fillColor: point.id === selectedId ? "#58d9a0" : "#3f9c74", fillOpacity: 0.9 }} />)}
    </MapContainer>
    {onSearchArea && moved && <button type="button" className="data-map-search" onClick={() => { onSearchArea(moved); setMoved(null); }}><Scan size={12} />{t("Искать в этой области", "Search this area")}</button>}
  </div>;
}

function MapBehaviour({ points, fitKey, selectedId, onMoved }: { points: Array<{ id: string; lat: number; lon: number }>; fitKey: string | null; selectedId: string | null; onMoved(bbox: [number, number, number, number] | null): void }) {
  const map = useMap();
  // Moves made by the page (framing results, centering a selection) do not offer "search this area".
  const programmatic = useRef(false);
  const move = (action: () => void) => { programmatic.current = true; action(); programmatic.current = false; };
  useMapEvents({
    moveend: () => {
      if (programmatic.current) return;
      const bounds = map.getBounds();
      onMoved([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((value, index) => Math.max(index % 2 ? -90 : -180, Math.min(index % 2 ? 90 : 180, value))) as [number, number, number, number]);
    },
  });
  useEffect(() => {
    // The page stays mounted while hidden; a map that becomes visible again is measured anew.
    const observer = new ResizeObserver(() => move(() => map.invalidateSize({ animate: false })));
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  useEffect(() => {
    if (!fitKey || !points.length) return;
    move(() => map.invalidateSize({ animate: false }));
    const bounds = latLngBounds(points.map((point) => [point.lat, point.lon] as [number, number]));
    move(() => (points.length === 1 ? map.setView(bounds.getCenter(), 15, { animate: false }) : map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15, animate: false })));
    onMoved(null);
    // Framed once per result (the fit key names it); loading more rows does not move the map.
  }, [fitKey]);
  useEffect(() => {
    const point = points.find((item) => item.id === selectedId);
    if (!point) return;
    if (!map.getBounds().pad(-0.1).contains([point.lat, point.lon])) move(() => map.setView([point.lat, point.lon], Math.max(map.getZoom(), 14), { animate: false }));
  }, [selectedId]);
  return null;
}

/** Events of one source, newest first, with their points on a map. */
function EventExplorer({ language, dataset }: { language: Language; dataset: Dataset }) {
  const t = makeT(language);
  const first = useCachedQuery(`data:events:${dataset.id}`, () => listDatasetEvents(dataset.id, null), 60_000);
  const [more, setMore] = useState<DatasetEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setMore([]); setCursor(null); }, [first.data]);
  const rows = useMemo(() => [...(first.data?.events ?? []), ...more], [first.data, more]);
  const selected = rows.find((event) => event.id === selectedId) ?? null;
  const nextCursor = more.length ? cursor : first.data?.nextCursor ?? null;
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await listDatasetEvents(dataset.id, nextCursor);
      setMore((current) => [...current, ...page.events]);
      setCursor(page.nextCursor);
    } catch {
      // The button stays; the next click retries.
    } finally {
      setLoadingMore(false);
    }
  };
  return <div className="data-explorer">
    <div className="data-filter-state">
      <span className="data-list-meta">{first.loading ? t("Загружаю…", "Loading…") : first.data?.total != null ? t(`Всего ${count(first.data.total, language)} · новые сверху · показано ${count(rows.length, language)}`, `${count(first.data.total, language)} in total · newest first · ${count(rows.length, language)} shown`) : ""}</span>
      <button type="button" className="data-link-button" onClick={openEventsMap}>{t("Фильтры по радиусу и магнитуде — на карте в режиме «События»", "Radius and magnitude filters are on the map, in the Events mode")}<ArrowRight size={11} /></button>
    </div>
    <div className="data-explorer-body">
      <div className="data-explorer-list">
        {!first.loading && !rows.length ? <p className="data-empty">{t("Событий нет.", "No events.")}</p> : <ul className="data-rows">
          {rows.map((event) => <li key={event.id}>
            <button type="button" className={event.id === selectedId ? "active" : ""} aria-pressed={event.id === selectedId} onClick={() => setSelectedId(event.id === selectedId ? null : event.id)}>
              <strong title={event.label}>{event.label}</strong>
              <small>{formatDateTime(event.observedAt, language)}{event.magnitude !== null ? ` · M${event.magnitude}` : ""}</small>
            </button>
          </li>)}
        </ul>}
        {nextCursor && <button type="button" className="data-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("Загружаю…", "Loading…") : t("Показать ещё", "Show more")}</button>}
      </div>
      <div className="data-explorer-map">
        <ExplorerMap language={language} points={rows} fitKey={`${dataset.id}|${first.data?.events.length ?? 0}|${first.data?.events[0]?.id ?? ""}`} selectedId={selectedId} onSelect={setSelectedId} />
        {selected && <article className="data-card-float" aria-label={selected.label}>
          <header>
            <div><strong>{selected.label}</strong><small>{selected.category}</small></div>
            <button type="button" className="data-icon-button small" onClick={() => setSelectedId(null)} aria-label={t("Закрыть", "Close")}><X size={12} /></button>
          </header>
          <dl>
            <div><dt>{t("Время", "Time")}</dt><dd>{formatDateTime(selected.observedAt, language)}</dd></div>
            <div><dt>{t("Магнитуда", "Magnitude")}</dt><dd>{selected.magnitude ?? "—"}</dd></div>
            <div><dt>{t("Координаты", "Coordinates")}</dt><dd>{selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}</dd></div>
          </dl>
          {dataset.mode === "synthetic_local" && <p className="data-footnote">{t("Синтетическое событие, не реальное.", "A synthetic event, not a real one.")}</p>}
        </article>}
      </div>
    </div>
  </div>;
}

/** All data: places by country; a country opens its records, a dataset opens that dataset. */
function AllOverview({ language, countries, datasets, onCountry, onDataset }: { language: Language; countries: CountryCoverage[] | null; datasets: Dataset[]; onCountry(code: string): void; onDataset(id: string): void }) {
  const t = makeT(language);
  if (!countries) return <p className="data-empty">{t("Загружаю…", "Loading…")}</p>;
  return <div className="data-overview">
    <CountryTable language={language} countries={countries} datasets={datasets} onCountry={onCountry} onDataset={onDataset} />
    <p className="data-footnote">{t("Удалять можно только наборы, импортированные из приложения. Встроенные регионы и источники событий защищены; удаление идёт одной транзакцией, при отмене данные остаются как были.", "Only datasets imported from the app can be deleted; built-in regions and event sources are protected. A deletion is one transaction: cancelling it leaves the data as it was.")}</p>
  </div>;
}

function CountryTable({ language, countries, datasets, onCountry, onDataset }: { language: Language; countries: CountryCoverage[]; datasets?: Dataset[]; onCountry(code: string): void; onDataset?: (id: string) => void }) {
  const t = makeT(language);
  return <div className="data-table-wrap"><table className="data-table data-records-table">
    <thead><tr><th>{t("Страна", "Country")}</th><th className="num">{t("Места", "Places")}</th><th className="num">{t("Города", "Cities")}</th><th className="num">{t("Посёлки", "Towns")}</th><th className="num">{t("Деревни", "Villages")}</th>{onDataset && <th>{t("Наборы", "Datasets")}</th>}</tr></thead>
    <tbody>
      {countries.map((country) => <tr key={country.countryCode} onClick={() => onCountry(country.countryCode)} title={t("Открыть записи этой страны", "Open this country's records")}>
        <td><span className="data-country-code">{country.countryCode}</span>{countryName(country.countryCode, language)}</td>
        <td className="num">{count(country.places, language)}</td>
        <td className="num">{count(country.cities, language)}</td>
        <td className="num">{count(country.towns, language)}</td>
        <td className="num">{count(country.villages, language)}</td>
        {onDataset && <td className="data-links">{country.datasets.map((id) => <button key={id} type="button" onClick={(event) => { event.stopPropagation(); onDataset(id); }}>{datasetName(datasets?.find((item) => item.id === id)?.label ?? id)}</button>)}</td>}
      </tr>)}
    </tbody>
  </table></div>;
}

function PlacesOverview({ language, dataset, onOpen }: { language: Language; dataset: Dataset; onOpen(change: Partial<Filters>): void }) {
  const t = makeT(language);
  const countries = useScopeCountries(dataset.id);
  const categories = useCachedQuery(`data:categories:${JSON.stringify({ dataset: dataset.id })}`, () => listCatalogCategories({ dataset: dataset.id }), 5 * 60_000);
  const top = categories.data?.slice(0, 14) ?? [];
  // A square-root scale keeps small categories visible next to a dominant one (addresses, stops).
  const max = Math.max(1, ...top.map((item) => item.places));
  return <div className="data-overview data-overview-split">
    <div className="data-overview-main">
      <h4 className="data-section-title">{t("Состав по категориям", "Categories")}</h4>
      {categories.loading ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p> : <ul className="data-bars">
        {top.map((item) => <li key={item.category}>
          <button type="button" onClick={() => onOpen({ category: item.category, city: undefined })} title={t("Показать записи этой категории", "Show records of this category")}>
            <span className="data-bars-label">{categoryName(item.category, language)}</span>
            <span className="data-bars-track"><span style={{ width: `${Math.max(3, Math.sqrt(item.places / max) * 100)}%` }} /></span>
            <span className="data-bars-value">{count(item.places, language)}</span>
          </button>
        </li>)}
      </ul>}
      <h4 className="data-section-title">{t("Страны набора", "Countries of the dataset")}</h4>
      {countries.data ? <CountryTable language={language} countries={countries.data} onCountry={(country) => onOpen({ country, city: undefined, category: undefined })} /> : <p className="data-empty">{t("Загружаю…", "Loading…")}</p>}
    </div>
    <div className="data-overview-side">
      <h4 className="data-section-title">{t("Охват", "Extent")}</h4>
      {dataset.bbox ? <ExtentMap bbox={dataset.bbox} /> : <p className="data-empty">{t("Нет мест", "No places")}</p>}
      <dl className="data-facts">
        <div><dt>{t("Лицензия", "Licence")}</dt><dd>{dataset.license ?? "—"}{dataset.attribution ? ` · ${dataset.attribution}` : ""}</dd></div>
        <div><dt>{t("Источник", "Source")}</dt><dd>{dataset.sourceUrl ?? "—"}</dd></div>
        <div><dt>ID</dt><dd><code>{dataset.id}</code></dd></div>
      </dl>
    </div>
  </div>;
}

function EventsOverview({ language, dataset }: { language: Language; dataset: Dataset }) {
  const t = makeT(language);
  return <div className="data-overview">
    <dl className="data-facts wide">
      <div><dt>{t("Событий", "Events")}</dt><dd>{count(dataset.events, language)}</dd></div>
      <div><dt>{t("Последний импорт", "Last import")}</dt><dd>{dataset.lastImportAt ? formatDateTime(dataset.lastImportAt, language) : "—"}</dd></div>
      <div><dt>{t("Лицензия", "Licence")}</dt><dd>{dataset.license ?? "—"}{dataset.attribution ? ` · ${dataset.attribution}` : ""}</dd></div>
      <div><dt>{t("Источник", "Source")}</dt><dd>{dataset.sourceUrl ?? "—"}</dd></div>
      <div><dt>ID</dt><dd><code>{dataset.id}</code></dd></div>
    </dl>
    {dataset.mode === "synthetic_local" && <p className="data-note">{t("Синтетические демо-данные, не реальные события.", "Synthetic demo data, not real events.")}</p>}
  </div>;
}

function HistoryList({ language, jobs, datasetId, onCleared }: { language: Language; jobs: ImportJob[] | null; datasetId: string | null; onCleared(): void }) {
  const t = makeT(language);
  const [clearing, setClearing] = useState(false);
  const live = useImportState((value) => value.jobs);
  const importEnabled = useImportState((value) => value.importEnabled);
  // Jobs from the store are newer (progress over the WebSocket); jobs started since the last load are added.
  const merged = useMemo(() => {
    if (!jobs) return null;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const job of live) if (!byId.has(job.id) || byId.get(job.id)!.updatedAt < job.updatedAt) byId.set(job.id, job);
    return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [jobs, live]);
  const items = merged?.filter((job) => !datasetId || job.sources.some((source) => source.sourceId === datasetId)) ?? null;
  const finished = merged?.filter((job) => job.status !== "running").length ?? 0;
  const clear = async () => {
    setClearing(true);
    try {
      await clearImportHistory();
      onCleared();
    } catch {
      // The list stays as it was; the next refresh shows the real state.
    } finally {
      setClearing(false);
    }
  };
  if (!items) return <p className="data-empty">{t("Загружаю…", "Loading…")}</p>;
  return <div className="data-records">
    <div className="data-toolbar">
      <p className="data-list-meta">{datasetId ? t("Задачи импорта и удаления этого набора", "Import and deletion jobs of this dataset") : t("Последние 50 задач. Очистка удаляет только записи истории, данные остаются.", "The last 50 jobs. Clearing removes only the history entries; the data stays.")}</p>
      {!datasetId && importEnabled !== false && finished > 0 && <button type="button" className="data-text-button" disabled={clearing} onClick={() => void clear()}>{t("Очистить историю", "Clear history")}</button>}
    </div>
    {!items.length ? <p className="data-empty">{t("Задач ещё не было.", "No jobs yet.")}</p> : <div className="data-table-wrap"><table className="data-table data-records-table">
      <thead><tr><th>{t("Задача", "Job")}</th><th>{t("Тип", "Kind")}</th><th>{t("Начата", "Started")}</th><th className="num">{t("Результат", "Result")}</th></tr></thead>
      <tbody>
        {items.map((job) => <tr key={job.id} onClick={() => { importStore.upsert(job); importStore.showJobInDialog(job.id); }} title={t("Подробности задачи", "Job details")}>
          <td><strong>{jobTitle(job)}</strong></td>
          <td>{jobKindText(job, t)}</td>
          <td>{formatDateTime(job.createdAt, language)}</td>
          <td className="num"><span className={`data-status ${job.status}`}>{job.status === "running" ? `${Math.floor(job.progress * 100)}%` : statusText(job, language, t)}</span></td>
        </tr>)}
      </tbody>
    </table></div>}
  </div>;
}

/** The dataset's extent on a small map, without interaction. */
function ExtentMap({ bbox }: { bbox: [number, number, number, number] }) {
  const bounds = latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);
  return <div className="data-extent-map">
    <MapContainer bounds={bounds} boundsOptions={{ padding: [10, 10] }} zoomControl={false} attributionControl={false} dragging={false} scrollWheelZoom={false} doubleClickZoom={false} touchZoom={false} keyboard={false} key={bbox.join()}>
      <TileLayer url={import.meta.env.VITE_MAP_TILES_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png"} />
      <Rectangle bounds={bounds} pathOptions={{ color: "#5fd3a0", weight: 2, fillOpacity: 0.1 }} />
    </MapContainer>
  </div>;
}

function jobTitle(job: ImportJob): string {
  return job.params.kind === "events" ? job.sources.map((source) => source.label.split(" (")[0]).join(" + ") : datasetName(job.params.label);
}

function jobKindText(job: ImportJob, t: Translator): string {
  switch (job.params.kind) {
    case "events": return t(`события · ${job.params.days} дн.`, `events · ${job.params.days} d`);
    case "osm_area": return t("город или область", "city or area");
    case "osm_region": return t("регион целиком", "whole region");
    case "dataset_delete": return t("удаление набора", "dataset deletion");
  }
}

function statusText(job: ImportJob, language: Language, t: Translator): string {
  const added = job.sources.reduce((sum, source) => sum + source.inserted, 0);
  const removed = job.sources.reduce((sum, source) => sum + source.fetched, 0);
  switch (job.status) {
    case "succeeded": return job.params.kind === "dataset_delete" ? t(`удалено ${count(removed, language)}`, `${count(removed, language)} deleted`) : t(`+${count(added, language)} новых`, `+${count(added, language)} new`);
    case "partial": return t("частично", "partly done");
    case "cancelled": return t("отменён", "cancelled");
    case "failed": return t("ошибка", "failed");
    default: return "";
  }
}

function datasetOrigin(dataset: Dataset, t: Translator): string {
  if (dataset.id.startsWith("osm-area-")) return t("город (Overpass)", "city (Overpass)");
  if (dataset.id.startsWith("osm-region-")) return t("регион (Geofabrik)", "region (Geofabrik)");
  if (dataset.kind === "events") return t("события", "events");
  return t("встроенный регион", "built-in region");
}

function datasetName(label: string): string {
  return label.replace(/^OpenStreetMap:\s*/i, "").replace(/\s*regional extract$/i, "").replace(/\s*\(Overpass\)$/i, "");
}

function formatDateTime(iso: string, language: Language): string {
  return new Date(iso).toLocaleString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
