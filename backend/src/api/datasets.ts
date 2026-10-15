import { Router } from "express";
import { z } from "zod";
import {
  SETTLEMENT_TYPES,
  type CountryView,
  type DatasetEventRow,
  type CatalogCursor,
  type CatalogFilter,
  type CatalogPlace,
  type CatalogPlaceQuery,
  type DatasetView,
  type SettlementQuery,
  type SettlementView,
} from "../data/dataset.repository.js";
import type { GeocodeResult } from "../sources/osm/osm-area.js";
import type { GeofabrikFile, GeofabrikRegion } from "../sources/osm/geofabrik.js";
import { SourceFetchError } from "../sources/source-adapter.js";
import { createRateLimit } from "./rate-limit.js";

export interface DatasetDependencies {
  listDatasets(): Promise<DatasetView[]>;
  listCountries(datasetId?: string): Promise<CountryView[]>;
  listSettlements(query: SettlementQuery): Promise<{ total: number; settlements: SettlementView[] }>;
  listCatalogPlaces(query: CatalogPlaceQuery): Promise<{ total: number | null; places: CatalogPlace[]; next: CatalogCursor | null }>;
  listCatalogCategories(filter: CatalogFilter): Promise<Array<{ category: string; places: number }>>;
  listDatasetEvents(query: { datasetId: string; limit: number; after?: { observedAt: string; id: string } }): Promise<{ total: number | null; events: DatasetEventRow[]; next: { observedAt: string; id: string } | null }>;
  geocode(query: string, language: string): Promise<GeocodeResult[]>;
  searchRegions(query: string): Promise<GeofabrikRegion[]>;
  /** Regions directly inside a region, or Europe's countries without a parent. */
  childRegions(parentId: string | null): Promise<GeofabrikRegion[]>;
  /** For a name the catalogue does not know ("Lombardia", "Wien"): the place it names and the catalogue regions that contain it. */
  locateRegions(query: string, language: string): Promise<{ place: string; regions: GeofabrikRegion[] } | null>;
  regionInfo(regionId: string): Promise<{ region: GeofabrikRegion; file: GeofabrikFile } | null>;
  now?: () => number;
}

const DATASET_CACHE_MS = 60_000;
const GEOCODE_CACHE_MS = 60 * 60 * 1000;
/** Nominatim's usage policy allows at most one request per second. */
const GEOCODE_INTERVAL_MS = 1_100;

/** Datasets and the place search used to pick an import area. */
export function createDatasetsRouter(deps: DatasetDependencies): Router {
  const router = Router();
  router.use(createRateLimit({ windowMs: 60_000, max: 60 }));
  const now = deps.now ?? Date.now;
  let datasets: { at: number; value: DatasetView[] } | null = null;
  let countries: { at: number; value: CountryView[] } | null = null;
  const geocodeCache = new Map<string, { at: number; value: GeocodeResult[] }>();
  let lastGeocodeAt = 0;

  router.get("/datasets", async (request, response, next) => {
    try {
      if (!datasets || request.query.fresh === "true" || now() - datasets.at > DATASET_CACHE_MS) datasets = { at: now(), value: await deps.listDatasets() };
      response.json({ datasets: datasets.value });
    } catch (error) { next(error); }
  });

  /** All countries, cached; the catalog also uses them to find the datasets of a country. */
  const allCountries = async (fresh: boolean) => {
    if (!countries || fresh || now() - countries.at > DATASET_CACHE_MS) countries = { at: now(), value: await deps.listCountries() };
    return countries.value;
  };
  const countriesQuery = z.object({ fresh: z.literal("true").optional(), dataset: z.string().regex(/^[a-z0-9-]{1,120}$/).optional() }).strict();
  router.get("/countries", async (request, response, next) => {
    const query = countriesQuery.safeParse(request.query);
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    try {
      // One dataset's counts are a bounded query and not cached; all countries are.
      response.json({ countries: query.data.dataset ? await deps.listCountries(query.data.dataset) : await allCountries(query.data.fresh === "true") });
    } catch (error) { next(error); }
  });

  const settlementQuery = z.object({
    country: z.string().regex(/^[A-Z]{2}$/),
    dataset: z.string().regex(/^[a-z0-9-]{1,120}$/).optional(),
    q: z.string().trim().max(80).optional(),
    types: z.string().default(SETTLEMENT_TYPES.join(","))
      .transform((value) => [...new Set(value.split(","))])
      .pipe(z.array(z.enum(SETTLEMENT_TYPES)).min(1)),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  }).strict();
  router.get("/settlements", async (request, response, next) => {
    const query = settlementQuery.safeParse(request.query);
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    try {
      const { country, dataset, q, types, limit, offset } = query.data;
      response.json(await deps.listSettlements({ countryCode: country, datasetId: dataset, query: q || undefined, types, limit, offset }));
    } catch (error) { next(error); }
  });

  const datasetId = z.string().regex(/^[a-z0-9-]{1,120}$/);
  const placeCursor = z.object({ part: z.union([z.literal(0), z.literal(1)]), name: z.string().max(240), id: z.string().max(120) }).strict();
  const eventCursor = z.object({ observedAt: z.string().datetime(), id: z.string().max(120) }).strict();
  const coordinate = (min: number, max: number) => z.coerce.number().min(min).max(max);
  const catalogFilter = {
    dataset: datasetId.optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    city: z.string().trim().min(1).max(160).optional(),
    category: z.string().trim().min(1).max(120).optional(),
    q: z.string().trim().max(80).optional(),
    bbox: z.string().max(100).optional()
      .transform((value, context) => {
        if (value === undefined) return undefined;
        const parts = value.split(",").map(Number);
        const [minLon, minLat, maxLon, maxLat] = parts;
        const valid = parts.length === 4 && parts.every(Number.isFinite)
          && coordinate(-180, 180).safeParse(minLon).success && coordinate(-180, 180).safeParse(maxLon).success
          && coordinate(-90, 90).safeParse(minLat).success && coordinate(-90, 90).safeParse(maxLat).success
          && minLon! < maxLon! && minLat! < maxLat!;
        if (!valid) { context.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_bbox" }); return z.NEVER; }
        return parts as [number, number, number, number];
      }),
  };
  const catalogPlacesQuery = z.object({ ...catalogFilter, limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(600).optional() }).strict();
  const catalogCategoriesQuery = z.object(catalogFilter).strict();
  const datasetEventsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(600).optional(),
  }).strict();

  /**
   * The datasets a catalog query may read: the named one, or every dataset with places in the country. Without
   * either the query would scan every place, so one of them is required.
   */
  const resolveFilter = async (query: { dataset?: string; country?: string; city?: string; category?: string; q?: string; bbox?: [number, number, number, number] }): Promise<CatalogFilter | null> => {
    const datasetIds = query.dataset ? [query.dataset]
      : query.country ? (await allCountries(false)).find((country) => country.countryCode === query.country)?.datasets ?? []
        : null;
    if (!datasetIds) return null;
    return { datasetIds, countryCode: query.country, city: query.city, category: query.category, query: query.q || undefined, bbox: query.bbox };
  };

  router.get("/catalog/places", async (request, response, next) => {
    const query = catalogPlacesQuery.safeParse(request.query);
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    const after = query.data.cursor ? decodeCursor(query.data.cursor, placeCursor) : undefined;
    if (after === null) return response.status(400).json({ error: "invalid_cursor" });
    try {
      const filter = await resolveFilter(query.data);
      if (!filter) return response.status(400).json({ error: "dataset_or_country_required" });
      if (!filter.datasetIds.length) return response.json({ total: 0, places: [], nextCursor: null });
      const page = await deps.listCatalogPlaces({ ...filter, limit: query.data.limit, after });
      response.json({ total: page.total, places: page.places, nextCursor: page.next ? encodeCursor(page.next) : null });
    } catch (error) { next(error); }
  });

  router.get("/catalog/categories", async (request, response, next) => {
    const query = catalogCategoriesQuery.safeParse(request.query);
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    try {
      const filter = await resolveFilter(query.data);
      if (!filter) return response.status(400).json({ error: "dataset_or_country_required" });
      response.json({ categories: filter.datasetIds.length ? await deps.listCatalogCategories(filter) : [] });
    } catch (error) { next(error); }
  });

  router.get("/datasets/:id/events", async (request, response, next) => {
    const id = datasetId.safeParse(request.params.id);
    const query = datasetEventsQuery.safeParse(request.query);
    if (!id.success) return response.status(404).json({ error: "not_found" });
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    const after = query.data.cursor ? decodeCursor(query.data.cursor, eventCursor) : undefined;
    if (after === null) return response.status(400).json({ error: "invalid_cursor" });
    try {
      const page = await deps.listDatasetEvents({ datasetId: id.data, limit: query.data.limit, after });
      response.json({ total: page.total, events: page.events, nextCursor: page.next ? encodeCursor(page.next) : null });
    } catch (error) { next(error); }
  });

  const geocodeQuery = z.object({ q: z.string().trim().min(2).max(100), language: z.enum(["en", "ru", "de"]).default("en") }).strict();
  router.get("/geocode", async (request, response, next) => {
    const query = geocodeQuery.safeParse(request.query);
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    const key = `${query.data.language}:${query.data.q.toLowerCase()}`;
    const cached = geocodeCache.get(key);
    if (cached && now() - cached.at < GEOCODE_CACHE_MS) return response.json({ results: cached.value });
    if (now() - lastGeocodeAt < GEOCODE_INTERVAL_MS) {
      response.setHeader("Retry-After", "1");
      return response.status(429).json({ error: "rate_limited" });
    }
    lastGeocodeAt = now();
    try {
      const results = await deps.geocode(query.data.q, query.data.language);
      geocodeCache.set(key, { at: now(), value: results });
      if (geocodeCache.size > 500) geocodeCache.delete(geocodeCache.keys().next().value!);
      response.json({ results });
    } catch (error) {
      if (error instanceof SourceFetchError) return response.status(502).json({ error: error.code });
      next(error);
    }
  });

  const regionQuery = z.object({
    q: z.string().trim().min(2).max(80).optional(),
    parent: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
    language: z.enum(["en", "ru", "de"]).default("en"),
  }).strict().refine((value) => !(value.q && value.parent), "q or parent");
  router.get("/regions", async (request, response, next) => {
    const query = regionQuery.safeParse(request.query);
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    try {
      if (!query.data.q) return response.json({ regions: await deps.childRegions(query.data.parent ?? null) });
      const regions = await deps.searchRegions(query.data.q);
      if (regions.length) return response.json({ regions });
      // An unknown name is looked up in Nominatim, under the same one-request-per-second limit as the city search.
      if (now() - lastGeocodeAt < GEOCODE_INTERVAL_MS) {
        response.setHeader("Retry-After", "1");
        return response.status(429).json({ error: "rate_limited" });
      }
      lastGeocodeAt = now();
      const located = await deps.locateRegions(query.data.q, query.data.language);
      response.json(located?.regions.length ? { regions: located.regions, via: located.place } : { regions: [] });
    } catch (error) {
      if (error instanceof SourceFetchError) return response.status(502).json({ error: error.code });
      next(error);
    }
  });

  router.get("/regions/:id", async (request, response, next) => {
    const id = z.string().regex(/^[a-z0-9-]{1,80}$/).safeParse(request.params.id);
    if (!id.success) return response.status(404).json({ error: "not_found" });
    try {
      const info = await deps.regionInfo(id.data);
      if (!info) return response.status(404).json({ error: "not_found" });
      response.json(info);
    } catch (error) {
      if (error instanceof SourceFetchError) return response.status(502).json({ error: error.code });
      next(error);
    }
  });

  return router;
}

/** Opaque keyset cursor: base64url of the last row's sort key. */
function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** The decoded cursor, or null when it is malformed. */
function decodeCursor<T>(value: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
