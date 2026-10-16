import type { Scope } from "@waypoint-ai/shared";
import { buildEventSearch, complementFromText, dropNonSettlementPlace, resolveSearchCenter, type GeoPoint } from "../assistant/event-search.js";
import { searchEvents } from "../data/investigation.repository.js";
import { EVENT_MERGE_PRIORITY } from "../api/investigation-params.js";
import { getSources } from "../data/record.repository.js";
import { resolveSettlement } from "../data/settlement.repository.js";
import { normalizeToolArguments, searchEventsArgsSchema } from "./search-events.js";
import type { SearchArea, ToolExecutionResult } from "./assistant-tools.js";

const EVENTS_FOR_MODEL = 8;

export interface SearchEventsToolContext {
  scope: Scope;
  sourceIds?: string[];
  /** Coordinates of the verified selected map item, resolved by the server. */
  selection: (GeoPoint & { label: string }) | null;
  now?: Date;
  /** The user's message, used to fill explicit numbers the model omitted. */
  userText?: string;
  /** Injected in tests; defaults to the PostgreSQL repositories. */
  deps?: {
    searchEvents: typeof searchEvents;
    resolveSettlement: typeof resolveSettlement;
    getSources: (ids: string[]) => Promise<Array<{ id: string; mode: string }>>;
  };
}

/**
 * Chat version of the investigation search: same validation, settlement resolution, and bounds,
 * further narrowed by the chat's source and date scope. The model gets compact rows; the map gets the area.
 */
export async function executeSearchEventsTool(rawArgs: unknown, context: SearchEventsToolContext): Promise<ToolExecutionResult> {
  const parsed = searchEventsArgsSchema.safeParse(normalizeToolArguments(rawArgs));
  if (!parsed.success) return { content: { error: "Invalid search_events arguments. Use only documented fields." }, resultsFound: 0 };

  const deps = context.deps ?? { searchEvents, resolveSettlement, getSources };
  const stated = context.userText ? complementFromText(parsed.data, context.userText) : parsed.data;
  const { args, ignoredPlace } = dropNonSettlementPlace(stated);
  const center = await resolveSearchCenter(args, context.selection, deps.resolveSettlement);
  if (!center.ok) {
    const hint = center.error === "place_not_found"
      ? "The place is not a settlement in the imported OpenStreetMap regions. Say so; a search without a place is possible."
      : "No map item is selected. Ask the user to select one.";
    return { content: { error: center.error, place: args.place ?? null, hint }, resultsFound: 0 };
  }

  // An earthquake in several catalogues is counted once; each row says which other catalogues confirm it.
  const search = { ...narrowToScope(buildEventSearch(args, center.point, context.now ?? new Date()), context), mergePriority: EVENT_MERGE_PRIORITY };
  if (search.from > search.to) return { content: { total: 0, events: [], note: "The selected date range excludes this period." }, records: [], totalRecords: 0, resultsFound: 0 };

  const result = await deps.searchEvents(search);
  // Mark synthetic rows explicitly; the model otherwise tends to describe every row as real catalogue data.
  const sourceModes = new Map((await deps.getSources([...new Set(result.events.map((event) => event.sourceId))]))
    .map((source) => [source.id, source.mode]));
  const isSynthetic = (sourceId: string) => sourceModes.get(sourceId) === "synthetic_local";
  const searchArea: SearchArea | undefined = search.near ? {
    lat: search.near.lat,
    lon: search.near.lon,
    radiusKm: search.near.radiusMeters / 1000,
    label: center.resolvedPlace?.name ?? context.selection?.label ?? "",
  } : undefined;
  return {
    content: {
      total: result.total,
      appliedFilters: {
        from: search.from.toISOString(),
        to: search.to.toISOString(),
        ...(searchArea ? { center: searchArea.label, radiusKm: searchArea.radiusKm } : {}),
        ...(center.resolvedPlace?.match === "approximate" ? { approximatePlaceMatch: center.resolvedPlace.name } : {}),
        ...(ignoredPlace ? { ignoredRegion: ignoredPlace } : {}),
        ...(search.minMagnitude !== undefined ? { minMagnitude: search.minMagnitude } : {}),
        ...(search.maxMagnitude !== undefined ? { maxMagnitude: search.maxMagnitude } : {}),
      },
      ...(result.magnitudeRange ? { magnitudeRangeOfAllMatches: result.magnitudeRange } : {}),
      syntheticEventsOnThisPage: result.events.filter((event) => isSynthetic(event.sourceId)).length,
      ...crossCheckCounts(result.events),
      // The model sees a few rows; it must not describe them as the whole result.
      eventsBelowAreASample: result.total > EVENTS_FOR_MODEL
        ? `Only the ${EVENTS_FOR_MODEL} most recent of ${result.total} matches are listed. Use total and magnitudeRangeOfAllMatches for the whole result.`
        : false,
      events: result.events.slice(0, EVENTS_FOR_MODEL).map((event) => ({
        id: event.id,
        sourceId: event.sourceId,
        observedAt: event.observedAt,
        magnitude: event.attributes.magnitude ?? null,
        placeDescription: event.attributes.placeDescription ?? event.label,
        ...(isSynthetic(event.sourceId) ? { synthetic: true } : {}),
        ...(event.crossCheck && event.crossCheck.status !== "unchecked" ? { crossCheck: event.crossCheck.status, ...(event.crossCheck.matchedSourceIds.length ? { alsoReportedBy: event.crossCheck.matchedSourceIds } : {}) } : {}),
        ...(event.distanceMeters !== undefined ? { distanceKm: Math.round(event.distanceMeters / 100) / 10 } : {}),
        ...(search.near ? { directionFromCenter: compassDirection(search.near, event) } : {}),
      })),
    },
    records: result.events,
    totalRecords: result.total,
    resultsFound: result.events.length,
    ...(searchArea ? { searchArea } : {}),
  };
}

/** The chat's selected sources, date range, and category filter always win over what the model asked for. */
function narrowToScope<T extends { from: Date; to: Date; sourceIds?: string[]; category?: string }>(search: T, context: SearchEventsToolContext): T {
  const scopeCategory = typeof context.scope.filters?.category === "string" ? context.scope.filters.category.slice(0, 120) : undefined;
  const scopeFrom = context.scope.dateRange?.from ? new Date(context.scope.dateRange.from) : null;
  const scopeTo = context.scope.dateRange?.to ? new Date(context.scope.dateRange.to) : null;
  return {
    ...search,
    from: scopeFrom && scopeFrom > search.from ? scopeFrom : search.from,
    to: scopeTo && scopeTo < search.to ? scopeTo : search.to,
    ...(context.sourceIds?.length ? { sourceIds: context.sourceIds } : {}),
    ...(scopeCategory ? { category: scopeCategory } : {}),
  };
}

/**
 * How many listed events another catalogue confirms or contradicts. Omitted when nothing was compared, so the model
 * does not claim a confirmation that was never checked.
 */
function crossCheckCounts(events: Array<{ crossCheck?: { status: string } }>) {
  const counts = { confirmed: 0, conflict: 0, single: 0 };
  for (const event of events) {
    const status = event.crossCheck?.status;
    if (status === "confirmed" || status === "conflict" || status === "single") counts[status] += 1;
  }
  return counts.confirmed + counts.conflict + counts.single ? { crossCheckOnThisPage: counts } : {};
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** Eight-point compass direction from the search center, computed here so the model never guesses it. */
export function compassDirection(from: GeoPoint, to: GeoPoint): (typeof COMPASS)[number] {
  const radians = Math.PI / 180;
  const deltaLon = (to.lon - from.lon) * radians;
  const y = Math.sin(deltaLon) * Math.cos(to.lat * radians);
  const x = Math.cos(from.lat * radians) * Math.sin(to.lat * radians)
    - Math.sin(from.lat * radians) * Math.cos(to.lat * radians) * Math.cos(deltaLon);
  const bearing = (Math.atan2(y, x) / radians + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8]!;
}
