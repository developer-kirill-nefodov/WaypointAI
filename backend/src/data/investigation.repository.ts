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
  /** Only events another catalogue confirms, or whose descriptions disagree. */
  crossCheck?: "confirmed" | "conflict";
  /**
   * Source IDs from most to least preferred. When given, an event that another catalogue also reports is listed once:
   * the copy from the preferred source is kept if it matches the same filters.
   */
  mergePriority?: string[];
  limit: number;
  cursor?: EventCursor;
}

/** How an event compares with other live catalogues; see services/event-matching.ts for the rules. */
export interface CrossCheckSummary {
  /**
   * confirmed: another catalogue reports it and the descriptions agree; conflict: reported, but magnitude or depth
   * differ; single: another catalogue was imported for that time but does not report it; unchecked: nothing to compare.
   */
  status: "confirmed" | "conflict" | "single" | "unchecked";
  matchedSourceIds: string[];
  /** Other live sources whose successful imports cover the event's time. */
  checkedSourceIds: string[];
}

export interface CrossCheckMatch {
  event: RecordView;
  timeDeltaMs: number;
  distanceMeters: number;
  magnitudeDelta: number | null;
  depthDeltaKm: number | null;
  consistent: boolean;
}

export type EventView = RecordView & { distanceMeters?: number; crossCheck?: CrossCheckSummary };

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
  crossCheck: CrossCheckSummary & { matches: CrossCheckMatch[] };
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
  const pageRows = eventRows.slice(0, input.limit).map(rowToEventView);
  const crossChecks = await getCrossChecks(pageRows);
  const page = pageRows.map((event) => ({ ...event, crossCheck: crossChecks.get(event.id)! }));
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

/**
 * WHERE conditions for every filter, plus the distance expression when a circle is given. `alias` names the records
 * table, so the same filters can be applied to the other copy of a matched event.
 */
function buildEventFilter(input: EventSearchInput, param: BindParam, alias = "r", withMerge = true): { conditions: string[]; distanceSql: string } {
  const a = alias;
  const magnitude = MAGNITUDE_SQL.replaceAll("r.", `${a}.`);
  const conditions = [`${a}.observed_at >= ${param(input.from)}`, `${a}.observed_at <= ${param(input.to)}`];
  let distanceSql = "NULL::double precision";

  if (input.sourceIds?.length) conditions.push(`${a}.source_id = ANY(${param(input.sourceIds)}::varchar[])`);
  if (input.category) conditions.push(`${a}.category = ${param(input.category)}`);
  if (input.minMagnitude !== undefined) conditions.push(`${magnitude} >= ${param(input.minMagnitude)}`);
  if (input.maxMagnitude !== undefined) conditions.push(`${magnitude} <= ${param(input.maxMagnitude)}`);
  if (input.bbox) {
    const [minLon, minLat, maxLon, maxLat] = input.bbox;
    conditions.push(
      `${a}.lat BETWEEN ${param(minLat)} AND ${param(maxLat)}`,
      `${a}.lon BETWEEN ${param(minLon)} AND ${param(maxLon)}`,
    );
  }
  if (input.near) {
    const { lat, lon, radiusMeters } = input.near;
    const delta = degreeDeltas(lat, radiusMeters);
    const center = { lat: param(lat), lon: param(lon) };
    distanceSql = haversineSql({ lat: `${a}.lat`, lon: `${a}.lon` }, center);
    // Bounding-box prefilter uses the (lat, lon) index; the haversine check makes the circle exact.
    conditions.push(
      `${a}.lat BETWEEN ${param(lat - delta.lat)} AND ${param(lat + delta.lat)}`,
      `${a}.lon BETWEEN ${param(lon - delta.lon)} AND ${param(lon + delta.lon)}`,
      `${distanceSql} <= ${param(radiusMeters)}`,
    );
  }
  if (input.crossCheck) {
    conditions.push(`EXISTS (SELECT 1 FROM record_matches m WHERE (m.record_id = ${a}.id OR m.matched_record_id = ${a}.id) AND m.consistent = ${input.crossCheck === "confirmed" ? "true" : "false"})`);
  }
  if (withMerge && input.mergePriority?.length) {
    // Hide this copy when a copy from a preferred source passes the same filters (it is listed instead).
    const priority = param(input.mergePriority);
    const other = buildEventFilter({ ...input, crossCheck: undefined }, param, `${a}_o`, false);
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM record_matches m
      JOIN records ${a}_o ON ${a}_o.id = CASE WHEN m.record_id = ${a}.id THEN m.matched_record_id ELSE m.record_id END
      WHERE (m.record_id = ${a}.id OR m.matched_record_id = ${a}.id)
        AND coalesce(array_position(${priority}::varchar[], ${a}_o.source_id), 1000) < coalesce(array_position(${priority}::varchar[], ${a}.source_id), 1000)
        AND ${other.conditions.join(" AND ")})`);
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
  const [crossCheck, syncBySource] = await Promise.all([
    getEventCrossCheck(event),
    getSyncSummaries([event.sourceId]),
  ]);
  const sources = await getSources([...new Set([...sourceIds, ...crossCheck.matches.map((match) => match.event.sourceId)])]);
  return { event, linkedPlaces, sources, lastSync: syncBySource.get(event.sourceId) ?? null, crossCheck };
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

type MatchRecordRow = EventRow & { other_of: string; time_delta_ms: number; match_distance_meters: number; magnitude_delta: number | null; depth_delta_km: number | null; consistent: boolean };

/** Every match of these events, with the other event's row. */
async function findMatches(ids: string[]): Promise<MatchRecordRow[]> {
  if (!ids.length) return [];
  // A pair is stored once, so it is read from both sides: both events of a pair can be on the same page.
  const side = (own: string, other: string) => `SELECT o.id, o.source_id, o.observed_at, o.lat, o.lon, o.accuracy_meters, o.category, o.attributes,
       NULL AS distance_meters, m.${own} AS other_of,
       m.time_delta_ms, m.distance_meters AS match_distance_meters, m.magnitude_delta, m.depth_delta_km, m.consistent
     FROM record_matches m JOIN records o ON o.id = m.${other}
     WHERE m.${own} = ANY($1::varchar[])`;
  const [rows] = await database.query(
    `${side("record_id", "matched_record_id")} UNION ALL ${side("matched_record_id", "record_id")} ORDER BY time_delta_ms`,
    { bind: [ids] },
  );
  return rows as MatchRecordRow[];
}

type CoverageRow = { source_id: string; window_start: Date; window_end: Date };

/** Successful import windows of live sources, to tell "not reported by another catalogue" from "not compared". */
async function liveCoverage(from: Date, to: Date): Promise<CoverageRow[]> {
  const [rows] = await database.query(
    `SELECT runs.source_id, runs.window_start, runs.window_end FROM source_sync_runs runs
     JOIN data_sources s ON s.id = runs.source_id AND s.mode = 'approved_live' AND s.status = 'ready'
     WHERE runs.status = 'succeeded' AND runs.window_start <= $2 AND runs.window_end >= $1`,
    { bind: [from, to] },
  );
  return rows as CoverageRow[];
}

function summarize(event: RecordView, sourceMode: string | undefined, matches: Array<{ sourceId: string; consistent: boolean }>, coverage: CoverageRow[]): CrossCheckSummary {
  const time = Date.parse(event.observedAt);
  const checkedSourceIds = sourceMode === "approved_live"
    ? [...new Set(coverage.filter((run) => run.source_id !== event.sourceId && new Date(run.window_start).getTime() <= time && new Date(run.window_end).getTime() >= time).map((run) => run.source_id))]
    : [];
  const matchedSourceIds = [...new Set(matches.map((match) => match.sourceId))];
  const status = matches.length ? (matches.every((match) => match.consistent) ? "confirmed" : "conflict") : checkedSourceIds.length ? "single" : "unchecked";
  return { status, matchedSourceIds, checkedSourceIds: [...new Set([...checkedSourceIds, ...matchedSourceIds])] };
}

/** Cross-check summaries for a page of events. */
export async function getCrossChecks(events: RecordView[]): Promise<Map<string, CrossCheckSummary>> {
  if (!events.length) return new Map();
  const times = events.map((event) => Date.parse(event.observedAt));
  const [matches, coverage, sources] = await Promise.all([
    findMatches(events.map((event) => event.id)),
    liveCoverage(new Date(Math.min(...times)), new Date(Math.max(...times))),
    getSources([...new Set(events.map((event) => event.sourceId))]),
  ]);
  const modes = new Map(sources.map((source) => [source.id, source.mode]));
  return new Map(events.map((event) => [event.id, summarize(
    event,
    modes.get(event.sourceId),
    matches.filter((match) => match.other_of === event.id).map((match) => ({ sourceId: String(match.source_id), consistent: match.consistent })),
    coverage,
  )]));
}

async function getEventCrossCheck(event: RecordView): Promise<CrossCheckSummary & { matches: CrossCheckMatch[] }> {
  const time = new Date(event.observedAt);
  const [rows, coverage, sources] = await Promise.all([findMatches([event.id]), liveCoverage(time, time), getSources([event.sourceId])]);
  const matches = rows.map((row): CrossCheckMatch => ({
    event: rowToEventView(row),
    timeDeltaMs: Number(row.time_delta_ms),
    distanceMeters: Number(row.match_distance_meters),
    magnitudeDelta: row.magnitude_delta === null ? null : Number(row.magnitude_delta),
    depthDeltaKm: row.depth_delta_km === null ? null : Number(row.depth_delta_km),
    consistent: row.consistent,
  }));
  return { ...summarize(event, sources[0]?.mode, matches.map((match) => ({ sourceId: match.event.sourceId, consistent: match.consistent })), coverage), matches };
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

