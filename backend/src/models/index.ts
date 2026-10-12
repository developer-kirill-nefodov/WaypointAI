import { database } from "../database/client.js";
import { initModels as initializeModels } from "./record.js";
import { RecordModel } from "./record.js";
import { initPlaceModel, Place } from "./place.js";
import { Source } from "./source.js";
import { initConversationModel } from "./conversation.js";
import { initSourceSyncRunModel, SourceSyncRun } from "./source-sync-run.js";
import { initRecordPlaceLinkModel, RecordPlaceLink } from "./record-place-link.js";

let initialized = false;
export function initModels(): void {
  if (initialized) return;
  initializeModels(database);
  initPlaceModel(database);
  initConversationModel(database);
  initSourceSyncRunModel(database);
  initRecordPlaceLinkModel(database);
  RecordModel.belongsTo(Source, { foreignKey: "sourceId", as: "source" });
  Source.hasMany(RecordModel, { foreignKey: "sourceId", as: "records" });
  Place.belongsTo(Source, { foreignKey: "sourceId", as: "source" });
  Source.hasMany(Place, { foreignKey: "sourceId", as: "places" });
  RecordModel.belongsTo(Place, { foreignKey: "placeId", as: "place" });
  Place.hasMany(RecordModel, { foreignKey: "placeId", as: "records" });
  SourceSyncRun.belongsTo(Source, { foreignKey: "sourceId", as: "source" });
  Source.hasMany(SourceSyncRun, { foreignKey: "sourceId", as: "syncRuns" });
  RecordPlaceLink.belongsTo(RecordModel, { foreignKey: "recordId", as: "record" });
  RecordPlaceLink.belongsTo(Place, { foreignKey: "placeId", as: "place" });
  RecordModel.hasMany(RecordPlaceLink, { foreignKey: "recordId", as: "placeLinks" });
  Place.hasMany(RecordPlaceLink, { foreignKey: "placeId", as: "recordLinks" });
  initialized = true;
}
