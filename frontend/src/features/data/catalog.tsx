import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLink, Loader2, MessageSquare, Search, X } from "lucide-react";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { useCachedQuery } from "../../shared/data-cache";
import { listCatalogCategories, listCatalogPlaces, listCountries, listSettlements, type CatalogFilter, type CatalogPlace, type CountryCoverage, type SettlementType } from "../imports/import-api";

/*
 * The place catalog shared by the data page and the map page: filters (country, city, category, text, map area),
 * the matching places page by page, and a card for one place.
 */

/** Filters of the catalog; a missing country means the scope's largest one. */
export interface Filters { country?: string; city?: string; category?: string; q?: string; bbox?: [number, number, number, number] | null }

/** After an import or deletion the server's one-minute caches are bypassed once, so the next load shows the change. */
let bypassServerCache = false;
export function bypassCatalogServerCache(): void {
  bypassServerCache = true;
  window.setTimeout(() => { bypassServerCache = false; }, 5_000);
}
export function catalogFresh(): boolean {
  return bypassServerCache;
}

/** Countries of the current scope: one dataset with its own counts, or all data. Largest first. */
export function useScopeCountries(datasetId?: string) {
  return useCachedQuery<CountryCoverage[]>(datasetId ? `data:countries:${datasetId}` : "data:countries", () => listCountries(bypassServerCache, undefined, datasetId), 5 * 60_000);
}

/** The catalog for one dataset (or all data by country) under these filters, with paging. */
export function useCatalog(datasetId: string | undefined, filters: Filters, onFilters: (change: Partial<Filters>) => void) {
  const countries = useScopeCountries(datasetId);
  const country = filters.country && countries.data?.some((item) => item.countryCode === filters.country) ? filters.country : countries.data?.[0]?.countryCode;
  const [query, setQuery] = useState(filters.q ?? "");
  useEffect(() => {
    const timer = window.setTimeout(() => { if ((filters.q ?? "") !== query.trim()) onFilters({ q: query.trim() || undefined }); }, 300);
    return () => window.clearTimeout(timer);
  }, [query, filters.q, onFilters]);
  // Nothing loads until the countries are known, so the first request already has the right country.
  const filter: CatalogFilter | null = countries.data && (country || datasetId) ? { dataset: datasetId, country, city: filters.city, category: filters.category, q: filters.q, bbox: filters.bbox } : null;
  const filterKey = filter ? JSON.stringify(filter) : null;
  const categories = useCachedQuery(filter ? `data:categories:${JSON.stringify({ ...filter, category: undefined })}` : null, () => listCatalogCategories(filter!), 5 * 60_000);
  const first = useCachedQuery(filterKey ? `data:places:${filterKey}` : null, () => listCatalogPlaces(filter!, null), 5 * 60_000);
  const [more, setMore] = useState<CatalogPlace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => { setMore([]); setCursor(null); }, [filterKey, first.data]);
  const rows = useMemo(() => [...(first.data?.places ?? []), ...more], [first.data, more]);
  const nextCursor = more.length ? cursor : first.data?.nextCursor ?? null;
  const loadMore = async () => {
    if (!nextCursor || !filter) return;
    setLoadingMore(true);
    try {
      const page = await listCatalogPlaces(filter, nextCursor);
      setMore((current) => [...current, ...page.places]);
      setCursor(page.nextCursor);
    } catch {
      // The button stays; the next click retries.
    } finally {
      setLoadingMore(false);
    }
  };
  return {
    datasetId, filters, onFilters, countries, country, query, setQuery, filterKey, categories, first, rows, nextCursor, loadMore, loadingMore,
    total: first.data?.total ?? null,
    hasFilters: Boolean(filters.city || filters.category || filters.q || filters.bbox),
    clear: () => { setQuery(""); onFilters({ city: undefined, category: undefined, q: undefined, bbox: null }); },
  };
}

export type Catalog = ReturnType<typeof useCatalog>;

/** Country, city, category, and text filters of the catalog. */
export function CatalogFilterBar({ language, catalog, onChange }: { language: Language; catalog: Catalog; onChange?: () => void }) {
  const t = makeT(language);
  const { countries, country, filters, onFilters, categories, query, setQuery, datasetId } = catalog;
  return <div className="data-filters">
    <label className="data-field">
      <span>{t("Страна", "Country")}</span>
      <select value={country ?? ""} onChange={(event) => { onFilters({ country: event.target.value, city: undefined, bbox: null }); onChange?.(); }}>
        {countries.data?.map((item) => <option key={item.countryCode} value={item.countryCode}>{countryName(item.countryCode, language)} · {compact(item.places, language)}</option>)}
      </select>
    </label>
    {country && <CityPicker key={`${datasetId ?? ""}|${country}`} language={language} country={country} datasetId={datasetId} value={filters.city} onChange={(city) => { onFilters({ city, bbox: null }); onChange?.(); }} />}
    <label className="data-field">
      <span>{t("Категория", "Category")}</span>
      <select value={filters.category ?? ""} onChange={(event) => { onFilters({ category: event.target.value || undefined }); onChange?.(); }}>
        <option value="">{t("Все категории", "All categories")}</option>
        {categories.data?.map((item) => <option key={item.category} value={item.category}>{categoryName(item.category, language)} · {count(item.places, language)}</option>)}
        {filters.category && !categories.data?.some((item) => item.category === filters.category) && <option value={filters.category}>{categoryName(filters.category, language)}</option>}
      </select>
    </label>
    <label className="data-field grow">
      <span>{t("Поиск", "Search")}</span>
      <span className="data-search"><Search size={13} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Название или улица", "Name or street")} /></span>
    </label>
  </div>;
}

/** How many places match, the active area filter, and a reset. */
export function CatalogStatus({ language, catalog, onChange }: { language: Language; catalog: Catalog; onChange?: () => void }) {
  const t = makeT(language);
  const { first, total, rows, filters, onFilters, hasFilters, clear } = catalog;
  return <div className="data-filter-state">
    <span className="data-list-meta">{first.loading ? t("Загружаю…", "Loading…") : total !== null ? t(`Найдено ${count(total, language)} · показано ${count(rows.length, language)}`, `${count(total, language)} found · ${count(rows.length, language)} shown`) : ""}{first.refreshing && <Loader2 size={12} className="spin" />}</span>
    {filters.bbox && <span className="data-filter-chip"><span>{t("В области карты", "In the map area")}</span><button type="button" onClick={() => onFilters({ bbox: null })} aria-label={t("Убрать область", "Clear the area")}><X size={11} /></button></span>}
    {hasFilters && <button type="button" className="data-link-button" onClick={() => { clear(); onChange?.(); }}>{t("Сбросить фильтры", "Clear filters")}</button>}
  </div>;
}

/** The matching places, a page at a time; `renderSelected` shows the chosen one under its row (on the map page). */
export function CatalogRows({ language, catalog, selectedId, onSelect, renderSelected }: { language: Language; catalog: Catalog; selectedId: string | null; onSelect(id: string | null): void; renderSelected?: (place: CatalogPlace) => ReactNode }) {
  const t = makeT(language);
  const { first, rows, nextCursor, loadMore, loadingMore } = catalog;
  return <div className="data-explorer-list">
    {first.error !== undefined && !first.data ? <p className="data-note error">{t("Не удалось загрузить записи.", "Could not load the records.")}</p>
      : !first.loading && !rows.length ? <p className="data-empty">{t("Ничего не нашлось. Измените фильтры.", "Nothing found. Change the filters.")}</p>
        : <ul className="data-rows">
          {rows.map((place) => <li key={place.id}>
            <button type="button" className={place.id === selectedId ? "active" : ""} aria-pressed={place.id === selectedId} onClick={() => onSelect(place.id === selectedId ? null : place.id)}>
              <strong title={place.name}>{place.name}</strong>
              <small>{[place.category ? categoryName(place.category, language) : null, place.city].filter(Boolean).join(" · ") || "—"}</small>
            </button>
            {place.id === selectedId && renderSelected?.(place)}
          </li>)}
        </ul>}
    {nextCursor && <button type="button" className="data-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? t("Загружаю…", "Loading…") : t("Показать ещё", "Show more")}</button>}
  </div>;
}

/** A city of the current country and dataset, found by typing; the largest come first. */
export function CityPicker({ language, country, datasetId, value, onChange }: { language: Language; country: string; datasetId?: string; value?: string; onChange(city: string | undefined): void }) {
  const t = makeT(language);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(text.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const types: SettlementType[] = ["city", "town", "village"];
  const options = useCachedQuery(open ? `data:settlements:${country}|${datasetId ?? ""}|${search}` : null, () => listSettlements({ country, dataset: datasetId, q: search, types, limit: 30, offset: 0 }), 5 * 60_000);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return <div className="data-field data-city" ref={box}>
    <span>{t("Город", "City")}</span>
    <div className="data-combo">
      <input
        value={open ? text : value ?? ""}
        placeholder={t("Все города", "All cities")}
        onFocus={() => { setOpen(true); setText(""); }}
        onChange={(event) => { setText(event.target.value); setOpen(true); }}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        aria-label={t("Город", "City")}
        aria-expanded={open}
      />
      {value && !open && <button type="button" onClick={() => onChange(undefined)} aria-label={t("Все города", "All cities")}><X size={11} /></button>}
    </div>
    {open && <ul className="data-combo-list" role="listbox">
      {options.loading && <li className="note">{t("Ищу…", "Searching…")}</li>}
      {options.data?.settlements.map((item) => <li key={item.id}>
        <button type="button" role="option" aria-selected={item.name === value} onClick={() => { onChange(item.name); setOpen(false); }}>
          <span><strong>{item.name}</strong>{item.nameEn && <small> · {item.nameEn}</small>}</span>
          <small>{settlementLabel(item.type, t, false)}{item.places ? ` · ${compact(item.places, language)}` : ""}</small>
        </button>
      </li>)}
      {options.data && !options.data.settlements.length && <li className="note">{t("Ничего не нашлось", "Nothing found")}</li>}
    </ul>}
  </div>;
}

/** The chosen place: what the snapshot says about it, with links, and a hand-off to the assistant. */
export function PlaceCard({ language, place, onClose, onAsk, floating = true }: { language: Language; place: CatalogPlace; onClose(): void; onAsk?: (place: CatalogPlace) => void; floating?: boolean }) {
  const t = makeT(language);
  const [, osmType, osmId] = place.id.split(":");
  const osmUrl = osmType && osmId && /^\d+$/.test(osmId) ? `https://www.openstreetmap.org/${osmType}/${osmId}` : null;
  const details = Object.entries(place.details).filter(([key]) => key !== "website" && key !== "wikidata" && key !== "tourism" && key !== "historic");
  const website = place.details.website && /^https?:\/\//i.test(place.details.website) ? place.details.website : null;
  const wikidata = place.details.wikidata && /^Q\d+$/.test(place.details.wikidata) ? place.details.wikidata : null;
  return <article className={floating ? "data-card-float" : "data-card-inline"} aria-label={place.name}>
    <header>
      <div><strong>{place.name}</strong><small>{place.category ? categoryName(place.category, language) : "—"}</small></div>
      <button type="button" className="data-icon-button small" onClick={onClose} aria-label={t("Закрыть", "Close")}><X size={12} /></button>
    </header>
    <dl>
      {address(place) && <div><dt>{t("Адрес", "Address")}</dt><dd>{address(place)}</dd></div>}
      {details.map(([key, value]) => <div key={key}><dt>{detailLabel(key, t)}</dt><dd>{value}</dd></div>)}
      <div><dt>{t("Координаты", "Coordinates")}</dt><dd>{place.lat.toFixed(5)}, {place.lon.toFixed(5)}</dd></div>
    </dl>
    <footer>
      {website && <a href={website} target="_blank" rel="noreferrer noopener"><ExternalLink size={11} />{t("Сайт", "Website")}</a>}
      {wikidata && <a href={`https://www.wikidata.org/wiki/${wikidata}`} target="_blank" rel="noreferrer noopener"><ExternalLink size={11} />Wikidata</a>}
      {osmUrl && <a href={osmUrl} target="_blank" rel="noreferrer noopener"><ExternalLink size={11} />OpenStreetMap</a>}
      <button type="button" onClick={() => onAsk ? onAsk(place) : window.dispatchEvent(new CustomEvent("waypoint:show-place", { detail: { ...place, sourceId: place.datasetId } }))}><MessageSquare size={11} />{t("Спросить ассистента", "Ask the assistant")}</button>
    </footer>
  </article>;
}

function detailLabel(key: string, t: Translator): string {
  const labels: Record<string, [string, string]> = {
    opening_hours: ["Часы работы", "Opening hours"], cuisine: ["Кухня", "Cuisine"], wheelchair: ["Доступ для колясок", "Wheelchair"], description: ["Описание", "Description"],
    fee: ["Плата", "Fee"], internet_access: ["Интернет", "Internet"], aeroway: ["Авиа", "Aeroway"], iata: ["IATA", "IATA"], icao: ["ICAO", "ICAO"],
  };
  return labels[key] ? t(...labels[key]) : key;
}

export function settlementLabel(type: SettlementType, t: Translator, plural: boolean): string {
  const labels: Record<SettlementType, [string, string, string, string]> = {
    city: ["Города", "Cities", "город", "city"],
    town: ["Посёлки", "Towns", "посёлок", "town"],
    village: ["Деревни", "Villages", "деревня", "village"],
  };
  const [ruPlural, enPlural, ru, en] = labels[type];
  return plural ? t(ruPlural, enPlural) : t(ru, en);
}

/** OpenStreetMap categories ("tourism:museum") in plain words; unknown ones show their value. */
const CATEGORY_NAMES: Record<string, [string, string]> = {
  "tourism:museum": ["Музей", "Museum"], "tourism:gallery": ["Галерея", "Gallery"], "tourism:attraction": ["Достопримечательность", "Attraction"], "tourism:viewpoint": ["Смотровая площадка", "Viewpoint"],
  "tourism:hotel": ["Отель", "Hotel"], "tourism:hostel": ["Хостел", "Hostel"], "tourism:guest_house": ["Гостевой дом", "Guest house"], "tourism:information": ["Инфопункт", "Information"], "tourism:artwork": ["Арт-объект", "Artwork"],
  "historic:monument": ["Памятник", "Monument"], "historic:memorial": ["Мемориал", "Memorial"], "historic:castle": ["Замок", "Castle"], "historic:ruins": ["Руины", "Ruins"], "historic:wayside_cross": ["Придорожный крест", "Wayside cross"],
  "amenity:restaurant": ["Ресторан", "Restaurant"], "amenity:cafe": ["Кафе", "Café"], "amenity:bar": ["Бар", "Bar"], "amenity:pub": ["Паб", "Pub"], "amenity:fast_food": ["Фастфуд", "Fast food"],
  "amenity:place_of_worship": ["Храм", "Place of worship"], "amenity:theatre": ["Театр", "Theatre"], "amenity:school": ["Школа", "School"], "amenity:pharmacy": ["Аптека", "Pharmacy"], "amenity:parking": ["Парковка", "Parking"],
  "leisure:park": ["Парк", "Park"], "leisure:playground": ["Детская площадка", "Playground"], "leisure:pitch": ["Спортплощадка", "Sports pitch"], "natural:peak": ["Вершина", "Peak"], "natural:spring": ["Родник", "Spring"],
  "public_transport:stop_position": ["Остановка", "Stop position"], "public_transport:platform": ["Платформа", "Platform"], "railway:station": ["Вокзал", "Station"], "aeroway:aerodrome": ["Аэродром", "Aerodrome"],
  "place:city": ["Город", "City"], "place:town": ["Посёлок", "Town"], "place:village": ["Деревня", "Village"], "place:hamlet": ["Хутор", "Hamlet"], "place:suburb": ["Район", "Suburb"], "place:locality": ["Местность", "Locality"],
  address: ["Адрес", "Address"], "shop:supermarket": ["Супермаркет", "Supermarket"], "shop:bakery": ["Пекарня", "Bakery"],
};

export function categoryName(category: string, language: Language): string {
  const known = CATEGORY_NAMES[category];
  if (known) return language === "ru" ? known[0] : known[1];
  const value = category.includes(":") ? category.slice(category.indexOf(":") + 1) : category;
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function address(place: CatalogPlace): string {
  return [[place.street, place.houseNumber].filter(Boolean).join(" "), [place.postcode, place.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

export function countryName(code: string, language: Language): string {
  try {
    return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function locale(language: Language): string {
  return language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US";
}

export function count(value: number, language: Language): string {
  return value.toLocaleString(locale(language));
}

/** Short counts for narrow columns: 374 882 → 375 тыс. */
export function compact(value: number, language: Language): string {
  return new Intl.NumberFormat(locale(language), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

