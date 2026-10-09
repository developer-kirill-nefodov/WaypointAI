import { z } from "zod";
import type { PlaceView, RecordView, Scope, ToolName } from "@waypoint-ai/shared";
import { getRecordDetails, getSources, searchPlaces, searchRecords } from "../data/record.repository.js";
import type { ToolDefinition } from "../llm/ollama.provider.js";

const searchRecordsArgs = z.object({
  query: z.string().max(100).optional(),
  category: z.string().max(120).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const recordDetailsArgs = z.object({ id: z.string().min(1).max(120) }).strict();
const searchPlacesArgs = z.object({
  query: z.string().max(100).optional(),
  category: z.string().max(120).optional(),
  countryCode: z.enum(["DE", "PL", "RO", "FR", "IT", "ES"]).optional(),
  city: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const listSourcesArgs = z.object({}).strict();

export const assistantToolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_records",
      description: "Search records from configured local sources. Use for questions about records, categories, dates, or map points. Check source metadata and describe the source accurately.",
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
      description: "Search actual named places and POIs in local OpenStreetMap regional snapshots: Berlin (DE), Mazovian Voivodeship (PL), all Romania (RO), Île-de-France (FR), Central Italy (IT), Madrid (ES). Place names are real OSM data, not synthetic; the snapshot may be incomplete or outdated. These are not full-country coverage except Romania. For broad category searches (for example restaurants or cities), pass category and countryCode only. Use city only when the user names one specific city; do not put a country or city name in query when using those fields. query is for a place name, street, or postcode fragment. Not live web search.",
      parameters: { type: "object", additionalProperties: false, properties: {
        query: { type: "string", maxLength: 100, description: "Name, street, city, or postcode fragment to search." },
        category: { type: "string", maxLength: 120, description: "Partial OSM category tag, e.g. restaurant, amenity:cafe, place:city, or shop:supermarket." },
        countryCode: { type: "string", enum: ["DE", "PL", "RO", "FR", "IT", "ES"], description: "ISO 3166-1 alpha-2 code for a named country." },
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
];

export interface ToolExecutionResult {
  content: unknown;
  records?: RecordView[];
  totalRecords?: number;
  places?: PlaceView[];
  totalPlaces?: number;
  sourceIds?: string[];
  resultsFound: number;
}

export async function executeAssistantTool(
  name: ToolName,
  rawArgs: unknown,
  scope: Scope,
  sourceIds?: string[],
): Promise<ToolExecutionResult> {
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
    const result = await searchPlaces({ ...parsed.data, limit: Math.min(parsed.data.limit ?? 10, 10), sourceIds });
    const places = result.places as PlaceView[];
    return {
      content: { total: result.total, places: places.map((place) => ({ id: place.id, name: place.name, category: place.category, countryCode: place.countryCode, city: place.city, postcode: place.postcode, street: place.street, houseNumber: place.houseNumber, details: place.details, lat: place.lat, lon: place.lon })) },
      places,
      totalPlaces: result.total,
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
