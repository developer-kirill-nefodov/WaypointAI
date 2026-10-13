import type { PlaceView, RecordView } from "@waypoint-ai/shared";
import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Place } from "../models/place.js";
import { RecordModel } from "../models/record.js";
import { RecordPlaceLink } from "../models/record-place-link.js";
import type { SourceSyncStatus } from "../models/source-sync-run.js";
import type { Bbox } from "../services/geometry.js";
import { degreeDeltas, haversineSql } from "./geo-sql.js";
import { getSources, RECORD_VIEW_ATTRIBUTES, toPlaceView, toRecordView, toView } from "./record.repository.js";

initModels();

/** Nearby places shown with one event; the closest come first. */
const EVENT_LINKED_PLACES_LIMIT = 20;

export interface EventCursor {
  observedAt: Date;
  id: string;
}

export interface EventSearchInput {
  from: Date;
  to: Date;
  bbox?: Bbox;
  near?: { lat: number; lon: number; radiusMeters: number };
  minMagnitude?: number;
  maxMagnitude?: number;
  sourceIds?: string[];
  category?: string;
  limit: number;
  cursor?: EventCursor;
}

export type EventView = RecordView & { distanceMeters?: number };

export interface EventSearchResult {
  total: number;
  events: EventView[];
  nextCursor: EventCursor | null;
  /** Smallest and largest magnitude over every match, not only this page; null when no match has one. */
  magnitudeRange?: { min: number; max: number } | null;
}

export interface SyncSummary {
  status: SourceSyncStatus;
  startedAt: string;
  finishedAt: string | null;
  fetchedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCode: string | null;
  lastSucceededAt: string | null;
}

type SourceRows = Awaited<ReturnType<typeof getSources>>;

export interface EventDetails {
  event: RecordView;
  linkedPlaces: Array<{ relation: "nearby"; distanceMeters: number; place: PlaceView }>;
  sources: SourceRows;
  lastSync: SyncSummary | null;
}

export interface EntityDetails {
  place: PlaceView;
  linkedEvents: Array<{ relation: "nearby"; distanceMeters: number; event: RecordView }>;
  totalLinkedEvents: number;
  sources: SourceRows;
}

interface EventRow {
  id: string;
  source_id: string;
  observed_at: Date;
  lat: number;
  lon: number;
  accuracy_meters: number | null;
  category: string;
  attributes: Record<string, unknown>;
  distance_meters: number | null;
}

interface SyncRunRow {
  source_id: string;
  status: SourceSyncStatus;
  started_at: Date;
  finished_at: Date | null;
  fetched_count: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  error_code: string | null;
}

/** Appends a bind value and returns its positional placeholder. */
type BindParam = (value: unknown) => string;

// Numeric attributes are compared only when the JSON value is a number, so a malformed row cannot break the cast.
const MAGNITUDE_SQL = "(CASE WHEN jsonb_typeof(r.attributes->'magnitude') = 'number' "
  + "THEN (r.attributes->>'magnitude')::double precision END)";

export async function searchEvents(input: EventSearchInput): Promise<EventSearchResult> {
  await database.authenticate();
  const bind: unknown[] = [];
  const param: BindParam = (value) => {
    bind.push(value);
    return `$${bind.length}`;
  };
  const filter = buildEventFilter(input, param);
  const where = filter.conditions.join(" AND ");
  // Snapshot before the cursor and LIMIT placeholders are added: the total covers every page, and
  // PostgreSQL rejects bind values that the count query does not reference.
  const countBind = [...bind];
  const pageWhere = input.cursor ? `${where} AND ${cursorCondition(input.cursor, param)}` : where;
  const limitParam = param(input.limit + 1);

  const [[countRows], [rows]] = await Promise.all([
    database.query(
      `SELECT count(*)::integer AS total, min(${MAGNITUDE_SQL}) AS min_magnitude, max(${MAGNITUDE_SQL}) AS max_magnitude
       FROM records r WHERE ${where}`,
      { bind: countBind },
    ),
    database.query(
      `SELECT r.id, r.source_id, r.observed_at, r.lat, r.lon, r.accuracy_meters, r.category, r.attributes,
         ${filter.distanceSql} AS distance_meters
       FROM records r
       WHERE ${pageWhere}
       ORDER BY r.observed_at DESC, r.id ASC
       LIMIT ${limitParam}`,
      { bind },
    ),
  ]);

  const eventRows = rows as EventRow[];
  const page = eventRows.slice(0, input.limit).map(rowToEventView);
  const last = page.at(-1);
  const hasMore = eventRows.length > input.limit;
  const summary = (countRows as Array<{ total: number; min_magnitude: number | null; max_magnitude: number | null }>)[0];
  return {
    total: Number(summary?.total ?? 0),
    magnitudeRange: summary?.min_magnitude == null || summary.max_magnitude == null
      ? null
      : { min: Number(summary.min_magnitude), max: Number(summary.max_magnitude) },
    events: page,
    nextCursor: hasMore && last ? { observedAt: new Date(last.observedAt), id: last.id } : null,
  };
}

/** WHERE conditions for every filter, plus the distance expression when a circle is given. */
function buildEventFilter(input: EventSearchInput, param: BindParam): { conditions: string[]; distanceSql: string } {
  const conditions = [`r.observed_at >= ${param(input.from)}`, `r.observed_at <= ${param(input.to)}`];
  let distanceSql = "NULL::double precision";

  if (input.sourceIds?.length) conditions.push(`r.source_id = ANY(${param(input.sourceIds)}::varchar[])`);
  if (input.category) conditions.push(`r.category = ${param(input.category)}`);
  if (input.minMagnitude !== undefined) conditions.push(`${MAGNITUDE_SQL} >= ${param(input.minMagnitude)}`);
  if (input.maxMagnitude !== undefined) conditions.push(`${MAGNITUDE_SQL} <= ${param(input.maxMagnitude)}`);
  if (input.bbox) {
    const [minLon, minLat, maxLon, maxLat] = input.bbox;
    conditions.push(
      `r.lat BETWEEN ${param(minLat)} AND ${param(maxLat)}`,
      `r.lon BETWEEN ${param(minLon)} AND ${param(maxLon)}`,
    );
  }
  if (input.near) {
    const { lat, lon, radiusMeters } = input.near;
    const delta = degreeDeltas(lat, radiusMeters);
    const center = { lat: param(lat), lon: param(lon) };
    distanceSql = haversineSql({ lat: "r.lat", lon: "r.lon" }, center);
    // Bounding-box prefilter uses the (lat, lon) index; the haversine check makes the circle exact.
    conditions.push(
      `r.lat BETWEEN ${param(lat - delta.lat)} AND ${param(lat + delta.lat)}`,
      `r.lon BETWEEN ${param(lon - delta.lon)} AND ${param(lon + delta.lon)}`,
      `${distanceSql} <= ${param(radiusMeters)}`,
    );
  }
  return { conditions, distanceSql };
}

/** Keyset pagination for ORDER BY observed_at DESC, id ASC. */
function cursorCondition(cursor: EventCursor, param: BindParam): string {
  const cursorTime = param(cursor.observedAt);
  return `(r.observed_at < ${cursorTime} OR (r.observed_at = ${cursorTime} AND r.id > ${param(cursor.id)}))`;
}

export async function getEventDetails(id: string): Promise<EventDetails | null> {
  await database.authenticate();
  const row = await RecordModel.findByPk(id, { attributes: RECORD_VIEW_ATTRIBUTES });
  if (!row) return null;
  const event = toView(row);
  const links = await RecordPlaceLink.findAll({
    where: { recordId: id },
    include: [{ model: Place, as: "place", required: true }],
    order: [["distanceMeters", "ASC"], ["placeId", "ASC"]],
    limit: EVENT_LINKED_PLACES_LIMIT,
  });
  const linkedPlaces = links.map((link) => ({
    relation: link.relation,
    distanceMeters: link.distanceMeters,
    // required: true above guarantees the included place.
    place: toPlaceView(link.place!),
  }));
  const sourceIds = [...new Set([event.sourceId, ...linkedPlaces.map((link) => link.place.sourceId)])];
  const [sources, syncBySource] = await Promise.all([
    getSources(sourceIds),
    getSyncSummaries([event.sourceId]),
  ]);
  return { event, linkedPlaces, sources, lastSync: syncBySource.get(event.sourceId) ?? null };
}

export async function getEntityDetails(id: string, limit: number): Promise<EntityDetails | null> {
  await database.authenticate();
  const row = await Place.findByPk(id);
  if (!row) return null;
  const place = toPlaceView(row);
  const { rows, count } = await RecordPlaceLink.findAndCountAll({
    where: { placeId: id },
    include: [{
      model: RecordModel,
      as: "record",
      required: true,
      attributes: RECORD_VIEW_ATTRIBUTES,
    }],
    order: [[{ model: RecordModel, as: "record" }, "observedAt", "DESC"], ["recordId", "ASC"]],
    limit,
  });
  const linkedEvents = rows.map((link) => ({
    relation: link.relation,
    distanceMeters: link.distanceMeters,
    // required: true above guarantees the included record.
    event: toView(link.record!),
  }));
  const sourceIds = [...new Set([place.sourceId, ...linkedEvents.map((link) => link.event.sourceId)])];
  const sources = await getSources(sourceIds);
  return { place, linkedEvents, totalLinkedEvents: count, sources };
}

export async function getSyncSummaries(sourceIds?: string[]): Promise<Map<string, SyncSummary>> {
  const filter = sourceIds?.length ? "WHERE source_id = ANY($1::varchar[])" : "";
  const bind = sourceIds?.length ? [sourceIds] : [];
  const [[latestRows], [successRows]] = await Promise.all([
    database.query(
      `SELECT DISTINCT ON (source_id) source_id, status, started_at, finished_at,
         fetched_count, inserted_count, updated_count, skipped_count, error_code
       FROM source_sync_runs ${filter}
       ORDER BY source_id, started_at DESC`,
      { bind },
    ),
    database.query(
      `SELECT source_id, max(finished_at) AS last_succeeded_at
       FROM source_sync_runs ${filter ? `${filter} AND` : "WHERE"} status = 'succeeded'
       GROUP BY source_id`,
      { bind },
    ),
  ]);
  const lastSuccess = new Map((successRows as Array<{ source_id: string; last_succeeded_at: Date | null }>)
    .map((row) => [row.source_id, row.last_succeeded_at]));
  return new Map((latestRows as SyncRunRow[]).map((row) => {
    const succeededAt = lastSuccess.get(String(row.source_id));
    return [String(row.source_id), toSyncSummary(row, succeededAt ?? null)];
  }));
}

function toSyncSummary(row: SyncRunRow, succeededAt: Date | null): SyncSummary {
  return {
    status: row.status,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    fetchedCount: Number(row.fetched_count),
    insertedCount: Number(row.inserted_count),
    updatedCount: Number(row.updated_count),
    skippedCount: Number(row.skipped_count),
    errorCode: row.error_code ?? null,
    lastSucceededAt: succeededAt ? new Date(succeededAt).toISOString() : null,
  };
}

function rowToEventView(row: EventRow): EventView {
  const view = toRecordView({
    id: String(row.id),
    sourceId: String(row.source_id),
    observedAt: row.observed_at,
    lat: row.lat,
    lon: row.lon,
    accuracyMeters: row.accuracy_meters,
    category: row.category,
    attributes: row.attributes,
  });
  if (row.distance_meters === null || row.distance_meters === undefined) return view;
  return { ...view, distanceMeters: Math.round(Number(row.distance_meters)) };
}

