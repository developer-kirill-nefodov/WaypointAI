import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Source } from "../models/source.js";
import { getSyncSummaries } from "./investigation.repository.js";

initModels();

export async function listSources() {
  try {
    await database.authenticate();
    const [sources, syncBySource] = await Promise.all([
      // A deleted dataset keeps its row for the sync history, marked unavailable; it is not offered as a source.
      Source.findAll({
        where: { status: "ready" },
        attributes: ["id", "label", "mode", "status", "attribution", "snapshotDate", "sourceUrl", "license"],
        order: [["label", "ASC"]],
        raw: true,
      }),
      // Sync status is optional: a failure here must not hide the source list.
      getSyncSummaries().catch(() => new Map()),
    ]);
    // lastSync is null for snapshot sources that are not imported through the event pipeline.
    return sources.map((source) => ({ ...source, lastSync: syncBySource.get(source.id) ?? null }));
  } catch {
    return [];
  }
}
