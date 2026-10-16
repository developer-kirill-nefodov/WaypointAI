import { z } from "zod";
import { SEARCH_LIMITS } from "../config/search-limits.js";
import type { EventCursor, EventSearchInput } from "../data/investigation.repository.js";
import { DEFAULT_IMPORT_DAYS, MAX_IMPORT_DAYS } from "../services/event-import.js";
import { isValidBbox, type Bbox } from "../services/geometry.js";
import { DAY_MS } from "../services/time.js";
import { INGV_SOURCE_ID } from "../sources/ingv/ingv.adapter.js";
import { USGS_SOURCE_ID } from "../sources/usgs/usgs.adapter.js";

/** When one earthquake is in several catalogues, the regional one (more precise for Italy) is listed. */
export const EVENT_MERGE_PRIORITY = [INGV_SOURCE_ID, USGS_SOURCE_ID];

const { radiusKm, magnitude, windowDays, eventPageLimit, maxSourceIds } = SEARCH_LIMITS;
/** Linked events shown on one place's details. */
const ENTITY_LINKED_EVENTS_LIMIT = { default: 20, max: 100 };

// Express gives "" for "?minMagnitude=", which z.coerce.number() would turn into 0.
const optionalNumber = (schema: z.ZodNumber) => z.preprocess(
  (value) => value === "" ? undefined : value,
  z.coerce.number().pipe(schema).optional(),
);

const eventQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  bbox: z.string().max(100).optional(),
  lat: optionalNumber(z.number().min(-90).max(90)),
  lon: optionalNumber(z.number().min(-180).max(180)),
  radiusKm: optionalNumber(z.number().positive().max(radiusKm.max)),
  minMagnitude: optionalNumber(z.number().min(magnitude.min).max(magnitude.max)),
  maxMagnitude: optionalNumber(z.number().min(magnitude.min).max(magnitude.max)),
  sourceIds: z.string().max(500).optional(),
  category: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(eventPageLimit.max).default(eventPageLimit.default),
  cursor: z.string().max(300).optional(),
  /** "true" lists an earthquake reported by several catalogues once. */
  merge: z.enum(["true", "false"]).optional(),
  crossCheck: z.enum(["confirmed", "conflict"]).optional(),
}).strict();

type EventQuery = z.infer<typeof eventQuerySchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validates and bounds GET /investigations/events parameters; every query gets a finite time window. */
export function parseEventSearchQuery(query: unknown, now = new Date()): ParseResult<EventSearchInput> {
  const parsed = eventQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: false, error: "invalid_query" };
  const value = parsed.data;

  const to = value.to ? new Date(value.to) : now;
  const from = value.from ? new Date(value.from) : new Date(to.getTime() - windowDays.default * DAY_MS);
  if (from >= to || to.getTime() - from.getTime() > windowDays.max * DAY_MS) {
    return { ok: false, error: "invalid_time_window" };
  }

  const near = parseCircle(value);
  if (!near.ok) return near;
  if (near.value && value.bbox) return { ok: false, error: "invalid_area_filter" };

  let bbox: Bbox | undefined;
  if (value.bbox) {
    const parts = value.bbox.split(",").map((part) => part.trim() === "" ? Number.NaN : Number(part));
    if (!isValidBbox(parts)) return { ok: false, error: "invalid_bbox" };
    bbox = parts;
  }

  if (value.minMagnitude !== undefined && value.maxMagnitude !== undefined && value.minMagnitude > value.maxMagnitude) {
    return { ok: false, error: "invalid_magnitude_range" };
  }

  let cursor: EventCursor | undefined;
  if (value.cursor) {
    const decoded = decodeEventCursor(value.cursor);
    if (!decoded) return { ok: false, error: "invalid_cursor" };
    cursor = decoded;
  }

  return {
    ok: true,
    value: {
      from,
      to,
      bbox,
      near: near.value,
      minMagnitude: value.minMagnitude,
      maxMagnitude: value.maxMagnitude,
      sourceIds: parseSourceIds(value.sourceIds),
      category: value.category,
      ...(value.crossCheck ? { crossCheck: value.crossCheck } : {}),
      ...(value.merge === "true" ? { mergePriority: EVENT_MERGE_PRIORITY } : {}),
      limit: value.limit,
      cursor,
    },
  };
}

/** A radius filter needs lat, lon, and radiusKm together. */
function parseCircle(value: EventQuery): ParseResult<EventSearchInput["near"]> {
  const { lat, lon, radiusKm: radius } = value;
  if (lat === undefined && lon === undefined && radius === undefined) return { ok: true, value: undefined };
  if (lat === undefined || lon === undefined || radius === undefined) {
    return { ok: false, error: "invalid_radius_query" };
  }
  return { ok: true, value: { lat, lon, radiusMeters: radius * 1000 } };
}

/** Comma-separated source IDs; blanks are dropped and only the first maxSourceIds are used. */
function parseSourceIds(value: string | undefined): string[] | undefined {
  return value?.split(",").map((id) => id.trim()).filter(Boolean).slice(0, maxSourceIds);
}

/** Filters actually applied, so the UI and the query endpoint can show them. */
export function describeAppliedFilters(input: EventSearchInput) {
  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    ...(input.bbox ? { bbox: input.bbox } : {}),
    ...(input.near ? { near: describeCircle(input.near) } : {}),
    ...(input.minMagnitude !== undefined ? { minMagnitude: input.minMagnitude } : {}),
    ...(input.maxMagnitude !== undefined ? { maxMagnitude: input.maxMagnitude } : {}),
    ...(input.sourceIds?.length ? { sourceIds: input.sourceIds } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.crossCheck ? { crossCheck: input.crossCheck } : {}),
    ...(input.mergePriority?.length ? { merge: true } : {}),
    limit: input.limit,
  };
}

function describeCircle(near: NonNullable<EventSearchInput["near"]>) {
  return { lat: near.lat, lon: near.lon, radiusKm: near.radiusMeters / 1000 };
}

const cursorSchema = z.object({
  t: z.string().datetime(),
  id: z.string().min(1).max(120),
}).strict();

/** Opaque keyset cursor: base64url of the last row's sort key. */
export function encodeEventCursor(cursor: EventCursor): string {
  const payload = JSON.stringify({ t: cursor.observedAt.toISOString(), id: cursor.id });
  return Buffer.from(payload).toString("base64url");
}

export function decodeEventCursor(value: string): EventCursor | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? { observedAt: new Date(parsed.data.t), id: parsed.data.id } : null;
  } catch {
    return null;
  }
}

export const recordIdSchema = z.string().min(1).max(120).regex(/^[\w.:-]+$/);

export const entityLimitSchema = z.object({
  limit: z.coerce.number()
    .int()
    .min(1)
    .max(ENTITY_LINKED_EVENTS_LIMIT.max)
    .default(ENTITY_LINKED_EVENTS_LIMIT.default),
}).strict();

export const importBodySchema = z.object({
  days: z.number().int().min(1).max(MAX_IMPORT_DAYS).default(DEFAULT_IMPORT_DAYS),
}).strict();
