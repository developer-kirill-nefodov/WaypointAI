import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Source } from "../models/source.js";

initModels();

export async function listSources() {
  try {
    await database.authenticate();
    return await Source.findAll({
      attributes: ["id", "label", "mode", "status", "attribution", "snapshotDate", "sourceUrl", "license"],
      order: [["label", "ASC"]],
      raw: true,
    });
  } catch {
    return [];
  }
}
