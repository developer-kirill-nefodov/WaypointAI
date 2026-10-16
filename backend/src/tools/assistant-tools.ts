import { z } from "zod";
import type { PlaceView, RecordView, Scope, ToolName } from "@waypoint-ai/shared";
import { getRecordDetails, getSources, searchNearbyPlaces, searchPlaces, searchRecords } from "../data/record.repository.js";
import { resolveSettlement } from "../data/settlement.repository.js";
import { TRIP_STOP_CATEGORIES } from "../assistant/trip-plan-edit.js";
import type { ToolDefinition } from "../llm/ollama.provider.js";
import { searchEventsToolDefinition } from "./search-events.js";
import { executeSearchEventsTool, type SearchEventsToolContext } from "./search-events-tool.js";

const searchRecordsArgs = z.object({
  query: z.string().max(100).optional(),
  category: z.string().max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const recordDetailsArgs = z.object({ id: z.string().min(1).max(120) }).strict();
/** Kinds of places the model can ask for by a plain word; each maps to OSM categories in the snapshots. */
export const PLACE_KINDS: Record<string, readonly (string | undefined)[]> = { ...TRIP_STOP_CATEGORIES, hotel: ["tourism:hotel"], any: [undefined] };
const SIGHTSEEING = [...TRIP_STOP_CATEGORIES.attraction, ...TRIP_STOP_CATEGORIES.museum];

const searchPlacesArgs = z.object({
  query: z.string().max(100).optional(),
  kind: z.enum(Object.keys(PLACE_KINDS) as [string, ...string[]]).optional(),
  category: z.string().max(120).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  city: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const listSourcesArgs = z.object({}).strict();

export const assistantToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_records",
      description: "Search records from configured local sources by keyword, category, or date. For earthquakes by place, radius, period, or magnitude, use search_events instead: it merges catalogues and reports their cross-check. Check source metadata and describe the source accurately.",
      parameters: { type: "object", additionalProperties: false, properties: {
        query: { type: "string", description: "Short keyword or phrase to match record category and attributes." },
        category: { type: "string", description: "Exact record category, if requested." },
        from: { type: "string", description: "ISO 8601 inclusive start date, if specified." },
        to: { type: "string", description: "ISO 8601 inclusive end date, if specified." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_record_details",
      description: "Get one record by its exact ID from the local dataset.",
      parameters: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string", maxLength: 120 } } },
    },
  },
  {
    type: "function",
    function: {
      name: "search_places",
      description: "Search named places and POIs in the local OpenStreetMap snapshots. Put a named city in city (local spelling); query is only for a place name, street, or postcode fragment.",
      parameters: { type: "object", additionalProperties: false, required: ["kind"], properties: {
        query: { type: "string", maxLength: 100 },
        kind: { type: "string", enum: Object.keys(PLACE_KINDS), description: "Kind of places the user asks for (museum, park, restaurant, ...); any when searching by name." },
        category: { type: "string", maxLength: 120, description: "Raw OSM category tag for other kinds, e.g. shop:supermarket or place:city." },
        countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
        city: { type: "string", maxLength: 120 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sources",
      description: "List the read-only data sources and their labels/coverage available to this workspace. Use when asked which countries or datasets are available, or about licenses/attribution. Report only what the returned metadata supports.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  searchEventsToolDefinition,
];

/** Radius search applied by search_events, drawn as a circle on the map. */
export interface SearchArea {
  lat: number;
  lon: number;
  radiusKm: number;
  label: string;
}

export interface ToolExecutionResult {
  content: unknown;
  searchArea?: SearchArea;
  records?: RecordView[];
  totalRecords?: number;
  places?: PlaceView[];
  totalPlaces?: number;
  /** What a place search looked for, so the reply can say it from the request rather than from the model. */
  placeSearch?: { kind: string | null; city: string | null; query: string | null; category: string | null };
  sourceIds?: string[];
  resultsFound: number;
}

export async function executeAssistantTool(
  name: ToolName,
  rawArgs: unknown,
  scope: Scope,
  sourceIds?: string[],
  selection: SearchEventsToolContext["selection"] = null,
  userText?: string,
): Promise<ToolExecutionResult> {
  if (name === "search_events") return executeSearchEventsTool(rawArgs, { scope, sourceIds, selection, userText });

  if (name === "search_records") {
    const parsed = searchRecordsArgs.safeParse(rawArgs);
    if (!parsed.success) return { content: { error: "Invalid search parameters. Use only documented fields." }, resultsFound: 0 };
    const query = parsed.data;
    const result = await searchRecords({
      ...query,
      limit: Math.min(query.limit ?? 50, 50),
      category: typeof scope.filters?.category === "string" ? scope.filters.category.slice(0, 120) : query.category,
      sourceIds,
      from: latestDate(scope.dateRange?.from, query.from),
      to: earliestDate(scope.dateRange?.to, query.to),
    });
    return {
      content: { total: result.total, records: result.records.slice(0, 8).map(compactRecord) },
      records: result.records,
      totalRecords: result.total,
      resultsFound: result.records.length,
    };
  }

  if (name === "get_record_details") {
    const parsed = recordDetailsArgs.safeParse(rawArgs);
    if (!parsed.success) return { content: { error: "Invalid record ID." }, resultsFound: 0 };
    const record = await getRecordDetails(parsed.data.id);
    const scopeFrom = scope.dateRange?.from ? Date.parse(scope.dateRange.from) : Number.NEGATIVE_INFINITY;
    const scopeTo = scope.dateRange?.to ? Date.parse(scope.dateRange.to) : Number.POSITIVE_INFINITY;
    const scopedCategory = typeof scope.filters?.category === "string" ? scope.filters.category : undefined;
    const observedAt = record ? Date.parse(record.observedAt) : Number.NaN;
    const category = record && typeof record.attributes.category === "string" ? record.attributes.category : record?.label;
    const withinScope = record
      && (!sourceIds?.length || sourceIds.includes(record.sourceId))
      && observedAt >= scopeFrom && observedAt <= scopeTo
      && (!scopedCategory || category === scopedCategory);
    const records = withinScope ? [record] : [];
    return { content: { record: records[0] ?? null }, records, totalRecords: records.length, resultsFound: records.length };
  }

  if (name === "search_places") {
    const parsed = searchPlacesArgs.safeParse(rawArgs);
    if (!parsed.success) return { content: { error: "Invalid place search parameters." }, resultsFound: 0 };
    const limit = Math.min(parsed.data.limit ?? 10, 10);
    const result = await searchPlacesInCity({ ...parsed.data, limit, sourceIds });
    const places = result.places as PlaceView[];
    return {
      content: { total: result.total, ...(places.length ? {} : { hint: "No matches. Place and city names in the snapshot use their local spelling (Warszawa, Roma, București). If the request named a city, retry once with that city in the city field and no query." }), places: places.map((place) => ({ id: place.id, name: place.name, category: place.category, countryCode: place.countryCode, city: place.city, postcode: place.postcode, street: place.street, houseNumber: place.houseNumber, details: place.details, lat: place.lat, lon: place.lon })) },
      places,
      totalPlaces: result.total,
      placeSearch: { kind: parsed.data.kind ?? null, city: parsed.data.city ?? null, query: parsed.data.query ?? null, category: parsed.data.category ?? null },
      resultsFound: places.length,
    };
  }

  const parsed = listSourcesArgs.safeParse(rawArgs);
  if (!parsed.success) return { content: { error: "This tool takes no arguments." }, resultsFound: 0 };
  const allSources = await getSources([]);
  const visibleSources = sourceIds?.length ? allSources.filter((source) => sourceIds.includes(source.id)) : allSources;
  const limitedSources = visibleSources.slice(0, 20);
  return {
    content: { total: visibleSources.length, sources: limitedSources },
    sourceIds: visibleSources.map((source) => source.id),
    resultsFound: limitedSources.length,
  };
}

function latestDate(a?: string, b?: string) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function earliestDate(a?: string, b?: string) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function compactRecord(record: RecordView) {
  return {
    id: record.id,
    sourceId: record.sourceId,
    observedAt: record.observedAt,
    label: record.label,
    lat: record.lat,
    lon: record.lon,
    attributes: compactAttributes(record.attributes),
  };
}

function compactAttributes(attributes: Record<string, unknown>) {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes).slice(0, 16)) {
    if (typeof value === "string") compact[key.slice(0, 40)] = value.slice(0, 100);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) compact[key.slice(0, 40)] = value;
    else compact[key.slice(0, 40)] = JSON.stringify(value).slice(0, 100);
    if (JSON.stringify(compact).length >= 250) break;
  }
  return compact;
}

const CITY_RADIUS_METERS: Record<string, number> = { "place:city": 8_000, "place:town": 4_000 };

/**
 * Most OSM rows carry no address city, so a city filter alone misses most places in it. A named city is resolved to
 * its verified settlement (local or English name) and searched by radius; the address field is the fallback.
 */
async function searchPlacesInCity(input: z.infer<typeof searchPlacesArgs> & { limit: number; sourceIds?: string[] }) {
  const { kind, ...rest } = input;
  // A city with no kind, category, or name would return whatever rows are nearest (mostly bare addresses),
  // so it means sights: attractions and museums.
  const categories = input.category
    ? [input.category]
    : kind ? PLACE_KINDS[kind]! : input.city && !input.query ? SIGHTSEEING : [undefined];
  if (input.city) {
    const settlement = await resolveSettlement(input.city);
    if (settlement) {
      const { city: _city, countryCode: _countryCode, ...filters } = rest;
      const results = await Promise.all(categories.map((category) => searchNearbyPlaces({
        ...filters,
        category,
        center: { lat: settlement.lat, lon: settlement.lon },
        radiusMeters: CITY_RADIUS_METERS[settlement.category] ?? 2_500,
      })));
      const named = interleave(results.map((result) => result.places.filter((place) => /\p{L}/u.test(place.name)))).slice(0, input.limit);
      if (named.length) return { total: results.reduce((sum, result) => sum + result.total, 0), places: named };
    }
  }
  const results = await Promise.all(categories.map((category) => searchPlaces({ ...rest, category })));
  return { total: results.reduce((sum, result) => sum + result.total, 0), places: interleave(results.map((result) => result.places)).slice(0, input.limit) };
}

/** Alternates between result lists so a kind with several categories shows some of each. */
function interleave<T extends { id: string }>(lists: T[][]): T[] {
  const merged: T[] = [];
  for (let position = 0; position < Math.max(0, ...lists.map((list) => list.length)); position += 1) {
    for (const list of lists) if (list[position]) merged.push(list[position]!);
  }
  return [...new Map(merged.map((item) => [item.id, item])).values()];
}
