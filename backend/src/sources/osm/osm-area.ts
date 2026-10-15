import { fetchWithRetry } from "../http.js";
import { SourceFetchError } from "../source-adapter.js";

/** Kinds of places an area import can load; each maps to OSM tag filters. Settlements are always loaded. */
export const OSM_AREA_CATEGORIES = {
  attraction: [["tourism", "attraction"]],
  museum: [["tourism", "museum"]],
  gallery: [["tourism", "gallery"]],
  viewpoint: [["tourism", "viewpoint"]],
  monument: [["historic", "monument|memorial"]],
  castle: [["historic", "castle"]],
  church: [["amenity", "place_of_worship"]],
  theatre: [["amenity", "theatre|arts_centre"]],
  park: [["leisure", "park|garden"]],
  restaurant: [["amenity", "restaurant"]],
  cafe: [["amenity", "cafe"]],
  bar: [["amenity", "bar|pub"]],
  hotel: [["tourism", "hotel|guest_house|hostel"]],
  transport: [["railway", "station"], ["public_transport", "station"]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;
export type OsmAreaCategory = keyof typeof OSM_AREA_CATEGORIES;
export const DEFAULT_OSM_AREA_CATEGORIES: OsmAreaCategory[] = ["attraction", "museum", "gallery", "monument", "park", "restaurant", "cafe"];

/** Settlement nodes are always imported, so the assistant can resolve the new city by name. */
const SETTLEMENT_FILTER = ["place", "city|town|village|suburb"] as const;
const CATEGORY_KEYS = ["amenity", "tourism", "leisure", "historic", "railway", "public_transport", "place"];
const KEPT_TAGS = ["name", "name:en", "amenity", "tourism", "leisure", "historic", "railway", "public_transport", "place", "cuisine", "opening_hours", "wheelchair", "website", "description", "fee", "wikidata", "addr:country", "addr:state", "addr:city", "addr:postcode", "addr:street", "addr:housenumber"];
/** Overpass areas are fetched in tiles of at most this many degrees per side, for progress and smaller replies. */
const TILE_DEGREES = 0.25;

export type Bbox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export interface OsmAreaPlace {
  id: string;
  osmType: "node" | "way" | "relation";
  osmId: string;
  name: string;
  category: string;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  postcode: string | null;
  street: string | null;
  houseNumber: string | null;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface OsmServiceOptions {
  url: string;
  timeoutMs: number;
  userAgent: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function bboxArea([minLon, minLat, maxLon, maxLat]: Bbox): number {
  return (maxLon - minLon) * (maxLat - minLat);
}

/** Tiles covering the bbox, row by row from the south-west. */
export function tilesFor([minLon, minLat, maxLon, maxLat]: Bbox): Bbox[] {
  const tiles: Bbox[] = [];
  for (let lat = minLat; lat < maxLat; lat += TILE_DEGREES) {
    for (let lon = minLon; lon < maxLon; lon += TILE_DEGREES) {
      tiles.push([lon, lat, Math.min(lon + TILE_DEGREES, maxLon), Math.min(lat + TILE_DEGREES, maxLat)].map((value) => Number(value.toFixed(6))) as Bbox);
    }
  }
  return tiles;
}

/** The Overpass QL for one tile: named places of the chosen kinds plus settlements, ways and relations as centers. */
export function overpassQuery(tile: Bbox, categories: OsmAreaCategory[]): string {
  const [minLon, minLat, maxLon, maxLat] = tile;
  const box = `(${minLat},${minLon},${maxLat},${maxLon})`;
  const filters: Array<readonly [string, string]> = [...categories.flatMap((category): ReadonlyArray<readonly [string, string]> => OSM_AREA_CATEGORIES[category]), SETTLEMENT_FILTER];
  const statements = filters.map(([key, values]) => `nwr["${key}"~"^(${values})$"]["name"]${box};`).join("");
  return `[out:json][timeout:60];(${statements});out center tags qt;`;
}

/** Overpass elements turned into place rows; elements without a name or position are dropped. */
export function parseOverpassElements(body: string, countryCode: string | null): OsmAreaPlace[] {
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new SourceFetchError("upstream_malformed", false); }
  const elements = payload && typeof payload === "object" && Array.isArray((payload as { elements?: unknown }).elements) ? (payload as { elements: unknown[] }).elements : null;
  if (!elements) throw new SourceFetchError("upstream_malformed", false);
  const places: OsmAreaPlace[] = [];
  for (const raw of elements) {
    if (!raw || typeof raw !== "object") continue;
    const element = raw as { type?: string; id?: number; lat?: number; lon?: number; center?: { lat?: number; lon?: number }; tags?: Record<string, unknown> };
    if ((element.type !== "node" && element.type !== "way" && element.type !== "relation") || !Number.isSafeInteger(element.id)) continue;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const tags = element.tags ?? {};
    const text = (key: string, max = 240) => typeof tags[key] === "string" && (tags[key] as string).trim() ? (tags[key] as string).trim().slice(0, max) : null;
    const name = text("name") ?? text("name:en");
    const categoryKey = CATEGORY_KEYS.find((key) => text(key));
    if (!name || !categoryKey) continue;
    const kept: Record<string, string> = {};
    for (const key of KEPT_TAGS) {
      const value = text(key, 500);
      if (value) kept[key] = value;
    }
    const country = text("addr:country", 2)?.toUpperCase();
    places.push({
      id: `osm:${element.type}:${element.id}`,
      osmType: element.type,
      osmId: String(element.id),
      name,
      category: `${categoryKey}:${text(categoryKey, 100)}`,
      countryCode: country && /^[A-Z]{2}$/.test(country) ? country : countryCode,
      region: text("addr:state", 160),
      city: text("addr:city", 160),
      postcode: text("addr:postcode", 32),
      street: text("addr:street", 200),
      houseNumber: text("addr:housenumber", 80),
      lat,
      lon,
      tags: kept,
    });
  }
  return places;
}

export async function fetchOverpassTile(tile: Bbox, categories: OsmAreaCategory[], countryCode: string | null, options: OsmServiceOptions): Promise<OsmAreaPlace[]> {
  const url = new URL(options.url);
  url.searchParams.set("data", overpassQuery(tile, categories));
  const { status, body } = await fetchWithRetry(url, {
    timeoutMs: options.timeoutMs,
    userAgent: options.userAgent,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    retries: 2,
    baseDelayMs: 5_000,
    maxDelayMs: 60_000,
    maxBodyBytes: 40 * 1024 * 1024,
  });
  if (status === 400) throw new SourceFetchError("upstream_bad_request", false);
  return parseOverpassElements(body, countryCode);
}

/** A place found by name, for choosing the area of an import. */
export interface GeocodeResult {
  label: string;
  /** Local name, used for the dataset. */
  name: string;
  /** Name in the requested language, for display. */
  localizedName: string;
  type: string;
  countryCode: string | null;
  lat: number;
  lon: number;
  bbox: Bbox;
}

/** A named place of any kind (country, state, city): its ISO 3166 codes (most specific first) and local names. */
export interface PlaceCodes {
  /** Name in the requested language, for the UI. */
  name: string;
  codes: string[];
  /** Local names of the place and of the state or region around it, used to find the catalogue region. */
  names: string[];
}

/**
 * Finds what a name refers to, its ISO 3166 codes, and its local names, to place it in the region catalogue. The
 * address is requested without a language, so the state comes in its local spelling ("Bayern", "Lombardia").
 */
export async function lookupPlaceCodes(query: string, language: string, options: OsmServiceOptions): Promise<PlaceCodes | null> {
  const url = new URL(options.url);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  const { body } = await fetchWithRetry(url, { timeoutMs: Math.min(options.timeoutMs, 15_000), userAgent: options.userAgent, signal: options.signal, fetchImpl: options.fetchImpl, retries: 1, maxBodyBytes: 256 * 1024 });
  let rows: unknown;
  try { rows = JSON.parse(body); } catch { throw new SourceFetchError("upstream_malformed", false); }
  if (!Array.isArray(rows) || !rows.length) return null;
  const row = rows[0] as { name?: string; display_name?: string; address?: Record<string, string>; namedetails?: Record<string, string> };
  const address = row.address ?? {};
  const codes = ["ISO3166-2-lvl8", "ISO3166-2-lvl6", "ISO3166-2-lvl5", "ISO3166-2-lvl4", "ISO3166-2-lvl3"]
    .map((key) => address[key])
    .filter((code): code is string => typeof code === "string" && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code));
  if (address.country_code && /^[a-z]{2}$/.test(address.country_code)) codes.push(address.country_code.toUpperCase());
  if (!codes.length) return null;
  const details = row.namedetails ?? {};
  const names = [...new Set([details.name, details["name:en"], details["name:de"], address.state_district, address.state, address.region, address.province]
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 3)
    .map((value) => value.trim().slice(0, 120)))];
  const name = details[`name:${language}`] || details.name || row.name || row.display_name?.split(",")[0] || query;
  return { name: name.slice(0, 120), codes, names };
}

export async function geocode(query: string, language: string, options: OsmServiceOptions): Promise<GeocodeResult[]> {
  const url = new URL(options.url);
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("accept-language", language);
  url.searchParams.set("featureType", "settlement");
  const { body } = await fetchWithRetry(url, { timeoutMs: Math.min(options.timeoutMs, 15_000), userAgent: options.userAgent, signal: options.signal, fetchImpl: options.fetchImpl, retries: 1, maxBodyBytes: 1024 * 1024 });
  let rows: unknown;
  try { rows = JSON.parse(body); } catch { throw new SourceFetchError("upstream_malformed", false); }
  if (!Array.isArray(rows)) throw new SourceFetchError("upstream_malformed", false);
  return rows.flatMap((raw) => {
    const row = raw as { display_name?: string; name?: string; namedetails?: Record<string, string>; type?: string; addresstype?: string; lat?: string; lon?: string; boundingbox?: string[]; address?: { country_code?: string } };
    const box = row.boundingbox?.map(Number);
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    if (!row.display_name || !box || box.length !== 4 || box.some((value) => !Number.isFinite(value)) || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    // Nominatim orders the box as south, north, west, east.
    const [south, north, west, east] = box as [number, number, number, number];
    return [{
      label: row.display_name.slice(0, 200),
      // The local name ("Kraków"), as OSM stores it on the settlement, so the dataset and the chat use the same name.
      name: (row.namedetails?.name || row.name || row.display_name.split(",")[0] || "").slice(0, 120),
      localizedName: (row.name || row.display_name.split(",")[0] || "").slice(0, 120),
      type: (row.addresstype ?? row.type ?? "place").slice(0, 40),
      countryCode: row.address?.country_code ? row.address.country_code.toUpperCase().slice(0, 2) : null,
      lat,
      lon,
      bbox: [west, south, east, north] as Bbox,
    }];
  });
}
