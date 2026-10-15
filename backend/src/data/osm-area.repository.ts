import { Op } from "sequelize";
import { randomUUID } from "node:crypto";
import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Place } from "../models/place.js";
import { Source } from "../models/source.js";
import { SourceSyncRun } from "../models/source-sync-run.js";
import type { OsmAreaStore } from "../services/osm-area-import.js";

initModels();

const BATCH_SIZE = 1000;

export const sqlOsmAreaStore: OsmAreaStore = {
  async registerAreaSource({ sourceId, label, sourceUrl, snapshotDate }) {
    await Source.upsert({
      id: sourceId,
      label: label.slice(0, 200),
      mode: "public_snapshot",
      status: "ready",
      attribution: "© OpenStreetMap contributors",
      sourceUrl,
      license: "ODbL-1.0",
      snapshotDate,
    });
  },

  async startRun(sourceId, startedAt) {
    // The area's dataset row may not exist yet; runs reference it, so it is created first with a placeholder label.
    await Source.findOrCreate({
      where: { id: sourceId },
      defaults: { id: sourceId, label: sourceId, mode: "public_snapshot", status: "ready", attribution: "© OpenStreetMap contributors", license: "ODbL-1.0" },
    });
    const run = await SourceSyncRun.create({ id: randomUUID(), sourceId, status: "running", startedAt, windowStart: startedAt, windowEnd: startedAt });
    return run.id;
  },

  async upsertPlaces(sourceId, places, importToken) {
    let inserted = 0;
    let updated = 0;
    await database.transaction(async (transaction) => {
      for (let start = 0; start < places.length; start += BATCH_SIZE) {
        const batch = places.slice(start, start + BATCH_SIZE);
        const existing = await Place.findAll({ where: { id: { [Op.in]: batch.map((place) => place.id) } }, attributes: ["id", "sourceId"], transaction });
        const owner = new Map(existing.map((row) => [row.get("id") as string, row.get("sourceId") as string]));
        // A place another dataset already holds (an overlapping regional extract) stays with that dataset.
        const rows = batch.filter((place) => !owner.has(place.id) || owner.get(place.id) === sourceId);
        inserted += rows.filter((place) => !owner.has(place.id)).length;
        updated += rows.filter((place) => owner.has(place.id)).length;
        if (!rows.length) continue;
        await Place.bulkCreate(rows.map((place) => ({ ...place, sourceId, importToken })) as never[], {
          transaction,
          updateOnDuplicate: ["name", "category", "countryCode", "region", "city", "postcode", "street", "houseNumber", "lat", "lon", "tags", "importToken", "updatedAt"],
        });
      }
    });
    return { inserted, updated };
  },

  async finishRun(runId, outcome) {
    await SourceSyncRun.update({
      status: outcome.status,
      finishedAt: outcome.finishedAt,
      fetchedCount: outcome.fetched,
      insertedCount: outcome.inserted,
      updatedCount: outcome.updated,
      skippedCount: 0,
      errorCode: outcome.errorCode,
    }, { where: { id: runId } });
  },
};
