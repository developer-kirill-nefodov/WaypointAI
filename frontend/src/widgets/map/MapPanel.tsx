import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowUpRight, ChevronDown, Clock3, Map as MapIcon, MapPin, MessageSquare, Navigation, Route, RotateCw, X } from "lucide-react";
import { Circle, CircleMarker, GeoJSON as LeafletGeoJSON, MapContainer, Marker, Polygon, Popup, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { divIcon, latLng, latLngBounds, TileLayer as LeafletTileLayer, type LatLngBounds, type LeafletEvent, type Map as LeafletMap } from "leaflet";
import type { PlaceView, RecordView, SourceView, TripPlan } from "@waypoint-ai/shared";
import type { Feature, Geometry } from "geojson";
import { buildRoute } from "../../shared/api/client";
import { formatKm, translate, type Language } from "../../shared/i18n";
import "leaflet/dist/leaflet.css";
import MapResultsPanel from "./MapResultsPanel";
import RouteLayer, { RouteGeometry, type RoutePoint, type RouteState } from "./RouteLayer";
import { visitedAreaOutline } from "./visited-area";
import { CellCache, cellsForBounds, collectCells, MIN_PLACES_ZOOM, PLACES_PER_CELL, type Cell } from "./viewport-places";

type MapPlace = PlaceView;
type PlacesResponse = { total: number; places: MapPlace[] };
type MapItem = { key: string; id: string; sourceId: string; name: string; category: string | null; lat: number; lon: number; kind: "place" | "record"; place?: PlaceView; record?: RecordView; summary?: string };

const apiBase = import.meta.env.VITE_API_BASE ?? "";
/** The OpenStreetMap tile layer serves up to zoom 18; closer zoom showed an empty map. */
const MAX_MAP_ZOOM = 18;
const tileUrl = import.meta.env.VITE_MAP_TILES_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** Map-area places, cached per grid cell for the session; one ring of cells beyond the screen is preloaded. */
const placeCells = new CellCache();
const loadingCells = new Map<string, Promise<void>>();

function ViewportPlaces({ onPlaces, sourceIds, enabled }: { onPlaces: (places: MapPlace[], total: number) => void; sourceIds: string[]; enabled: boolean }) {
  const map = useMap();
  const sourceFilter = sourceIds.join(",");
  useEffect(() => {
    let active = true;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let visibleCells: Cell[] = [];
    if (!enabled) {
      onPlaces([], 0);
      return () => { active = false; };
    }
    // Points already on screen stay until their replacement is known, so panning never blanks the map.
    const show = () => {
      if (!active) return;
      const { places, total } = collectCells(visibleCells, placeCells);
      const complete = visibleCells.every((cell) => placeCells.get(cell.key));
      if (places.length || complete) onPlaces(places, total);
    };
    const fetchCell = (cell: Cell) => {
      if (placeCells.get(cell.key)) return;
      if (!loadingCells.has(cell.key)) {
        const url = new URL(`${apiBase}/api/v1/data/places`, window.location.origin);
        url.searchParams.set("bbox", cell.bbox.map((value) => value.toFixed(6)).join(","));
        url.searchParams.set("limit", String(PLACES_PER_CELL));
        if (sourceFilter) url.searchParams.set("sourceIds", sourceFilter);
        loadingCells.set(cell.key, fetch(url)
          .then((response) => { if (!response.ok) throw new Error("Places are unavailable"); return response.json() as Promise<PlacesResponse>; })
          .then((result) => placeCells.set(cell.key, { total: result.total, places: result.places }))
          .catch(() => undefined)
          .finally(() => { loadingCells.delete(cell.key); }));
      }
      void loadingCells.get(cell.key)!.then(show);
    };
    const load = () => {
      const zoom = map.getZoom();
      if (zoom < MIN_PLACES_ZOOM) {
        visibleCells = [];
        onPlaces([], 0);
        return;
      }
      const toBounds = (bounds: LatLngBounds) => ({ west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() });
      visibleCells = cellsForBounds(toBounds(map.getBounds()), zoom, sourceFilter);
      show();
      for (const cell of cellsForBounds(toBounds(map.getBounds().pad(0.3)), zoom, sourceFilter)) fetchCell(cell);
    };
    const schedule = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(load, 120); };
    map.on("moveend", schedule);
    schedule();
    return () => {
      active = false;
      if (debounce) clearTimeout(debounce);
      map.off("moveend", schedule);
    };
  }, [enabled, map, onPlaces, sourceFilter]);
  return null;
}

// Overlay colors are chosen to stay distinct from orange events, green places, and the green basemap.
const RADIUS_COLOR = "#2f7cf6";
const COUNTRY_BORDER_COLOR = "#a855f7";

export type SearchRadius = {
  lat: number;
  lon: number;
  radiusKm: number;
  label: string;
};

/** A point to center on; the revision changes for every request, including the same point twice. */
export type MapFocusPoint = {
  lat: number;
  lon: number;
  revision: number;
};

/** Source mode per record source ID; "unverified" when the source metadata is missing. */
export type RecordSourceModes = Record<string, SourceView["mode"] | "unverified">;

/**
 * Runs a view change now, or, while the map is hidden because another map mode is shown, once it is shown again:
 * Leaflet cannot fit bounds to a container of size zero. Returns the effect's cleanup, which drops a pending change.
 */
function whenVisible(map: LeafletMap, change: () => void): () => void {
  const container = map.getContainer();
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    change();
    return () => undefined;
  }
  const observer = new ResizeObserver(() => {
    if (!container.clientWidth || !container.clientHeight) return;
    observer.disconnect();
    map.invalidateSize({ animate: false, pan: false });
    change();
  });
  observer.observe(container);
  return () => observer.disconnect();
}

/** Width the results panel covers on the right of a wide map, plus a gap. */
const RESULTS_PANEL_INSET_PX = 392;

/** Fit padding that keeps the framed points clear of the results panel when it lies over the map's right side. */
function fitPadding(map: LeafletMap, base: number): { paddingTopLeft: [number, number]; paddingBottomRight: [number, number] } {
  const container = map.getContainer();
  const covered = container.closest(".map-canvas")?.classList.contains("with-results-panel") && container.clientWidth > 2 * RESULTS_PANEL_INSET_PX;
  return { paddingTopLeft: [base, base], paddingBottomRight: [base + (covered ? RESULTS_PANEL_INSET_PX : 0), base] };
}

/** Draws the applied search radius and fits the map to it whenever the radius or its center changes. */
function RadiusOverlay({ radius, language }: { radius: SearchRadius; language: Language }) {
  const map = useMap();
  const signature = `${radius.lat},${radius.lon},${radius.radiusKm}`;
  useEffect(() => whenVisible(map, () => {
    const bounds = latLng(radius.lat, radius.lon).toBounds(radius.radiusKm * 2000);
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16, animate: false });
    map.getContainer().scrollIntoView({ block: "nearest", behavior: "smooth" });
    // The signature captures every value the fit depends on.
  }), [map, signature]);
  const center: [number, number] = [radius.lat, radius.lon];
  const label = radius.label
    ? `${formatKm(radius.radiusKm, language)} · ${radius.label}`
    : formatKm(radius.radiusKm, language);
  return (
    <>
      <Circle
        center={center}
        radius={radius.radiusKm * 1000}
        interactive={false}
        pathOptions={{ color: RADIUS_COLOR, weight: 2.5, opacity: 0.95, fillColor: RADIUS_COLOR, fillOpacity: 0.07 }}
      />
      <CircleMarker
        center={center}
        radius={4}
        interactive={false}
        pathOptions={{ color: "#ffffff", weight: 2, fillColor: RADIUS_COLOR, fillOpacity: 1 }}
      >
        <Tooltip permanent direction="top" offset={[0, -6]} className="radius-label">{label}</Tooltip>
      </CircleMarker>
    </>
  );
}

type VisitedArea = { city: string; points: RoutePoint[]; days: number[] };

/** Outlines the area each city's stops cover, in the radius color, labelled as visited places rather than a border. */
function VisitedAreas({ areas, language }: { areas: VisitedArea[]; language: Language }) {
  const t = (ru: string, en: string) => translate(language, ru, en);
  return <>{areas.map((area) => {
    const outline = visitedAreaOutline(area.points);
    if (outline.length < 3) return null;
    const dayLabel = area.days.length === 1 ? `${t("день", "day")} ${area.days[0]}` : `${t("дни", "days")} ${area.days[0]}–${area.days[area.days.length - 1]}`;
    // The label sits on the outline's northern edge so it does not cover the stops inside.
    const top = outline.reduce((north, point) => point[0] > north[0] ? point : north);
    return <Fragment key={area.city}>
      <Polygon positions={outline} interactive={false} pathOptions={{ color: RADIUS_COLOR, weight: 2, opacity: 0.9, fillColor: RADIUS_COLOR, fillOpacity: 0.07, dashArray: "6 4" }} />
      <CircleMarker center={top} radius={0} interactive={false} pathOptions={{ opacity: 0, fillOpacity: 0 }}>
        <Tooltip permanent direction="top" offset={[0, -4]} className="radius-label">{area.city} · {dayLabel} · {area.points.length} {t("мест", "places")}</Tooltip>
      </CircleMarker>
    </Fragment>;
  })}</>;
}

/** Centers the map on a point chosen from the details dialog; the revision re-centers on repeated requests. */
function FocusPoint({ focus }: { focus: MapFocusPoint }) {
  const map = useMap();
  useEffect(() => whenVisible(map, () => {
    // The map may have just become visible (a page switch); measure it before centering.
    map.invalidateSize({ animate: false });
    map.setView([focus.lat, focus.lon], Math.max(map.getZoom(), 14), { animate: true });
    // On narrow screens the map sits below the list; bring it into view after the dialog closes.
    map.getContainer().scrollIntoView({ block: "nearest", behavior: "smooth" });
    // The revision changes for every request, including the same point twice.
  }), [map, focus.revision]);
  return null;
}

/** Investigation view: frame the selected event together with its linked places instead of zooming to street level. */
function FitToSelection({ selected, places }: { selected: MapItem | undefined; places: PlaceView[] }) {
  const map = useMap();
  const signature = selected ? `${selected.key}|${places.map((place) => place.id).join(",")}` : "";
  useEffect(() => {
    if (!selected) return;
    return whenVisible(map, () => {
      const points: Array<[number, number]> = [
        [selected.lat, selected.lon],
        ...places.map((place): [number, number] => [place.lat, place.lon]),
      ];
      if (points.length === 1) {
        map.setView(points[0]!, Math.max(map.getZoom(), 11), { animate: false });
        return;
      }
      map.fitBounds(latLngBounds(points), { padding: [48, 48], maxZoom: 14, animate: false });
    });
    // The signature captures the selection and the loaded places.
  }, [map, signature]);
  return null;
}

function ZoomLevel({ onZoom, selected }: { onZoom: (zoom: number) => void; selected: MapItem | undefined }) {
  // Stable handlers: useMapEvents re-subscribes when the object changes, and a zoom fired by a sibling's
  // fit effect during that re-subscription was lost, leaving the zoom label stale.
  const handlers = useMemo(() => ({
    zoomend: (event: LeafletEvent) => onZoom((event.target as LeafletMap).getZoom()),
  }), [onZoom]);
  const map = useMapEvents(handlers);
  useEffect(() => onZoom(map.getZoom()), [map, onZoom]);
  const selectedKey = selected?.key;
  const selectedLat = selected?.lat;
  const selectedLon = selected?.lon;
  useEffect(() => {
    if (selectedKey && selectedLat !== undefined && selectedLon !== undefined) {
      return whenVisible(map, () => map.setView([selectedLat, selectedLon], Math.max(map.getZoom(), 15), { animate: false }));
    }
  }, [map, selectedKey, selectedLat, selectedLon]);
  return null;
}

function recordItem(record: RecordView): MapItem {
  return {
    key: `record:${record.id}`, id: record.id, sourceId: record.sourceId, name: record.label, category: typeof record.attributes.category === "string" ? record.attributes.category : null,
    lat: record.lat, lon: record.lon, kind: "record", record,
    summary: `${record.observedAt}${typeof record.attributes.place === "object" && record.attributes.place && "name" in record.attributes.place ? ` · ${String(record.attributes.place.name)}` : ""}`,
  };
}

/** Records from a source that is neither live nor a public snapshot (synthetic or unverified) get a dashed outline. */
function isUnverifiedRecord(item: MapItem, recordSourceModes: RecordSourceModes): boolean {
  if (item.kind !== "record") return false;
  const mode = recordSourceModes[item.sourceId];
  return Boolean(mode) && mode !== "approved_live" && mode !== "public_snapshot";
}

function FitToResults({ items, onFitted }: { items: MapItem[]; onFitted?: () => void }) {
  const map = useMap();
  const resultSignature = items.map((item) => `${item.key}:${item.lat},${item.lon}`).join("|");
  useEffect(() => {
    if (!items.length) return;
    const bounds = latLngBounds(items.map((item) => [item.lat, item.lon] as [number, number]));
    if (!bounds.isValid()) return;
    return whenVisible(map, () => {
      if (items.length === 1 || bounds.getNorthEast().equals(bounds.getSouthWest())) {
        const item = items[0]!;
        map.setView([item.lat, item.lon], Math.max(map.getZoom(), 15), { animate: false });
      } else {
        map.fitBounds(bounds, { ...fitPadding(map, 42), maxZoom: 14, animate: false });
      }
      onFitted?.();
    });
    // The point signature keeps viewport-only place fetches from resetting the user's map.
  }, [map, resultSignature]);
  return null;
}

function ResetViewport({ revision }: { revision: number }) {
  const map = useMap();
  useEffect(() => {
    if (revision > 0) return whenVisible(map, () => map.setView([49.8, 15.5], 4, { animate: false }));
  }, [map, revision]);
  return null;
}

/** Longest the first-load cover stays while the map is on screen (the server or the tile provider may not answer). */
const MAP_LOADER_TIMEOUT_MS = 8_000;
/** Shortest time the cover is shown, so a fast load does not flash it. */
const MAP_LOADER_MIN_MS = 450;

/**
 * Reports when the map first shows its real view: the data it frames is in and fitted (`dataReady`), and the tiles of
 * that view have loaded. Until then a cover hides the default view and the jump to the results.
 */
function LoadGate({ dataReady, onReady }: { dataReady: boolean; onReady: () => void }) {
  const map = useMap();
  useEffect(() => {
    let timer = 0;
    const cancel = whenVisible(map, () => { timer = window.setTimeout(onReady, MAP_LOADER_TIMEOUT_MS); });
    return () => { cancel(); window.clearTimeout(timer); };
  }, [map, onReady]);
  useEffect(() => {
    if (!dataReady) return;
    let tiles: LeafletTileLayer | null = null;
    map.eachLayer((layer) => { if (layer instanceof LeafletTileLayer) tiles = layer; });
    const layer = tiles as LeafletTileLayer | null;
    if (!layer) {
      onReady();
      return;
    }
    // The fit has just moved the map; Leaflet requests that view's tiles on the next frame.
    const frame = window.requestAnimationFrame(() => { if (!layer.isLoading()) onReady(); });
    layer.on("load", onReady);
    return () => {
      window.cancelAnimationFrame(frame);
      layer.off("load", onReady);
    };
  }, [map, dataReady, onReady]);
  return null;
}

/** How long the wave over a newly selected item lasts; the selection stays marked afterwards. */
const SELECTION_PULSE_MS = 2_400;
const selectionPulseIcon = divIcon({ className: "map-select-pulse", html: "<span></span><span></span><i></i>", iconSize: [96, 96], iconAnchor: [48, 48] });

/** A request to wave over one item; every click makes a new revision, so selecting the same item again replays it. */
export type PulseRequest = { key: string; revision: number };

/**
 * A short wave over the item just selected (a marker, a result or stop in the panel, a row in a side panel, or a
 * citation). It plays once per request, as soon as the item is on the map.
 */
function SelectionPulse({ request, items }: { request: PulseRequest | null; items: MapItem[] }) {
  const [pulse, setPulse] = useState<{ lat: number; lon: number; revision: number } | null>(null);
  const played = useRef<number | null>(null);
  const item = request ? items.find((candidate) => candidate.key === request.key) : undefined;
  const ready = Boolean(item);
  useEffect(() => {
    if (!request || !item || played.current === request.revision) return;
    played.current = request.revision;
    setPulse({ lat: item.lat, lon: item.lon, revision: request.revision });
    // The timer is not cleared when the items change: the wave runs its course and then goes.
    window.setTimeout(() => setPulse((current) => (current?.revision === request.revision ? null : current)), SELECTION_PULSE_MS);
    // A request plays once its item is on the map; the items list changes with every render of the results.
  }, [request?.revision, ready]);
  if (!pulse) return null;
  return <Marker key={pulse.revision} position={[pulse.lat, pulse.lon]} icon={selectionPulseIcon} interactive={false} keyboard={false} zIndexOffset={1000} />;
}

function MapSizeObserver() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false, pan: false, debounceMoveend: true }));
    observer.observe(container);
    map.invalidateSize({ animate: false, pan: false, debounceMoveend: true });
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function FitToFocus({ focusKey, requestRevision, points, routePlan }: { focusKey: string | null; requestRevision: number; points: RoutePoint[]; routePlan: RouteState["plan"] }) {
  const map = useMap();
  const signature = `${focusKey ?? ""}:${requestRevision}:${points.map((point) => `${point.id}:${point.lat},${point.lon}`).join("|")}:${routePlan?.geometry.coordinates.map(([lon, lat]) => `${lon},${lat}`).join("|") ?? ""}`;
  useEffect(() => {
    if (!focusKey || !points.length) return;
    return whenVisible(map, () => {
      map.invalidateSize({ animate: false, pan: false, debounceMoveend: true });
      const coordinates = [
        ...points.map((point) => [point.lat, point.lon] as [number, number]),
        ...(routePlan?.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]) ?? []),
      ];
      const bounds = latLngBounds(coordinates);
      if (!bounds.isValid()) return;
      if (coordinates.length === 1 || bounds.getNorthEast().equals(bounds.getSouthWest())) {
        map.setView(coordinates[0]!, Math.max(map.getZoom(), 14), { animate: true });
        return;
      }
      map.fitBounds(bounds, { ...fitPadding(map, 48), maxZoom: 13, animate: true });
    });
  }, [map, signature]);
  return null;
}

type MapPanelProps = {
  language?: Language;
  highlights?: PlaceView[];
  records?: RecordView[];
  tripPlan?: TripPlan | null;
  sourceIds?: string[];
  selectedResultKey: string | null;
  onSelectResult: (key: string) => void;
  sourceLabels?: Record<string, string>;
  sourceDates?: Record<string, string>;
  resultsLoaded?: boolean;
  resetViewportRevision?: number;
  /** "investigation" shows only markers; the page renders its own table and details. */
  variant?: "assistant" | "investigation";
  recordSourceModes?: RecordSourceModes;
  radius?: SearchRadius | null;
  focus?: MapFocusPoint | null;
  /** A place or event handed over from another panel or page; it is shown and centered but is not a query result. */
  pinned?: { place?: PlaceView; record?: RecordView; revision: number } | null;
  /** Events drawn as a background layer (not query results): they are not framed or listed. */
  overlayRecords?: RecordView[];
  /** Which markers the view frames: every result, or only the records (the events panel keeps its linked places out). */
  fit?: "results" | "records";
  /** Map layers the user can switch; omitted, the switches are hidden. */
  layers?: MapLayers;
  onLayers?: (layers: MapLayers) => void;
  heading?: { eyebrow: string; title: string };
  /** A selection made outside the map (a list row, a citation); a new revision replays the wave on the same item. */
  pulse?: PulseRequest | null;
  /** Hands the selected item to the assistant. */
  onAsk?: (item: { kind: "place" | "record"; id: string; name: string }) => void;
};

export type MapLayers = { places: boolean; events: boolean };

export default function MapPanel({
  language = "en",
  highlights = [],
  records = [],
  tripPlan = null,
  sourceIds = [],
  selectedResultKey,
  onSelectResult,
  sourceLabels = {},
  sourceDates = {},
  resultsLoaded = false,
  resetViewportRevision = 0,
  variant = "assistant",
  recordSourceModes = {},
  radius = null,
  focus = null,
  pinned = null,
  overlayRecords = [],
  fit,
  layers,
  onLayers,
  heading,
  pulse = null,
  onAsk,
}: MapPanelProps) {
  const investigation = variant === "investigation";
  const [places, setPlaces] = useState<MapPlace[]>([]);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(4);
  const [routeState, setRouteState] = useState<RouteState>({ status: "idle", plan: null, orderedPoints: [] });
  const [routeExpanded, setRouteExpanded] = useState(false);
  const [routeRetryKey, setRouteRetryKey] = useState(0);
  // A road route through plain search results is built only on request; trip plans route their days themselves.
  const [routeRequested, setRouteRequested] = useState(false);
  const [dayRouteRetryKeys, setDayRouteRetryKeys] = useState<Record<number, number>>({});
  const [dayRouteStates, setDayRouteStates] = useState<Record<number, RouteState>>({});
  const [focusedDay, setFocusedDay] = useState<number | "city" | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const [countryShapes, setCountryShapes] = useState<Record<string, Feature<Geometry> | null>>({});
  // The first answer of the viewport places (or "none here") is part of the map's first load.
  const [placesSettled, setPlacesSettled] = useState(false);
  const handlePlaces = useCallback((next: MapPlace[], count: number) => { setPlaces(next); setTotal(count); setPlacesSettled(true); }, []);
  const handleZoom = useCallback((next: number) => setZoom(next), []);
  const handleRouteState = useCallback((next: RouteState) => setRouteState(next), []);
  const mapItems = useMemo((): MapItem[] => [...new Map([
    ...places.map((place): MapItem => ({ ...place, key: `place:${place.id}`, kind: "place", place })),
    ...highlights.map((place): MapItem => ({ ...place, key: `place:${place.id}`, kind: "place", place })),
    ...(pinned?.place ? [{ ...pinned.place, key: `place:${pinned.place.id}`, kind: "place", place: pinned.place } satisfies MapItem] : []),
    ...[...overlayRecords, ...(pinned?.record ? [pinned.record] : [])].map((record): MapItem => recordItem(record)),
    ...records.map((record): MapItem => recordItem(record)),
  ].map((item) => [item.key, item])).values()], [highlights, overlayRecords, pinned, places, records]);
  // Query results: the records and highlighted places; background events and the viewport places are not.
  const resultItems = useMemo(() => {
    const ids = new Set([...records.map((record) => `record:${record.id}`), ...highlights.map((place) => `place:${place.id}`)]);
    return mapItems.filter((item) => ids.has(item.key));
  }, [highlights, mapItems, records]);
  const selectedItem = useMemo(() => mapItems.find((item) => item.key === selectedResultKey), [mapItems, selectedResultKey]);
  // Every selection waves over its item on the map, including the same item clicked again.
  const [pulseRequest, setPulseRequest] = useState<PulseRequest | null>(null);
  const select = useCallback((key: string) => {
    setPulseRequest({ key, revision: performance.now() });
    onSelectResult(key);
  }, [onSelectResult]);
  const selectPlace = useCallback((id: string) => select(`place:${id}`), [select]);
  // A click on a marker of a side panel's map comes back from that panel as its own request; one wave is enough.
  useEffect(() => {
    if (pulse) setPulseRequest((current) => (current?.key === pulse.key && Math.abs(pulse.revision - current.revision) < 400 ? current : pulse));
  }, [pulse]);
  // A selection that arrives without a request (an item handed over from another page) waves too.
  useEffect(() => {
    if (selectedResultKey) setPulseRequest((current) => (current?.key === selectedResultKey ? current : { key: selectedResultKey, revision: performance.now() }));
  }, [selectedResultKey]);
  // The card of the selected item floats over the map; closing it hides it until another item is selected.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  useEffect(() => { setDismissedKey(null); }, [selectedResultKey, pinned?.revision]);
  const countryCodes = useMemo(() => [...new Set(highlights.map((place) => place.countryCode).filter((code): code is string => Boolean(code)))], [highlights]);
  useEffect(() => {
    let active = true;
    if (!countryCodes.length) return () => { active = false; };
    void import("./countryBoundaries").then(({ countryBoundary }) => {
      if (active) setCountryShapes(Object.fromEntries(countryCodes.map((code) => [code, countryBoundary(code)])));
    });
    return () => { active = false; };
  }, [countryCodes]);
  const countryBoundaries = countryCodes.map((code) => ({ code, feature: countryShapes[code] ?? null })).filter((item): item is { code: string; feature: Feature<Geometry> } => Boolean(item.feature));
  const routeCandidates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const place of highlights) if (place.countryCode) counts.set(place.countryCode, (counts.get(place.countryCode) ?? 0) + 1);
    const dominantCountry = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (!dominantCountry) return { points: [] as RoutePoint[], total: 0 };
    const distinct = [...new Map(highlights.filter((place) => place.countryCode === dominantCountry).map((place) => [place.id, place])).values()];
    return {
      points: distinct.slice(0, 8).map((place): RoutePoint => ({ id: place.id, name: place.name, lat: place.lat, lon: place.lon, countryCode: place.countryCode!, city: place.city })),
      total: distinct.length,
    };
  }, [highlights]);
  const routePoints = routeCandidates.points;
  const routeSignature = routePoints.map((point) => point.id).join(",");
  useEffect(() => { setRouteRequested(false); }, [routeSignature]);
  const tripPlacesById = useMemo(() => new Map(highlights.map((place) => [place.id, place])), [highlights]);
  const tripRouteInputs = useMemo(() => tripPlan?.days.map((day) => {
    const places = day.stopPlaceIds.flatMap((id) => {
      const place = tripPlacesById.get(id);
      return place ? [{ id: place.id, name: place.name, lat: place.lat, lon: place.lon, countryCode: place.countryCode ?? tripPlan.countryCode, city: place.city }] : [];
    });
    const points: RoutePoint[] = day.area === "airport_radius" && tripPlan.airport
      ? [{ id: tripPlan.airport.placeId, name: tripPlan.airport.name, lat: tripPlan.airport.lat, lon: tripPlan.airport.lon, countryCode: tripPlan.countryCode, city: tripPlan.city }, ...places]
      : places;
    return { day: day.day, area: day.area, city: day.city ?? tripPlan.city, points, routeStatus: day.routeStatus };
  }) ?? [], [tripPlan, tripPlacesById]);
  const visitedAreas = useMemo(() => {
    const byCity = new Map<string, VisitedArea>();
    for (const route of tripRouteInputs) {
      if (route.area !== "city") continue;
      const area = byCity.get(route.city) ?? { city: route.city, points: [], days: [] };
      area.points.push(...route.points.filter((point) => !area.points.some((known) => known.id === point.id)));
      area.days.push(route.day);
      byCity.set(route.city, area);
    }
    return [...byCity.values()];
  }, [tripRouteInputs]);
  const focusPoints = useMemo(() => {
    if (focusedDay === "city") return tripRouteInputs.filter((route) => route.area === "city").flatMap((route) => route.points);
    if (focusedDay === null) return [];
    const route = tripRouteInputs.find((item) => item.day === focusedDay);
    const routedPoints = dayRouteStates[focusedDay]?.status === "ready" ? dayRouteStates[focusedDay]!.orderedPoints : null;
    return routedPoints ?? route?.points ?? [];
  }, [dayRouteStates, focusedDay, tripRouteInputs]);
  const focusRoute = focusedDay === "city"
    ? null
    : focusedDay === null ? null : dayRouteStates[focusedDay]?.plan ?? null;
  const focusedPlaceIds = useMemo(() => new Set(focusPoints.map((point) => point.id)), [focusPoints]);
  const focusedPlaceOrder = useMemo(() => new Map(focusPoints.map((point, index) => [point.id, index + 1])), [focusPoints]);
  useEffect(() => { setDayRouteStates({}); setDayRouteRetryKeys({}); setFocusedDay(null); }, [tripPlan]);
  const handleDayRouteState = useCallback((day: number, state: RouteState) => {
    setDayRouteStates((current) => current[day]?.status === state.status && current[day]?.plan === state.plan ? current : { ...current, [day]: state });
  }, []);
  const t = (ru: string, en: string) => translate(language, ru, en);
  const toolbarEyebrow = heading?.eyebrow ?? (investigation
    ? t("СОБЫТИЯ · OPENSTREETMAP", "EVENTS · OPENSTREETMAP")
    : "OPENSTREETMAP");
  const toolbarTitle = heading?.title ?? (investigation
    ? t("События и места рядом", "Events and nearby places")
    : t("Места и адреса", "Places and addresses"));
  // In the events view, nearby-place highlights must not refit the whole result set.
  const fitItems = (fit ?? (investigation ? "records" : "results")) === "records" ? resultItems.filter((item) => item.kind === "record") : resultItems;
  // The first load is covered until the real view is ready: the events and places maps wait for their first results,
  // and a map with results waits for its fit, so the default view of Europe and the jump to the results are never seen.
  // The assistant map also waits for what it draws at once: the road route of every day of a trip plan, or the first
  // viewport places. The cover stays at least MAP_LOADER_MIN_MS so it never flashes.
  const [fitted, setFitted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [coverGone, setCoverGone] = useState(false);
  const mountedAt = useRef(performance.now());
  const markFitted = useCallback(() => setFitted(true), []);
  const markLoaded = useCallback(() => {
    const wait = MAP_LOADER_MIN_MS - (performance.now() - mountedAt.current);
    if (wait > 0) window.setTimeout(() => setLoaded(true), wait);
    else setLoaded(true);
  }, []);
  const routesSettled = !tripPlan || tripPlan.travelMode === "none" || tripRouteInputs.every((route) => route.routeStatus !== "pending" || ["ready", "error"].includes(dayRouteStates[route.day]?.status ?? ""));
  const viewportPlacesShown = !investigation && resultItems.length === 0 && (layers?.places ?? true);
  const dataReady = (!investigation || resultsLoaded) && (fitItems.length === 0 || fitted) && routesSettled && (!viewportPlacesShown || placesSettled);
  // Results lie over the map in a panel; a new answer opens it again after the user folded it.
  const [panelOpen, setPanelOpen] = useState(true);
  const resultSignature = tripPlan ? `plan:${tripPlan.city}:${tripPlan.totalDays}:${tripPlan.days.map((day) => day.stopPlaceIds.join(",")).join("|")}` : resultItems.map((item) => item.key).join(",");
  useEffect(() => { setPanelOpen(true); }, [resultSignature]);
  const numberFormat = language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US";
  // An answer without rows (a reply, an empty search) leaves the map to the status line; the chat says what happened.
  const showResultsPanel = !investigation && (Boolean(tripPlan) || resultItems.length > 0);
  const selectedRecord = selectedItem?.kind === "record" ? selectedItem : undefined;
  return (
    <section className="map-panel" aria-label={t("Карта и результаты", "Map and results")}>
      <div className="map-toolbar">
        <div>
          <span className="eyebrow">{toolbarEyebrow}</span>
          <h2>{toolbarTitle}</h2>
        </div>
        <div className="map-toolbar-side">
          {layers && onLayers && <div className="map-layers" role="group" aria-label={t("Слои карты", "Map layers")}>
            <button type="button" aria-pressed={layers.places} className={layers.places ? "active" : ""} onClick={() => onLayers({ ...layers, places: !layers.places })} title={t("Места в области карты", "Places in the map area")}><MapPin size={12} />{t("Места", "Places")}</button>
            <button type="button" aria-pressed={layers.events} className={layers.events ? "active" : ""} onClick={() => onLayers({ ...layers, events: !layers.events })} title={t("Землетрясения за последнюю неделю", "Earthquakes of the last week")}><Activity size={12} />{t("События", "Events")}</button>
          </div>}
          <span className="map-cap">{t("зум", "zoom")} {zoom}+</span>
        </div>
      </div>
      <div className={`map-canvas${showResultsPanel && panelOpen ? " with-results-panel" : ""}`} aria-busy={!loaded}>
        <MapContainer center={[49.8, 15.5]} zoom={zoom} minZoom={3} maxZoom={MAX_MAP_ZOOM} scrollWheelZoom preferCanvas fadeAnimation={false}>
          <MapSizeObserver />
          <ResetViewport revision={resetViewportRevision} />
          <FitToResults items={fitItems} onFitted={markFitted} />
          {!loaded && <LoadGate dataReady={dataReady} onReady={markLoaded} />}
          <FitToFocus focusKey={focusedDay === null ? null : String(focusedDay)} requestRevision={focusRevision} points={focusPoints} routePlan={focusRoute} />
          <ViewportPlaces onPlaces={handlePlaces} sourceIds={sourceIds} enabled={!investigation && resultItems.length === 0 && (layers?.places ?? true)} />
          <ZoomLevel onZoom={handleZoom} selected={investigation ? undefined : selectedItem} />
          {investigation && <FitToSelection selected={selectedRecord} places={highlights} />}
          {investigation && focus && <FocusPoint focus={focus} />}
          {pinned && (pinned.place ?? pinned.record) && <FocusPoint focus={{ lat: (pinned.place ?? pinned.record)!.lat, lon: (pinned.place ?? pinned.record)!.lon, revision: pinned.revision }} />}
          {radius && <RadiusOverlay radius={radius} language={language} />}
          {visitedAreas.length > 0 && <VisitedAreas areas={visitedAreas} language={language} />}
          {tileUrl && <TileLayer url={tileUrl} maxZoom={MAX_MAP_ZOOM} keepBuffer={8} updateWhenZooming={false} attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' />}
          {countryBoundaries.map(({ code, feature }) => <LeafletGeoJSON key={code} data={feature} style={{ color: COUNTRY_BORDER_COLOR, weight: 1.5, opacity: 0.9, fillColor: COUNTRY_BORDER_COLOR, fillOpacity: 0.02, dashArray: "4 6" }} interactive={false} />)}
          {tripPlan ? tripRouteInputs.map((route) => route.routeStatus === "pending" && <TripRouteLayer key={`${tripPlan.totalDays}:${route.day}:${route.points.map((point) => point.id).join(",")}`} day={route.day} points={route.points} retryKey={dayRouteRetryKeys[route.day] ?? 0} onState={handleDayRouteState} />) : !investigation && <RouteLayer points={routeRequested ? routePoints : []} retryKey={routeRetryKey} onState={handleRouteState} />}
          {tripPlan ? tripRouteInputs.map((route) => <RouteGeometry key={`geometry-${route.day}`} plan={focusedDay !== null && (focusedDay !== "city" ? focusedDay !== route.day : route.area !== "city") ? null : dayRouteStates[route.day]?.plan ?? null} points={focusedDay !== null && (focusedDay !== "city" ? focusedDay !== route.day : route.area !== "city") ? [] : dayRouteStates[route.day]?.orderedPoints ?? []} color={routeColors[(route.day - 1) % routeColors.length]} onSelect={selectPlace} />) : !investigation && <RouteGeometry plan={routeState.plan} points={routeState.orderedPoints} onSelect={selectPlace} />}
          <SelectionPulse request={pulseRequest} items={mapItems} />
          {mapItems.map((item) => {
            const selected = item.key === selectedResultKey;
            const focused = focusedPlaceIds.has(item.id);
            return <CircleMarker key={item.key} center={[item.lat, item.lon]} radius={focused ? 10 : selected ? 11 : item.kind === "record" || highlights.some((place) => place.id === item.id) ? 7 : 4} eventHandlers={{ click: () => select(item.key) }} pathOptions={{ dashArray: isUnverifiedRecord(item, recordSourceModes) ? "3 3" : undefined, color: focused || selected ? "#ffffff" : item.kind === "record" ? "#ffe0a8" : "#8bdbb3", fillColor: focused ? "#31b57f" : selected ? "#58d9a0" : item.kind === "record" ? "#d8844a" : "#45a77c", fillOpacity: 0.95, weight: focused || selected ? 3 : 1 }}>
              <Popup><strong>{item.name}</strong><br /><small>{item.category ?? (item.kind === "place" ? t("Место", "Place") : t("Запись", "Record"))}</small>{item.summary && <><br />{item.summary}</>}{investigation && <><br /><small>{t("Источник", "Source")}: {sourceLabels[item.sourceId] ?? `${item.sourceId} (${t("не проверен", "unverified")})`}</small></>}</Popup>
              {focused && <Tooltip permanent direction="top" offset={[0, -8]} className="focused-stop-label">{focusedPlaceOrder.get(item.id)}</Tooltip>}
            </CircleMarker>;
          })}
        </MapContainer>
        {!coverGone && <div className={`map-loader${loaded ? " done" : ""}`} role="status" aria-live="polite" onTransitionEnd={() => { if (loaded) setCoverGone(true); }}>
          <span className="map-loader-ring" aria-hidden="true"><MapIcon size={18} strokeWidth={1.8} /></span>
          <span className="map-loader-label">{t("Загружаю карту…", "Loading the map…")}</span>
        </div>}
        {countryBoundaries.length > 0 && <div className="boundary-legend"><span aria-hidden="true" />{t("Страны:", "Countries:")} {countryBoundaries.map(({ code }) => countryName(code, language)).join(" · ")}{tripPlan && <><span className="city-focus-dot" aria-hidden="true" />{(tripPlan.cities?.length ?? 0) > 1 ? t("Города:", "Cities:") : t("Точки города:", "City points:")} {tripPlan.city}{focusedDay === "city" ? ` · ${focusPoints.length}` : focusedDay !== null ? ` · ${t("день", "day")} ${focusedDay}` : ""}</>}</div>}
        {showResultsPanel && <MapResultsPanel
          language={language}
          title={tripPlan ? t("План поездки", "Trip plan") : t("Результаты запроса", "Query results")}
          count={tripPlan ? `${tripPlan.city} · ${tripPlan.totalDays} ${language === "ru" ? "дн." : language === "de" ? "Tage" : "days"}` : resultItems.length.toLocaleString(numberFormat)}
          open={panelOpen}
          onToggle={() => setPanelOpen((open) => !open)}
        >
          {tripPlan ? <TripPlanBoard language={language} plan={tripPlan} highlights={highlights} routeStates={dayRouteStates} sourceLabels={sourceLabels} sourceDates={sourceDates} focusedDay={focusedDay} selectedPlaceId={selectedItem?.kind === "place" ? selectedItem.id : null} onSelectDay={(day) => { setFocusedDay(day); setFocusRevision((revision) => revision + 1); const failed = day !== "city" && dayRouteStates[day]?.status === "error"; if (failed) setDayRouteRetryKeys((current) => ({ ...current, [day]: (current[day] ?? 0) + 1 })); }} onSelectPlace={(id) => select(`place:${id}`)} /> : <>
            {!routeRequested && routePoints.length >= 2 && <section className="route-summary route-summary-idle">
              <div className="route-summary-heading">
                <span className="route-summary-icon"><Route size={16} /></span>
                <div className="route-summary-title"><strong>{t("Маршрут не построен", "No route yet")}</strong><small>{t("Автомобильный маршрут по найденным местам строится по запросу.", "A driving route through the found places is built on request.")}</small></div>
                <button type="button" className="route-build" onClick={() => setRouteRequested(true)}>{t("Построить маршрут", "Build route")}</button>
              </div>
            </section>}
            {routeRequested && routeState.status !== "idle" && <RouteSummary language={language} state={routeState} totalPoints={routeCandidates.total} expanded={routeExpanded} onToggle={() => setRouteExpanded((value) => !value)} onRetry={() => setRouteRetryKey((value) => value + 1)} />}
            {resultItems.length ? <div className="server-results-list" aria-label={t("Результаты запроса", "Query results")}>
              {resultItems.map((item) => <button type="button" key={item.key} className={`server-result${selectedResultKey === item.key ? " selected" : ""}`} aria-pressed={selectedResultKey === item.key} onClick={() => select(item.key)}>
                <span className="server-result-icon">{item.kind === "record" ? <Clock3 size={15} /> : <MapPin size={15} />}</span>
                <span className="server-result-copy"><strong>{item.name}</strong><small>{[item.category ?? (item.kind === "record" ? t("Запись", "Record") : t("Место", "Place")), sourceLabels[item.sourceId] ?? t("Источник", "Source"), item.summary].filter(Boolean).join(" · ")}</small></span>
                <span className="server-result-arrow"><ArrowUpRight size={14} /></span>
              </button>)}
            </div> : null}
          </>}
        </MapResultsPanel>}
        {!investigation && !showResultsPanel && <div className="map-status-pill" role="status"><strong>{t("Места в области карты", "Places in map area")}</strong><span>{zoom < MIN_PLACES_ZOOM ? t("Увеличьте карту для поиска", "Zoom in to search") : places.length < total ? `${t("Показаны первые", "Showing first")} ${places.length.toLocaleString(numberFormat)} ${t("из", "of")} ${total.toLocaleString(numberFormat)}` : `${total.toLocaleString(numberFormat)} · ${t("локальная выгрузка", "local extract")}`}</span></div>}
        {selectedItem && !investigation && dismissedKey !== selectedItem.key && <SelectedItemCard language={language} item={selectedItem} sourceLabel={sourceLabels[selectedItem.sourceId] ?? selectedItem.sourceId} tripContext={tripPlan ? getTripContext(selectedItem.id, tripPlan, dayRouteStates) : null} onAsk={onAsk} onClose={() => setDismissedKey(selectedItem.key)} />}
      </div>
    </section>
  );
}

const routeColors = ["#41cda0", "#e0a84d", "#75a8ff", "#c78bff", "#ef7f7f", "#5fd0e8", "#d6d65a"];

function TripRouteLayer({ day, points, retryKey, onState }: { day: number; points: RoutePoint[]; retryKey: number; onState: (day: number, state: RouteState) => void }) {
  const signature = points.map((point) => `${point.id}:${point.lat},${point.lon}`).join("|");
  useEffect(() => {
    if (points.length < 2 || points.length > 8) {
      onState(day, { status: "error", plan: null, orderedPoints: [] });
      return;
    }
    const controller = new AbortController();
    onState(day, { status: "loading", plan: null, orderedPoints: [] });
    buildRoute(points.map(({ lat, lon }) => ({ lat, lon })), controller.signal)
      .then((plan) => {
        const orderedPoints = plan.order.map((index) => points[index]).filter((point): point is RoutePoint => Boolean(point));
        if (orderedPoints.length !== points.length) throw new Error("Invalid route order");
        onState(day, { status: "ready", plan, orderedPoints });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) onState(day, { status: "error", plan: null, orderedPoints: [] });
      });
    return () => controller.abort();
  }, [day, signature, retryKey, onState]);
  return null;
}

function TripPlanBoard({ language, plan, highlights, routeStates, sourceLabels, sourceDates, focusedDay, selectedPlaceId, onSelectDay, onSelectPlace }: { language: Language; plan: TripPlan; highlights: PlaceView[]; routeStates: Record<number, RouteState>; sourceLabels: Record<string, string>; sourceDates: Record<string, string>; focusedDay: number | "city" | null; selectedPlaceId: string | null; onSelectDay: (day: number | "city") => void; onSelectPlace: (id: string) => void }) {
  const places = new Map(highlights.map((place) => [place.id, place]));
  const t = (ru: string, en: string) => translate(language, ru, en);
  const title = t("План поездки", "Trip plan");
  const snapshotDates = [...new Set(plan.sourceIds.flatMap((sourceId) => sourceDates[sourceId] ? [sourceDates[sourceId]!] : []))];
  return <section className="trip-plan-board" aria-label={title}>
    <header className="trip-plan-heading">
      <div><span className="eyebrow">{t("ЛОКАЛЬНЫЕ ДАННЫЕ · ПРОВЕРЕННЫЕ ТОЧКИ", "LOCAL DATA · VERIFIED PLACES")}</span><button type="button" className="trip-plan-city-button" aria-pressed={focusedDay === "city"} onClick={() => onSelectDay("city")}><h3>{title}: {plan.city}{(plan.cities?.length ?? 0) > 1 ? "" : `, ${countryName(plan.countryCode, language)}`}</h3><small>{t("Показать все точки города", "Show all city points")}</small></button></div>
      <span className={`trip-plan-status ${plan.status}`}>{plan.status === "ready" ? t("Точки распределены", "Stops organized") : t("Частично", "Partial")}</span>
    </header>
    {plan.days.map((day) => {
      const state = routeStates[day.day];
      const dayPlaces = day.stopPlaceIds.map((id) => places.get(id)).filter((place): place is PlaceView => Boolean(place));
      if (state?.status === "ready") {
        const routeOrder = new Map(state.orderedPoints.map((point, index) => [point.id, index]));
        dayPlaces.sort((left, right) => (routeOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (routeOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
      }
      const area = day.area === "airport_radius" ? `${plan.airport?.code ?? ""} · ${t("рядом с аэропортом", "near the airport")}` : day.city ?? plan.city;
      const routeLabel = plan.travelMode === "none" ? t("Маршрут не запрашивался", "Route not requested")
        : state?.status === "ready" ? `${t("Маршрут построен", "Route calculated")} · ${formatDistance(state.plan?.distanceMeters ?? 0, language)} · ~${Math.max(1, Math.round((state.plan?.durationSeconds ?? 0) / 60))} ${t("мин", "min")}`
          : state?.status === "loading" ? t("Считаю маршрут по дорогам…", "Calculating road route…")
            : state?.status === "error" || day.routeStatus === "unavailable" ? t("Маршрут недоступен; точки сохранены", "Route unavailable; places are still shown")
              : t("Ожидается расчёт маршрута", "Waiting for route calculation");
      return <article className={`trip-plan-day${focusedDay === day.day ? " focused" : ""}`} key={day.day}>
        <div className="trip-plan-day-heading"><button type="button" className="trip-plan-day-focus" aria-pressed={focusedDay === day.day} onClick={() => onSelectDay(day.day)}><span className="trip-day-number">{day.day}</span><span><strong>{t("День", "Day")} {day.day} · {area}</strong><small>{routeLabel}</small></span><span className="trip-route-swatch" style={{ backgroundColor: routeColors[(day.day - 1) % routeColors.length] }} aria-hidden="true" /></button>{state?.status === "error" && <button type="button" className="trip-day-retry" aria-label={t(`Повторить маршрут для дня ${day.day}`, `Retry route for day ${day.day}`)} onClick={() => onSelectDay(day.day)}><RotateCw size={14} /></button>}</div>
        {day.area === "airport_radius" && plan.airport && <button type="button" className="trip-plan-stop trip-plan-airport" aria-pressed={selectedPlaceId === plan.airport.placeId} onClick={() => onSelectPlace(plan.airport!.placeId)}><span className="trip-stop-number">✈</span><span><strong>{plan.airport.name}</strong><small>{plan.airport.code} · {t("начало маршрута", "route origin")}</small></span></button>}
        {dayPlaces.length ? <ol className="trip-plan-stops">{dayPlaces.map((place, index) => {
          const distance = day.straightLineDistanceMetersFromAirport[place.id];
          return <li key={place.id}><button type="button" className="trip-plan-stop" aria-pressed={selectedPlaceId === place.id} onClick={() => onSelectPlace(place.id)}><span className="trip-stop-number">{index + (day.area === "airport_radius" && plan.airport ? 2 : 1)}</span><span><strong>{place.name}</strong><small>{[place.category, place.city, sourceLabels[place.sourceId], distance !== undefined ? `${formatDistance(distance, language)} ${t("по прямой от аэропорта", "straight-line from airport")}` : null].filter(Boolean).join(" · ")}</small></span><ArrowUpRight size={14} /></button></li>;
        })}</ol> : <p className="trip-plan-empty">{t("В локальном снимке не найдено точек для этого дня.", "No places for this day were found in the local snapshot.")}</p>}
      </article>;
    })}
    <p className="trip-plan-footnote">{t("План собран сервером из точек локального снимка OpenStreetMap.", "The backend assembled this plan from the local OpenStreetMap snapshot.")} {snapshotDates.length ? `${t("Дата снимка", "Snapshot date")}: ${snapshotDates.join(" · ")}.` : t("Дата снимка не указана в метаданных источника.", "The source metadata does not include a snapshot date.")} {t("Расстояния от аэропорта показаны по прямой; дорожная геометрия и время появляются только после успешного ответа сервиса маршрутов.", "Airport distances are straight-line; road geometry and time appear only after the routing service responds.")}</p>
  </section>;
}

function formatDistance(meters: number, language: Language): string {
  return meters >= 1000 ? `${(meters / 1000).toLocaleString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 1 })} km` : `${Math.round(meters)} m`;
}

function RouteSummary({ language, state, totalPoints, expanded, onToggle, onRetry }: { language: Language; state: RouteState; totalPoints: number; expanded: boolean; onToggle: () => void; onRetry: () => void }) {
  const t = (ru: string, en: string) => translate(language, ru, en);
  const plan = state.plan;
  const routeArea = [...new Set(state.orderedPoints.map((point) => point.city).filter((city): city is string => Boolean(city)))];
  const areaLabel = routeArea.length === 1 ? routeArea[0] : countryName(state.orderedPoints[0]?.countryCode ?? "", language);
  const distance = plan ? plan.distanceMeters >= 1000
    ? `${(plan.distanceMeters / 1000).toLocaleString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 1 })} km`
    : `${Math.round(plan.distanceMeters)} m` : null;
  const minutes = plan ? Math.max(1, Math.round(plan.durationSeconds / 60)) : null;
  return <section className={`route-summary route-summary-${state.status}`} aria-live="polite">
    <div className="route-summary-heading">
      <span className="route-summary-icon"><Route size={16} /></span>
      <div className="route-summary-title"><strong>{t("Маршрут по найденным местам", "Route through found places")}</strong><small>{state.status === "loading" ? t("Подбираю порядок остановок…", "Optimizing stop order…") : state.status === "error" ? t("Сервис маршрутов сейчас недоступен", "Routing service is unavailable") : `${areaLabel} · ${t("дороги · OSRM", "road route · OSRM")}`}</small></div>
      {state.status === "ready" && <button type="button" className="route-toggle" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? t("Свернуть остановки", "Collapse stops") : t("Показать остановки", "Show stops")}><ChevronDown size={16} /></button>}
      {state.status === "error" && <button type="button" className="route-toggle" onClick={onRetry} aria-label={t("Повторить", "Retry")}><RotateCw size={15} /></button>}
    </div>
    {state.status === "ready" && plan && <>
      <div className="route-metrics"><span><Navigation size={13} />{distance}</span><span><Clock3 size={13} />~{t(`${minutes} мин`, `${minutes} min`)}</span><span>{state.orderedPoints.length} {t("остановок", "stops")}</span></div>
      {totalPoints > state.orderedPoints.length && <p className="route-limit-note">{t(`Маршрут строится по первым ${state.orderedPoints.length} из ${totalPoints} мест.`, `Route includes the first ${state.orderedPoints.length} of ${totalPoints} places.`)}</p>}
      {expanded && <ol className="route-stop-list">{state.orderedPoints.map((point, index) => <li key={`${point.id}:${index}`}><span>{index + 1}</span><strong>{point.name}</strong></li>)}</ol>}
    </>}
  </section>;
}

function SelectedItemCard({ language, item, sourceLabel, tripContext, onAsk, onClose }: { language: Language; item: MapItem; sourceLabel: string; tripContext: { day: number; stop: number; totalStops: number; area: "airport_radius" | "city" } | null; onAsk?: (item: { kind: "place" | "record"; id: string; name: string }) => void; onClose: () => void }) {
  const t = (ru: string, en: string) => translate(language, ru, en);
  const address = item.place
    ? [item.place.street && [item.place.street, item.place.houseNumber].filter(Boolean).join(" "), item.place.postcode, item.place.city].filter(Boolean).join(", ")
    : null;
  const attributes = item.record
    ? Object.entries(item.record.attributes).filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value)).slice(0, 8)
    : [];
  return <section className="selected-item-card" aria-label={t("Карточка выбранного объекта", "Selected item details")}>
    <div className="selected-item-heading"><span className="selected-item-icon">{item.kind === "record" ? <Clock3 size={16} /> : <MapPin size={16} />}</span><div><span className="eyebrow">{item.kind === "record" ? t("ЗАПИСЬ", "RECORD") : t("МЕСТО НА КАРТЕ", "MAP PLACE")}</span><h3>{item.name}</h3></div>
      <button type="button" className="selected-item-close" onClick={onClose} aria-label={t("Закрыть", "Close")} title={t("Закрыть", "Close")}><X size={14} /></button></div>
    <dl className="selected-item-grid">
      {tripContext && <div className="selected-item-wide selected-trip-context"><dt>{t("В плане поездки", "Trip plan")}</dt><dd>{t(`День ${tripContext.day} · точка ${tripContext.stop} из ${tripContext.totalStops}`, `Day ${tripContext.day} · stop ${tripContext.stop} of ${tripContext.totalStops}`)} · {tripContext.area === "airport_radius" ? t("район аэропорта", "airport area") : item.place?.city ?? t("город", "city")}</dd></div>}
      <div><dt>{t("Категория", "Category")}</dt><dd>{item.category ?? t("Не указана", "Not specified")}</dd></div>
      {item.place?.countryCode && <div><dt>{t("Страна", "Country")}</dt><dd>{countryName(item.place.countryCode, language)}</dd></div>}
      <div><dt>{t("Источник", "Source")}</dt><dd>{sourceLabel}</dd></div>
      {address && <div className="selected-item-wide"><dt>{t("Адрес", "Address")}</dt><dd>{address || t("Адрес не указан", "No address provided")}</dd></div>}
      {item.place?.details && Object.entries(item.place.details).map(([key, value]) => {
        const websiteUrl = key === "website" ? safeWebsiteUrl(value) : null;
        return <div key={key} className="selected-item-wide"><dt>{placeDetailLabel(key, language)}</dt><dd>{websiteUrl ? <a href={websiteUrl} target="_blank" rel="noreferrer">{value}</a> : value}</dd></div>;
      })}
      {item.record && <div><dt>{t("Время записи", "Record time")}</dt><dd>{formatObservedAt(item.record.observedAt, language)}</dd></div>}
      {item.record?.accuracyMeters !== null && item.record?.accuracyMeters !== undefined && <div><dt>{t("Точность", "Accuracy")}</dt><dd>±{item.record.accuracyMeters} m</dd></div>}
      <div className="selected-item-wide"><dt>{t("Координаты", "Coordinates")}</dt><dd>{item.lat.toFixed(6)}, {item.lon.toFixed(6)}</dd></div>
      {attributes.map(([key, value]) => <div key={key}><dt>{humanizeField(key)}</dt><dd>{value === null ? "—" : String(value)}</dd></div>)}
    </dl>
    {onAsk && <div className="selected-item-actions"><button type="button" className="selected-item-ask" onClick={() => onAsk({ kind: item.kind, id: item.id, name: item.name })}><MessageSquare size={13} />{t("Спросить ассистента", "Ask the assistant")}</button></div>}
  </section>;
}

function getTripContext(placeId: string, plan: TripPlan, routeStates: Record<number, RouteState>): { day: number; stop: number; totalStops: number; area: "airport_radius" | "city" } | null {
  for (const day of plan.days) {
    const fallbackOrder = day.area === "airport_radius" && plan.airport ? [plan.airport.placeId, ...day.stopPlaceIds] : day.stopPlaceIds;
    const routeOrder = routeStates[day.day]?.status === "ready" ? routeStates[day.day]!.orderedPoints.map((point) => point.id) : fallbackOrder;
    const stopIndex = routeOrder.indexOf(placeId);
    if (stopIndex >= 0) return { day: day.day, stop: stopIndex + 1, totalStops: routeOrder.length, area: day.area };
    if (day.area === "airport_radius" && plan.airport?.placeId === placeId) return { day: day.day, stop: 1, totalStops: day.stopPlaceIds.length + 1, area: day.area };
  }
  return null;
}

function safeWebsiteUrl(value: string): string | null {
  try {
    const normalized = value.trim();
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(normalized) ? normalized : `https://${normalized}`;
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function placeDetailLabel(key: string, language: Language): string {
  const labels: Record<string, [string, string]> = { tourism: ["Тип туристического объекта", "Tourism type"], historic: ["Историческая категория", "Historic category"], cuisine: ["Кухня", "Cuisine"], opening_hours: ["Часы работы по OSM", "OSM opening hours"], wheelchair: ["Доступность", "Wheelchair access"], website: ["Сайт", "Website"], description: ["Описание из OSM", "OSM description"], fee: ["Платный вход", "Entry fee"], internet_access: ["Интернет", "Internet access"], wikidata: ["Wikidata", "Wikidata"] };
  return labels[key] ? translate(language, ...labels[key]!) : key;
}

function formatObservedAt(value: string, language: Language): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function humanizeField(value: string): string {
  return value.replace(/([a-zа-я])([A-ZА-Я])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (first) => first.toLocaleUpperCase());
}

function countryName(code: string, language: Language): string {
  const names: Record<string, [string, string]> = { DE: ["Германия", "Germany"], PL: ["Польша", "Poland"], RO: ["Румыния", "Romania"], FR: ["Франция", "France"], IT: ["Италия", "Italy"], ES: ["Испания", "Spain"] };
  return names[code] ? translate(language, ...names[code]!) : code;
}
