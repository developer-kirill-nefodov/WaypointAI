import { randomUUID } from "node:crypto";
import { Op, UniqueConstraintError, type Transaction } from "sequelize";
import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Source } from "../models/source.js";
import { SourceSyncRun } from "../models/source-sync-run.js";
import { ImportAlreadyRunningError, type EventImportStore, type UpsertResult } from "../services/event-import.js";
import type { NormalizedEvent } from "../sources/source-adapter.js";
import { degreeDeltasSql, haversineSql } from "./geo-sql.js";

initModels();

const UPSERT_BATCH_SIZE = 500;
const LINK_BATCH_SIZE = 200;
const NEARBY_PLACE_RADIUS_METERS = 5_000;
const NEARBY_PLACE_LIMIT = 5;

/** Upserted record columns in VALUES order; created_at and updated_at are set by the database. */
const UPSERT_COLUMNS = [
  "id",
  "source_id",
  "external_id",
  "source_revision",
  "observed_at",
  "lat",
  "lon",
  "category",
  "attributes",
] as const;
type UpsertColumn = typeof UPSERT_COLUMNS[number];
const JSONB_COLUMNS = new Set<UpsertColumn>(["attributes"]);

function recordIdFor(sourceId: string, externalId: string): string {
  return `${sourceId}:${externalId}`;
}

export const sqlEventImportStore: EventImportStore = {
  async registerSource(descriptor) {
    await database.authenticate();
    await Source.upsert({
      id: descriptor.id,
      label: descriptor.label,
      mode: descriptor.mode,
      status: "ready",
      attribution: descriptor.attribution,
      license: descriptor.license,
      sourceUrl: descriptor.sourceUrl,
      snapshotDate: null,
    });
  },

  async failStaleRuns(sourceId, startedBefore) {
    const [count] = await SourceSyncRun.update(
      { status: "failed", errorCode: "stale_run", finishedAt: new Date() },
      { where: { sourceId, status: "running", startedAt: { [Op.lt]: startedBefore } } },
    );
    return count;
  },

  async lastRunStartedAt(sourceId) {
    const run = await SourceSyncRun.findOne({
      where: { sourceId, status: { [Op.ne]: "failed" } },
      order: [["startedAt", "DESC"]],
      attributes: ["startedAt"],
    });
    return run?.startedAt ?? null;
  },

  async startRun(sourceId, window, startedAt) {
    try {
      const run = await SourceSyncRun.create({
        id: randomUUID(),
        sourceId,
        status: "running",
        startedAt,
        windowStart: window.start,
        windowEnd: window.end,
      });
      return run.id;
    } catch (error) {
      // The partial unique index allows one running import per source.
      if (error instanceof UniqueConstraintError) throw new ImportAlreadyRunningError("import_running");
      throw error;
    }
  },

  async upsertEvents(sourceId, events) {
    const result: UpsertResult = { insertedIds: [], updatedIds: [], unchanged: 0 };
    for (let offset = 0; offset < events.length; offset += UPSERT_BATCH_SIZE) {
      const batch = events.slice(offset, offset + UPSERT_BATCH_SIZE);
      const rows = await database.transaction((transaction) => upsertBatch(sourceId, batch, transaction));
      for (const row of rows) (row.inserted ? result.insertedIds : result.updatedIds).push(row.id);
      result.unchanged += batch.length - rows.length;
    }
    return result;
  },

  async linkNearbyPlaces(recordIds) {
    let linked = 0;
    for (let offset = 0; offset < recordIds.length; offset += LINK_BATCH_SIZE) {
      const batch = recordIds.slice(offset, offset + LINK_BATCH_SIZE);
      linked += await database.transaction(async (transaction) => {
        await database.query(
          "DELETE FROM record_place_links WHERE relation = 'nearby' AND record_id = ANY($1::varchar[])",
          { bind: [batch], transaction },
        );
        const [rows] = await database.query(LINK_NEARBY_SQL, {
          bind: [batch, NEARBY_PLACE_RADIUS_METERS, NEARBY_PLACE_LIMIT],
          transaction,
        });
        return (rows as unknown[]).length;
      });
    }
    return linked;
  },

  async findUnlinkedRecordIds(sourceId, window) {
    const [rows] = await database.query(
      `SELECT r.id FROM records r
       WHERE r.source_id = $1 AND r.observed_at BETWEEN $2 AND $3
         AND NOT EXISTS (SELECT 1 FROM record_place_links l WHERE l.record_id = r.id AND l.relation = 'nearby')`,
      { bind: [sourceId, window.start, window.end] },
    );
    return (rows as Array<{ id: string }>).map((row) => row.id);
  },

  async finishRun(runId, outcome) {
    await SourceSyncRun.update({
      status: outcome.status,
      finishedAt: outcome.finishedAt,
      fetchedCount: outcome.counts.fetched,
      insertedCount: outcome.counts.inserted,
      updatedCount: outcome.counts.updated,
      skippedCount: outcome.counts.skipped,
      errorCode: outcome.errorCode,
    }, { where: { id: runId } });
  },
};

function upsertValues(sourceId: string, event: NormalizedEvent): Record<UpsertColumn, unknown> {
  return {
    id: recordIdFor(sourceId, event.externalId),
    source_id: sourceId,
    external_id: event.externalId,
    source_revision: event.revision,
    observed_at: event.observedAt,
    lat: event.lat,
    lon: event.lon,
    category: event.category,
    attributes: JSON.stringify(event.attributes),
  };
}

async function upsertBatch(sourceId: string, events: NormalizedEvent[], transaction: Transaction) {
  const bind: unknown[] = [];
  const valueRows = events.map((event) => {
    const values = upsertValues(sourceId, event);
    const placeholders = UPSERT_COLUMNS.map((column) => {
      bind.push(values[column]);
      return JSONB_COLUMNS.has(column) ? `$${bind.length}::jsonb` : `$${bind.length}`;
    });
    return `(${placeholders.join(", ")}, now(), now())`;
  });
  // Unchanged revisions are not updated and not returned; xmax = 0 identifies freshly inserted rows.
  const [rows] = await database.query(
    `INSERT INTO records (${UPSERT_COLUMNS.join(", ")}, created_at, updated_at)
     VALUES ${valueRows.join(",\n")}
     ON CONFLICT (source_id, external_id) DO UPDATE SET
       source_revision = EXCLUDED.source_revision,
       observed_at = EXCLUDED.observed_at,
       lat = EXCLUDED.lat,
       lon = EXCLUDED.lon,
       category = EXCLUDED.category,
       attributes = EXCLUDED.attributes,
       updated_at = now()
     WHERE records.source_revision IS DISTINCT FROM EXCLUDED.source_revision
     RETURNING id, (xmax = 0) AS inserted`,
    { bind, transaction },
  );
  return rows as Array<{ id: string; inserted: boolean }>;
}

// $1 record IDs, $2 radius in meters, $3 places per record.
const NEARBY_DELTA_SQL = degreeDeltasSql("r.lat", "$2");
// Bounding-box prefilter on indexed lat/lon, then exact haversine distance, matching searchNearbyPlaces.
const LINK_NEARBY_SQL = `
INSERT INTO record_place_links (record_id, place_id, relation, distance_meters, created_at, updated_at)
SELECT r.id, nearest.id, 'nearby', round(nearest.distance)::integer, now(), now()
FROM records r
CROSS JOIN LATERAL (
  SELECT candidate.id, candidate.distance
  FROM (
    SELECT p.id, ${haversineSql({ lat: "p.lat", lon: "p.lon" }, { lat: "r.lat", lon: "r.lon" })} AS distance
    FROM places p
    WHERE p.lat BETWEEN r.lat - ${NEARBY_DELTA_SQL.lat} AND r.lat + ${NEARBY_DELTA_SQL.lat}
      AND p.lon BETWEEN r.lon - ${NEARBY_DELTA_SQL.lon} AND r.lon + ${NEARBY_DELTA_SQL.lon}
  ) candidate
  WHERE candidate.distance <= $2
  ORDER BY candidate.distance, candidate.id
  LIMIT $3
) nearest
WHERE r.id = ANY($1::varchar[])
RETURNING record_id`;

/**
 * Releases runs left "running" by a crashed process at startup. Only runs older than the stale limit are
 * touched: a CLI import running next to the API is still active and must not be marked failed.
 */
export async function failInterruptedRuns(staleAfterMs: number): Promise<number> {
  await database.authenticate();
  const [count] = await SourceSyncRun.update(
    { status: "failed", errorCode: "interrupted", finishedAt: new Date() },
    { where: { status: "running", startedAt: { [Op.lt]: new Date(Date.now() - staleAfterMs) } } },
  );
  return count;
}
