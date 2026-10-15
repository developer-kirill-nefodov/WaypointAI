import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowRight, Check, ChevronDown, ChevronRight, DatabaseZap, Globe2, MapPinned, Minimize2, RotateCw, Search, Square, X } from "lucide-react";
import { MapContainer, Rectangle, TileLayer } from "react-leaflet";
import { latLngBounds } from "leaflet";
import type { ImportJob, ImportJobSource, OsmAreaCategory, SourceView } from "@waypoint-ai/shared";
import { loadDataSources } from "../../shared/api/client";
import { navigateTo } from "../../shared/routing";
import { invalidateCache, useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { browseRegions, cancelImport, geocode, getImport, ImportRequestError, listDatasets, listImports, regionInfo, repeatRequest, searchRegions, startImport, type GeocodeResult, type GeofabrikFile, type GeofabrikRegion } from "./import-api";
import { AREA_CATEGORIES, IMPORT_DAY_OPTIONS, IMPORT_SOURCES, importStore, useImportState } from "./import-store";

type Bbox = [number, number, number, number];
const AREA_TILE_DEGREES = 0.25;

const POLL_INTERVAL_MS = 2_000;
/** Without a WebSocket update for this long, running jobs are refreshed from the API. */
const PUSH_STALE_MS = 2_500;
const SOURCE_COLORS = ["#5fd3a0", "#6aa8ff", "#e6b35c", "#d58ad8"];

/**
 * The import dialog and the dock beside the page. Mounted once in the app shell, so an import keeps showing its
 * progress across pages; after a reload the dock reattaches to running jobs from the API.
 */
export default function ImportLayer({ language }: { language: Language }) {
  const dialogOpen = useImportState((value) => value.dialogOpen);
  useImportSync();
  return <>
    {dialogOpen && <ImportDialog language={language} />}
    {!dialogOpen && <ImportDock language={language} />}
  </>;
}

/** Reattaches after a reload and polls the API while running jobs get no WebSocket updates. */
function useImportSync() {
  useEffect(() => {
    const abort = new AbortController();
    listImports(false, abort.signal)
      .then(({ importEnabled, jobs, cooldowns }) => {
        importStore.setImportEnabled(importEnabled);
        importStore.setCooldowns(cooldowns);
        // Running jobs and those finished in the last hour; older ones stay in the history only.
        for (const job of [...jobs].reverse()) {
          if (job.status === "running" || Date.now() - Date.parse(job.finishedAt ?? job.updatedAt) < 60 * 60 * 1000) importStore.upsert(job);
        }
      })
      .catch(() => undefined);
    const timer = window.setInterval(() => {
      const { jobs, lastPushAt } = importStore.getState();
      const running = jobs.filter((job) => job.status === "running");
      if (!running.length || Date.now() - lastPushAt < PUSH_STALE_MS) return;
      for (const job of running) void getImport(job.id).then((latest) => importStore.upsert(latest)).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    // A finished import starts the source's cooldown; refresh it so the dialog and retry buttons show the wait.
    const refreshCooldowns = () => {
      invalidateCache("import:sources");
      void listImports(true).then(({ cooldowns }) => importStore.setCooldowns(cooldowns)).catch(() => undefined);
    };
    window.addEventListener("waypoint:import-finished", refreshCooldowns);
    return () => {
      abort.abort();
      window.clearInterval(timer);
      window.removeEventListener("waypoint:import-finished", refreshCooldowns);
    };
  }, []);
}

/** Re-renders every `intervalMs`, for countdowns. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function minutesLeft(until: number | undefined, now: number): number {
  return until && until > now ? Math.ceil((until - now) / 60_000) : 0;
}

function ImportDialog({ language }: { language: Language }) {
  const t = makeT(language);
  const draft = useImportState((value) => value.draft);
  const tab = useImportState((value) => value.tab);
  const areaCategories = useImportState((value) => value.areaCategories);
  const maxArea = useImportState((value) => value.maxAreaSquareDegrees);
  const importEnabled = useImportState((value) => value.importEnabled);
  const dialogJobId = useImportState((value) => value.dialogJobId);
  const job = useImportState((value) => value.jobs.find((item) => item.id === value.dialogJobId) ?? null);
  // Cached across openings, so the event sources do not flicker each time the dialog opens.
  const sources = useCachedQuery<SourceView[]>("import:sources", () => loadDataSources()).data ?? [];
  const [area, setArea] = useState<GeocodeResult | null>(null);
  const [region, setRegion] = useState<{ region: GeofabrikRegion; file: GeofabrikFile } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = job?.status === "running";

  const cooldownUntil = useImportState((value) => value.cooldownUntil);
  const now = useNow(15_000);
  useEffect(() => {
    const abort = new AbortController();
    listImports(true, abort.signal).then(({ cooldowns, importEnabled: enabled, osmAreaMaxSquareDegrees }) => {
      importStore.setCooldowns(cooldowns);
      importStore.setImportEnabled(enabled);
      importStore.setMaxArea(osmAreaMaxSquareDegrees);
    }).catch(() => undefined);
    return () => abort.abort();
  }, [job?.status]);
  const waiting = draft.sourceIds.filter((id) => minutesLeft(cooldownUntil[id], now) > 0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") importStore.closeDialog(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleSource = (id: string) => importStore.setDraft({
    sourceIds: draft.sourceIds.includes(id) ? draft.sourceIds.filter((item) => item !== id) : IMPORT_SOURCES.map((source) => source.id).filter((item) => item === id || draft.sourceIds.includes(item)),
  });
  const areaBbox = area ? clampBbox(area.bbox, maxArea) : null;
  const canStart = tab === "events"
    ? draft.sourceIds.length > 0 && waiting.length === 0
    : tab === "area" ? Boolean(area) && areaCategories.length > 0
      : tab === "region" && Boolean(region);
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const started = await startImport(tab === "area" && area && areaBbox
        ? { kind: "osm_area", label: area.name, bbox: areaBbox, countryCode: area.countryCode, categories: areaCategories }
        : tab === "region" && region
          // The server takes the region's name and country from the catalogue.
          ? { kind: "osm_region", regionId: region.region.id }
          : { kind: "events", sourceIds: draft.sourceIds, days: draft.days });
      importStore.upsert(started);
      importStore.setDialogJob(started.id);
    } catch (caught) {
      const code = caught instanceof ImportRequestError ? caught.code : "import_failed";
      setError(errorText(code, null, t));
      if (code === "import_disabled") importStore.setImportEnabled(false);
    } finally {
      setStarting(false);
    }
  };
  const close = () => {
    if (job && !running) importStore.setDialogJob(null);
    importStore.closeDialog();
  };
  const showForm = !job;

  return <div className="import-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <header className="import-dialog-head">
        <span className="import-dialog-icon"><DatabaseZap size={17} /></span>
        <div>
          <h2 id="import-dialog-title">{t("Импорт данных", "Import data")}</h2>
          <p>{t("Загрузка из открытых источников в локальную базу. Повторный импорт не создаёт дубликатов.", "Load open data into the local database. Re-importing never creates duplicates.")}</p>
        </div>
        <button type="button" className="import-icon-button" onClick={close} aria-label={running ? t("Свернуть", "Minimize") : t("Закрыть", "Close")}>{running ? <Minimize2 size={15} /> : <X size={15} />}</button>
      </header>

      {showForm && <div className="import-tabs" role="tablist" aria-label={t("Что импортировать", "What to import")}>
        {([
          ["area", <MapPinned key="i" size={13} />, t("Город или область", "City or area")],
          ["region", <Globe2 key="i" size={13} />, t("Регион целиком", "Whole region")],
          ["events", <Activity key="i" size={13} />, t("События", "Events")],
        ] as const).map(([id, icon, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => importStore.setTab(id)}>{icon}{label}</button>)}
      </div>}

      {showForm && tab === "events" && <fieldset className="import-form" disabled={starting}>
        <legend>{t("Источники", "Sources")}</legend>
        {IMPORT_SOURCES.map((source) => {
          const sync = sources.find((item) => item.id === source.id)?.lastSync;
          const wait = minutesLeft(cooldownUntil[source.id], now);
          return <label key={source.id} className={`import-source-option${wait ? " cooling" : ""}`}>
            <input type="checkbox" checked={draft.sourceIds.includes(source.id)} onChange={() => toggleSource(source.id)} />
            <span><strong>{source.label}</strong><small>{source.license} · {sync?.lastSucceededAt ? `${t("синхр.", "synced")} ${formatDateTime(sync.lastSucceededAt, language)}` : t("ещё не загружался", "never imported")}</small>
              {wait > 0 && <small className="import-cooldown">{t(`пауза между импортами: ещё ${wait} мин`, `cooldown: ${wait} min left`)}</small>}</span>
          </label>;
        })}
        <legend>{t("Период", "Period")}</legend>
        <div className="import-days" role="radiogroup" aria-label={t("Период", "Period")}>
          {IMPORT_DAY_OPTIONS.map((days) => <button key={days} type="button" role="radio" aria-checked={draft.days === days} className={draft.days === days ? "active" : ""} onClick={() => importStore.setDraft({ days })}>{t(`${days} дн.`, `${days} d`)}</button>)}
        </div>
      </fieldset>}

      {showForm && tab === "area" && <AreaForm language={language} area={area} onArea={setArea} bbox={areaBbox} maxArea={maxArea} categories={areaCategories} disabled={starting} />}
      {showForm && tab === "region" && <RegionForm language={language} selected={region} onSelect={setRegion} disabled={starting} />}

      {importEnabled === false && <p className="import-note">{t("Импорт из приложения выключен. Включите INVESTIGATION_IMPORT_ENABLED=true в .env (только для локальной демо-среды: аутентификации нет) или используйте npm run data:import:events.", "Importing from the app is off. Set INVESTIGATION_IMPORT_ENABLED=true in .env (local demo only: there is no authentication) or use npm run data:import:events.")}</p>}
      {error && <p className="import-note error" role="alert">{error}</p>}
      {job && <JobProgress job={job} language={language} detailed />}

      <footer className="import-dialog-actions">
        {running ? <>
          <button type="button" onClick={close}><Minimize2 size={14} />{t("Свернуть", "Minimize")}</button>
          <button type="button" className="danger" onClick={() => void cancelImport(job.id).catch(() => undefined)}><Square size={13} />{t("Отменить импорт", "Cancel import")}</button>
        </> : job ? <>
          <button type="button" onClick={() => importStore.setDialogJob(null)}>{t("Новый импорт", "New import")}</button>
          <button type="button" className="primary" onClick={close}><Check size={14} />{t("Готово", "Done")}</button>
        </> : <>
          <button type="button" className="import-footer-link" onClick={() => { close(); navigateTo("data"); }}>{t("Загруженные данные", "Loaded data")}<ArrowRight size={13} /></button>
          <button type="button" onClick={close}>{t("Отмена", "Cancel")}</button>
          <button type="button" className="primary" disabled={!canStart || starting || importEnabled === false} title={tab === "events" && waiting.length ? t("Снимите источники на паузе или дождитесь её окончания", "Clear the sources in cooldown or wait for it to end") : undefined} onClick={() => void start()}>{starting ? t("Запускаю…", "Starting…") : t("Начать импорт", "Start import")}</button>
        </>}
      </footer>
      {dialogJobId && running && <p className="import-hint">{t("Окно можно закрыть: импорт продолжится, прогресс будет сбоку страницы.", "You can close this window: the import continues and its progress stays at the side of the page.")}</p>}
    </section>
  </div>;
}

/** Finding the city, its area on a small map, and the kinds of places to load. */
function AreaForm({ language, area, onArea, bbox, maxArea, categories, disabled }: { language: Language; area: GeocodeResult | null; onArea(area: GeocodeResult | null): void; bbox: Bbox | null; maxArea: number; categories: OsmAreaCategory[]; disabled: boolean }) {
  const t = makeT(language);
  const [query, setQuery] = useState(area?.name ?? "");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const loadedIds = useLoadedDatasetIds();
  const search = async (text = query) => {
    if (text.trim().length < 2) return;
    setSearching(true);
    setSearchError(null);
    try {
      const found = await geocode(text.trim(), language);
      setResults(found);
      if (!found.length) setSearchError(t("Ничего не нашлось. Попробуйте другое написание.", "Nothing found. Try another spelling."));
    } catch (caught) {
      setSearchError(caught instanceof ImportRequestError && caught.code === "rate_limited" ? t("Слишком часто, повторите через секунду.", "Too fast; try again in a second.") : t("Поиск сейчас недоступен.", "Search is unavailable right now."));
    } finally {
      setSearching(false);
    }
  };
  const clamped = Boolean(area && bbox && bbox.join() !== area.bbox.join());
  const toggle = (category: OsmAreaCategory) => importStore.setAreaCategories(categories.includes(category) ? categories.filter((item) => item !== category) : AREA_CATEGORIES.filter((item) => item === category || categories.includes(item)));
  return <fieldset className="import-form" disabled={disabled}>
    <legend>{t("Город или область", "City or area")}</legend>
    <form className="import-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <Search size={14} aria-hidden="true" />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Например: Kraków, Firenze, Wien", "For example: Kraków, Firenze, Wien")} aria-label={t("Город", "City")} />
      <button type="submit" disabled={searching || query.trim().length < 2}>{searching ? t("Ищу…", "Searching…") : t("Найти", "Find")}</button>
    </form>
    {searchError && <p className="import-search-note">{searchError}</p>}
    {!area && !results.length && <div className="import-suggestions">
      <span>{t("Например:", "For example:")}</span>
      {SUGGESTED_CITIES.map((city) => {
        const loaded = loadedIds.has(`osm-area-${areaSlug(city)}`);
        return <button key={city} type="button" disabled={searching} className={loaded ? "loaded" : ""} title={loaded ? t("Уже загружен; повторный импорт обновит его", "Already loaded; importing again updates it") : undefined} onClick={() => { setQuery(city); void search(city); }}>{loaded && <Check size={11} />}{city}</button>;
      })}
    </div>}
    {results.length > 0 && !area && <ul className="import-search-results">
      {results.map((result) => <li key={`${result.lat},${result.lon}`}>
        <button type="button" onClick={() => { onArea(result); setResults([]); setQuery(result.localizedName); }}>
          <strong>{result.localizedName}{result.name !== result.localizedName ? ` · ${result.name}` : ""}</strong><small>{result.label}</small>
        </button>
      </li>)}
    </ul>}
    {area && bbox && <div className="import-area">
      <AreaPreview bbox={bbox} />
      <div className="import-area-info">
        <strong>{area.name}{area.localizedName !== area.name ? ` (${area.localizedName})` : ""}{area.countryCode ? ` · ${area.countryCode}` : ""}</strong>
        <small>{t(`≈ ${areaKm(bbox)} км², ${tileCount(bbox)} участк. загрузки`, `≈ ${areaKm(bbox)} km², ${tileCount(bbox)} download tiles`)}</small>
        {clamped && <small className="import-cooldown">{t(`Область больше допустимой (${maxArea}°²) — взят центр города.`, `The area exceeds the limit (${maxArea} sq. deg.); the city centre is used.`)}</small>}
        <button type="button" className="import-link" onClick={() => onArea(null)}>{t("Выбрать другой", "Choose another")}</button>
      </div>
    </div>}
    <legend>{t("Что загрузить", "What to load")}</legend>
    <div className="import-chips">
      {AREA_CATEGORIES.map((category) => <button key={category} type="button" aria-pressed={categories.includes(category)} className={categories.includes(category) ? "active" : ""} onClick={() => toggle(category)}>{categoryLabel(category, t)}</button>)}
    </div>
    <p className="import-search-note">{t("Населённые пункты загружаются всегда, чтобы чат находил город по названию. Данные © участники OpenStreetMap (ODbL).", "Settlements are always loaded so the chat can find the city by name. Data © OpenStreetMap contributors (ODbL).")}</p>
  </fieldset>;
}

/** A whole region from the Geofabrik catalogue: browse Europe's countries and their regions, or search; then the file's size and date before starting. */
function RegionForm({ language, selected, onSelect, disabled }: { language: Language; selected: { region: GeofabrikRegion; file: GeofabrikFile } | null; onSelect(value: { region: GeofabrikRegion; file: GeofabrikFile } | null): void; disabled: boolean }) {
  const t = makeT(language);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ regions: GeofabrikRegion[]; via?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The browsing path, outermost first; empty means Europe's countries.
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const parent = trail.at(-1)?.id ?? null;
  const browse = useCachedQuery(found ? null : `import:regions:${parent ?? "europe"}`, () => browseRegions(parent), 24 * 60 * 60_000);
  const loadedIds = useLoadedDatasetIds();
  const search = async () => {
    if (query.trim().length < 2) return;
    setLoading(true);
    setNote(null);
    try {
      const result = await searchRegions(query.trim(), language);
      setFound(result);
      if (!result.regions.length) setNote(t("Ничего не нашлось ни в каталоге Geofabrik, ни на карте. Попробуйте другое написание или выберите страну из списка.", "Nothing found in the Geofabrik catalogue or on the map. Try another spelling or pick a country from the list."));
    } catch (caught) {
      setNote(caught instanceof ImportRequestError && caught.code === "rate_limited" ? t("Слишком часто, повторите через секунду.", "Too fast; try again in a second.") : t("Каталог Geofabrik сейчас недоступен.", "The Geofabrik catalogue is unavailable right now."));
    } finally {
      setLoading(false);
    }
  };
  const choose = async (region: GeofabrikRegion) => {
    setLoading(true);
    try {
      onSelect(await regionInfo(region.id));
    } catch {
      setNote(t("Не удалось узнать размер файла региона.", "Could not get the region file's size."));
    } finally {
      setLoading(false);
    }
  };
  const clearSearch = () => { setFound(null); setQuery(""); setNote(null); };
  const megabytes = selected?.file.bytes ? Math.round(selected.file.bytes / 1_048_576) : null;
  const rows = found ? found.regions : browse.data ?? [];
  return <fieldset className="import-form" disabled={disabled}>
    <legend>{t("Регион из каталога Geofabrik", "Region from the Geofabrik catalogue")}</legend>
    {selected ? <div className="import-region-card">
      <span className="import-dataset-icon places"><Globe2 size={14} /></span>
      <span className="import-dataset-name">
        <strong>{selected.region.name}</strong>
        <small>{[...selected.region.path].join(" › ")}{selected.region.countryCode ? ` · ${selected.region.countryCode}` : ""}</small>
        <small>{megabytes !== null ? t(`Файл ≈ ${megabytes} МБ`, `File ≈ ${megabytes} MB`) : t("Размер файла неизвестен", "File size unknown")}{selected.file.lastModified ? ` · ${t("обновлён", "updated")} ${formatDateTime(selected.file.lastModified, language)}` : ""}</small>
        {loadedIds.has(`osm-region-${selected.region.id}`) && <small className="import-loaded">{t("✓ уже загружен — импорт обновит его", "✓ already loaded; importing updates it")}</small>}
      </span>
      <button type="button" className="import-link" onClick={() => onSelect(null)}>{t("Другой", "Another")}</button>
    </div> : <>
      <form className="import-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <Search size={14} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Страна, регион или город: Polska, Bavaria, Краков", "Country, region, or city: Polska, Bavaria, Kraków")} aria-label={t("Регион", "Region")} />
        {found && <button type="button" className="import-search-clear" onClick={clearSearch} aria-label={t("К списку стран", "Back to the countries")}><X size={13} /></button>}
        <button type="submit" disabled={loading || query.trim().length < 2}>{loading ? t("Ищу…", "Searching…") : t("Найти", "Find")}</button>
      </form>
      {note && <p className="import-search-note">{note}</p>}
      {found?.via && found.regions.length > 0 && <p className="import-search-note">{t(`«${found.via}» нет в каталоге отдельным регионом — вот регионы, в которые входит это место:`, `"${found.via}" is not a region of its own in the catalogue; these regions contain it:`)}</p>}
      {!found && <div className="import-trail">
        <button type="button" className={trail.length ? "" : "current"} onClick={() => setTrail([])}>{t("Европа", "Europe")}</button>
        {trail.map((step, index) => <span key={step.id}><ChevronRight size={11} /><button type="button" className={index === trail.length - 1 ? "current" : ""} onClick={() => setTrail(trail.slice(0, index + 1))}>{step.name}</button></span>)}
      </div>}
      {!found && browse.loading ? <p className="import-search-note">{t("Загружаю каталог…", "Loading the catalogue…")}</p>
        : <ul className="import-region-list">
          {rows.map((region) => <li key={region.id}>
            <button type="button" className="import-region-pick" onClick={() => !found && region.hasChildren ? setTrail([...trail, { id: region.id, name: regionTitle(region, language) }]) : void choose(region)}>
              <strong>{regionTitle(region, language)}</strong>
              <small>{[regionTitle(region, language) !== region.name ? region.name : null, found ? [...region.path].join(" › ") : region.hasChildren ? t("есть регионы поменьше", "has smaller regions") : t("загрузить целиком", "load as a whole")].filter(Boolean).join(" · ")}</small>
              {loadedIds.has(`osm-region-${region.id}`) && <span className="import-loaded">✓ {t("загружен", "loaded")}</span>}
            </button>
            {!found && region.hasChildren && <button type="button" className="import-region-whole" onClick={() => void choose(region)} title={t("Загрузить всю страну", "Load the whole country")}>{t("Целиком", "Whole")}</button>}
            {!found && region.hasChildren && <ChevronRight size={14} className="import-region-chevron" aria-hidden="true" />}
          </li>)}
        </ul>}
    </>}
    {megabytes !== null && megabytes > 300 && <p className="import-note">{t(`Большой регион: скачивание и разбор ${megabytes} МБ займут от нескольких минут до получаса и заметно нагрузят компьютер. Для одного города быстрее вкладка «Город или область».`, `A large region: downloading and parsing ${megabytes} MB takes from a few minutes to half an hour and loads the computer noticeably. For one city, the "City or area" tab is faster.`)}</p>}
    <p className="import-search-note">{t("Загружаются все места с названием и категорией и адреса, как для встроенных регионов. Файл сохраняется в data/local/regions и используется повторно. Данные © участники OpenStreetMap (ODbL).", "All named places with a category and addresses are loaded, as for the built-in regions. The file is kept in data/local/regions and reused. Data © OpenStreetMap contributors (ODbL).")}</p>
  </fieldset>;
}

/** IDs of the datasets in the local database, to mark what is already loaded; shares the data page's cache. */
function useLoadedDatasetIds(): Set<string> {
  const datasets = useCachedQuery("data:datasets", () => listDatasets(false));
  return useMemo(() => new Set(datasets.data?.filter((dataset) => dataset.places > 0 || dataset.events > 0).map((dataset) => dataset.id) ?? []), [datasets.data]);
}

/** Cities outside the built-in regions to start from; the names are the local ones the search and the chat use. */
const SUGGESTED_CITIES = ["Wien", "Praha", "Budapest", "Kraków", "Venezia", "Firenze", "München", "Ljubljana", "Bratislava", "Lisboa", "Amsterdam", "Barcelona", "Dubrovnik", "Wrocław"];

/** The chosen area on a small map, without interaction. */
function AreaPreview({ bbox }: { bbox: Bbox }) {
  const bounds = latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);
  return <div className="import-area-map">
    <MapContainer bounds={bounds} boundsOptions={{ padding: [12, 12] }} zoomControl={false} attributionControl={false} dragging={false} scrollWheelZoom={false} doubleClickZoom={false} touchZoom={false} keyboard={false} key={bbox.join()}>
      <TileLayer url={import.meta.env.VITE_MAP_TILES_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png"} />
      <Rectangle bounds={bounds} pathOptions={{ color: "#5fd3a0", weight: 2, fillOpacity: 0.12 }} />
    </MapContainer>
  </div>;
}

function ImportDock({ language }: { language: Language }) {
  const t = makeT(language);
  const jobs = useImportState((value) => value.jobs);
  const dismissed = useImportState((value) => value.dismissed);
  const collapsed = useImportState((value) => value.dockCollapsed);
  // Closing a job only hides it here; a running one keeps going and stays on the data page.
  const open = useMemo(() => jobs.filter((job) => !dismissed.includes(job.id)), [jobs, dismissed]);
  const visible = open.slice(0, 4);
  if (!visible.length) return null;
  const running = visible.filter((job) => job.status === "running");
  const overall = running.length ? running.reduce((sum, job) => sum + job.progress, 0) / running.length : 1;

  if (collapsed) {
    return <button type="button" className="import-dock-pill" onClick={importStore.toggleDock} aria-label={t("Показать импорт", "Show imports")}>
      <ProgressRing sources={running.flatMap((job) => job.sources)} size={30} done={!running.length} />
      <span>{running.length ? `${Math.floor(overall * 100)}%` : t("Импорт готов", "Import done")}</span>
    </button>;
  }
  return <aside className="import-dock" aria-label={t("Импорт данных", "Data import")}>
    <header>
      <DatabaseZap size={14} /><strong>{t("Импорт", "Import")}</strong>
      {running.length > 0 && <span className="import-dock-count">{running.length} {t("идёт", "running")}</span>}
      {open.length > 1 && <button type="button" className="import-dock-clear" onClick={() => importStore.dismissAll(open.map((job) => job.id))} title={t("Скрыть все задачи из панели; идущие продолжатся", "Hide every job from this panel; running ones continue")}>{t("Закрыть все", "Close all")}</button>}
      <button type="button" className="import-icon-button" onClick={importStore.toggleDock} aria-label={t("Свернуть", "Collapse")}><ChevronDown size={14} /></button>
    </header>
    {open.length > visible.length && <p className="import-dock-more">{t(`ещё ${open.length - visible.length} — на странице «Данные»`, `${open.length - visible.length} more on the Data page`)}</p>}
    {visible.map((job) => <article key={job.id} className={`import-dock-job ${job.status}`}>
      <button type="button" className="import-dock-open" onClick={() => importStore.showJobInDialog(job.id)} aria-label={t("Открыть импорт", "Open import")}>
        <ProgressRing sources={job.sources} size={44} done={job.status === "succeeded"} failed={job.status === "failed"} label={job.status === "running" ? `${Math.floor(job.progress * 100)}%` : undefined} />
        <span className="import-dock-title">
          <strong>{job.sources.map(shortLabel).join(" + ")}</strong>
          <small>{job.params.kind === "events" ? t(`события · ${job.params.days} дн.`, `events · ${job.params.days} d`) : job.params.kind === "osm_region" ? t("регион OSM", "OSM region") : job.params.kind === "dataset_delete" ? t("удаление набора", "dataset deletion") : t("места OSM", "OSM places")} · {jobStatusText(job, t)}</small>
        </span>
      </button>
      <button type="button" className="import-icon-button" onClick={() => importStore.dismiss(job.id)} aria-label={job.status === "running" ? t("Скрыть, задача продолжится", "Hide; the job continues") : t("Закрыть", "Close")} title={job.status === "running" ? t("Скрыть, задача продолжится", "Hide; the job continues") : t("Закрыть", "Close")}><X size={13} /></button>
      <JobProgress job={job} language={language} />
    </article>)}
  </aside>;
}

/** Per-source bars with the phase, counts, and errors; actions to cancel or retry failed sources. */
function JobProgress({ job, language, detailed = false }: { job: ImportJob; language: Language; detailed?: boolean }) {
  const t = makeT(language);
  const now = useNow(15_000);
  const failed = job.sources.filter((source) => source.status === "failed" || source.status === "cancelled");
  // A source that failed on its cooldown can be retried only when the wait is over.
  const retryAt = Math.max(0, ...failed.map((source) => source.retryAfterSeconds ? Date.parse(job.finishedAt ?? job.updatedAt) + source.retryAfterSeconds * 1000 : 0));
  const retryWait = minutesLeft(retryAt, now);
  const retry = async () => {
    try {
      const started = await startImport(job.params.kind === "events" ? { ...job.params, sourceIds: failed.map((source) => source.sourceId) } : repeatRequest(job.params));
      importStore.upsert(started);
      importStore.dismiss(job.id);
      if (importStore.getState().dialogOpen) importStore.setDialogJob(started.id);
    } catch {
      // The dock keeps showing the failed job; its row explains the error.
    }
  };
  return <div className={`import-progress${detailed ? " detailed" : ""}`}>
    {detailed && <div className="import-progress-total"><span>{jobStatusText(job, t)}</span><strong>{Math.floor(job.progress * 100)}%</strong></div>}
    {job.sources.map((source, index) => <div key={source.sourceId} className={`import-source-row ${source.status}`}>
      <div className="import-source-line"><span className="import-source-dot" style={{ background: SOURCE_COLORS[index % SOURCE_COLORS.length] }} /><strong>{shortLabel(source)}</strong><span>{sourceText(source, job.params.kind, language, t)}</span></div>
      <div className="import-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(source.progress * 100)} aria-label={shortLabel(source)}><span style={{ width: `${Math.max(2, source.progress * 100)}%`, background: source.status === "failed" ? "#e0786c" : SOURCE_COLORS[index % SOURCE_COLORS.length] }} /></div>
    </div>)}
    <div className="import-progress-actions">
      {job.status === "running" && !detailed && <button type="button" onClick={() => void cancelImport(job.id).catch(() => undefined)}><Square size={11} />{t("Отменить", "Cancel")}</button>}
      {job.status !== "running" && failed.length > 0 && <button type="button" disabled={retryWait > 0} onClick={() => void retry()}><RotateCw size={11} />{retryWait > 0 ? t(`Повторить можно через ${retryWait} мин`, `Retry in ${retryWait} min`) : `${t("Повторить", "Retry")} ${failed.map(shortLabel).join(", ")}`}</button>}
    </div>
  </div>;
}

/** A ring with one arc per source, each filled to its own progress. */
function ProgressRing({ sources, size, done = false, failed = false, label }: { sources: ImportJobSource[]; size: number; done?: boolean; failed?: boolean; label?: string }) {
  const stroke = size > 36 ? 5 : 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const count = Math.max(1, sources.length);
  const gap = count > 1 ? 4 : 0;
  const segment = circumference / count;
  return <span className="import-ring" style={{ width: size, height: size }} aria-hidden="true">
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {Array.from({ length: count }, (_, index) => {
        const source = sources[index];
        const length = Math.max(0, segment - gap);
        const filled = length * (done ? 1 : source?.progress ?? 0);
        const color = failed || source?.status === "failed" ? "#e0786c" : done ? "#5fd3a0" : SOURCE_COLORS[index % SOURCE_COLORS.length];
        const rotation = -90 + (360 / count) * index;
        return <g key={index} transform={`rotate(${rotation} ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#2b3d3b" strokeWidth={stroke} strokeDasharray={`${length} ${circumference}`} />
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${filled} ${circumference}`} />
        </g>;
      })}
    </svg>
    <span className="import-ring-label">{done ? <Check size={size > 36 ? 15 : 12} /> : failed ? <X size={size > 36 ? 15 : 12} /> : label}</span>
  </span>;
}

/** The short name the dialog uses; the server's label is the full catalogue name. */
function shortLabel(source: ImportJobSource): string {
  return IMPORT_SOURCES.find((item) => item.id === source.sourceId)?.label
    ?? source.label.replace(/^OpenStreetMap:\s*/i, "").replace(/\s*regional extract$/i, "").replace(/\s*\(Overpass\)$/i, "");
}

function jobStatusText(job: ImportJob, t: Translator): string {
  const added = job.sources.reduce((sum, source) => sum + source.inserted, 0);
  const removing = job.params.kind === "dataset_delete";
  switch (job.status) {
    case "running": return removing ? t("идёт удаление", "deleting") : t("идёт импорт", "importing");
    case "succeeded": return removing ? t(`удалено ${job.sources.reduce((sum, source) => sum + source.fetched, 0)} мест`, `${job.sources.reduce((sum, source) => sum + source.fetched, 0)} places deleted`) : t(`готово · +${added} новых`, `done · +${added} new`);
    case "partial": return t(`частично · +${added} новых`, `partly done · +${added} new`);
    case "cancelled": return t("отменён", "cancelled");
    case "failed": return t("ошибка", "failed");
  }
}

function sourceText(source: ImportJobSource, kind: ImportJob["params"]["kind"], language: Language, t: Translator): string {
  switch (source.status) {
    case "pending": return t("в очереди", "queued");
    case "running":
      if (kind === "dataset_delete") return t(`удаление · ${count(source.stepsDone, language)} из ${count(source.stepsTotal, language)} мест`, `deleting · ${count(source.stepsDone, language)} of ${count(source.stepsTotal, language)} places`);
      if (kind === "osm_region") {
        if (source.phase === "saving") return t(`разбор и запись · ${source.stepsDone} из ${source.stepsTotal} МБ · ${count(source.fetched, language)} мест`, `parsing and saving · ${source.stepsDone} of ${source.stepsTotal} MB · ${count(source.fetched, language)} places`);
        return source.stepsTotal ? t(`скачивание · ${source.stepsDone} из ${source.stepsTotal} МБ`, `downloading · ${source.stepsDone} of ${source.stepsTotal} MB`) : t("подготовка", "preparing");
      }
      if (kind === "osm_area") {
        if (source.phase === "saving") return t(`запись · ${source.fetched} мест`, `saving · ${source.fetched} places`);
        return t(`загрузка участка ${Math.min(source.stepsDone + 1, source.stepsTotal || 1)} из ${source.stepsTotal || "…"} · ${source.fetched} мест`, `fetching tile ${Math.min(source.stepsDone + 1, source.stepsTotal || 1)} of ${source.stepsTotal || "…"} · ${source.fetched} places`);
      }
      if (source.phase === "saving") return t(`сохранение · ${source.fetched} событий`, `saving · ${source.fetched} events`);
      if (source.phase === "linking") return t("привязка мест OSM", "linking OSM places");
      return `${t("загрузка", "fetching")}${source.windowStart ? ` · ${formatDay(source.windowStart, language)}` : ""} · ${source.fetched}`;
    case "succeeded": if (kind === "dataset_delete") return t(`удалено ${count(source.fetched, language)} мест`, `${count(source.fetched, language)} places deleted`);
      return t(`+${count(source.inserted, language)} новых, ${count(source.updated, language)} обновлено`, `+${count(source.inserted, language)} new, ${count(source.updated, language)} updated`) + (source.errorCode === "window_truncated" ? t(" · часть окна обрезана", " · part of a window was truncated") : "");
    case "cancelled": return kind === "dataset_delete" ? t("отменено, данные не изменились", "cancelled; the data is unchanged") : t("отменён", "cancelled");
    // The wait for a cooldown is counted down live on the retry button, so the row names only the reason.
    case "failed": return source.errorCode === "import_cooldown" ? t("пауза между импортами этого источника", "this source is in its cooldown") : errorText(source.errorCode, source.retryAfterSeconds, t);
  }
}

function errorText(code: string | null, retryAfterSeconds: number | null, t: Translator): string {
  switch (code) {
    case "import_cooldown": return t(`пауза между импортами, повторите через ${Math.ceil((retryAfterSeconds ?? 60) / 60)} мин`, `cooldown, retry in ${Math.ceil((retryAfterSeconds ?? 60) / 60)} min`);
    case "import_running": return t("этот источник уже импортируется", "this source is already importing");
    case "upstream_timeout": return t("источник не ответил вовремя", "the source timed out");
    case "upstream_unavailable": return t("источник недоступен", "the source is unavailable");
    case "upstream_bad_request": return t("источник отклонил запрос", "the source rejected the request");
    case "upstream_malformed": return t("источник вернул некорректные данные", "the source returned malformed data");
    case "import_interrupted": return t("прерван перезапуском сервера", "interrupted by a server restart");
    case "import_disabled": return t("импорт из приложения выключен", "importing from the app is off");
    case "too_many_import_jobs": return t("уже идут три импорта, дождитесь их окончания", "three imports are already running; wait for them to finish");
    case "import_kind_busy": return t("уже идёт импорт области, дождитесь его окончания", "an area import is already running; wait for it to finish");
    case "area_too_large": return t("область слишком большая, выберите город поменьше", "the area is too large; choose a smaller city");
    case "file_too_large": return t("файл региона больше допустимого (OSM_REGION_MAX_BYTES)", "the region file exceeds the limit (OSM_REGION_MAX_BYTES)");
    case "osm_parse_failed": return t("не удалось разобрать файл региона", "the region file could not be parsed");
    case "dataset_busy": return t("с этим набором уже работает другая задача", "another job is already working on this dataset");
    case "dataset_not_deletable": return t("этот набор нельзя удалить", "this dataset cannot be deleted");
    case "unknown_region": return t("региона нет в каталоге Geofabrik", "the region is not in the Geofabrik catalogue");
    default: return t("импорт не удался", "the import failed");
  }
}

function count(value: number, language: Language): string {
  return value.toLocaleString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US");
}

function formatDay(iso: string, language: Language): string {
  return new Date(iso).toLocaleDateString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function formatDateTime(iso: string, language: Language): string {
  return new Date(iso).toLocaleString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Keeps an area within the server's limit by taking a square around its centre. */
function clampBbox(bbox: Bbox, maxSquareDegrees: number): Bbox {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if ((maxLon - minLon) * (maxLat - minLat) <= maxSquareDegrees) return bbox;
  const half = Math.sqrt(maxSquareDegrees) / 2 * 0.98;
  const lon = (minLon + maxLon) / 2;
  const lat = (minLat + maxLat) / 2;
  return [lon - half, lat - half, lon + half, lat + half].map((value) => Number(value.toFixed(5))) as Bbox;
}

function areaKm([minLon, minLat, maxLon, maxLat]: Bbox): number {
  const kmPerDegreeLat = 111.32;
  const kmPerDegreeLon = 111.32 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  return Math.round((maxLon - minLon) * kmPerDegreeLon * (maxLat - minLat) * kmPerDegreeLat);
}

function tileCount([minLon, minLat, maxLon, maxLat]: Bbox): number {
  return Math.ceil((maxLon - minLon) / AREA_TILE_DEGREES - 1e-9) * Math.ceil((maxLat - minLat) / AREA_TILE_DEGREES - 1e-9);
}

function categoryLabel(category: OsmAreaCategory, t: Translator): string {
  const labels: Record<OsmAreaCategory, [string, string]> = {
    attraction: ["Достопримечательности", "Attractions"], museum: ["Музеи", "Museums"], gallery: ["Галереи", "Galleries"], viewpoint: ["Смотровые", "Viewpoints"],
    monument: ["Памятники", "Monuments"], castle: ["Замки", "Castles"], church: ["Храмы", "Churches"], theatre: ["Театры", "Theatres"], park: ["Парки", "Parks"],
    restaurant: ["Рестораны", "Restaurants"], cafe: ["Кафе", "Cafés"], bar: ["Бары", "Bars"], hotel: ["Отели", "Hotels"], transport: ["Вокзалы", "Stations"],
  };
  return t(...labels[category]);
}

/** The dataset ID part the server derives from an area's name ("Kraków" → "krakow"), as osmAreaSourceId does. */
function areaSlug(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** A country's name in the interface language ("Польша" for "Poland"); other regions keep the catalogue's name. */
function regionTitle(region: GeofabrikRegion, language: Language): string {
  const country = region.isoCodes.find((code) => /^[A-Z]{2}$/.test(code));
  if (!country) return region.name;
  try {
    return new Intl.DisplayNames([language], { type: "region" }).of(country) ?? region.name;
  } catch {
    return region.name;
  }
}
