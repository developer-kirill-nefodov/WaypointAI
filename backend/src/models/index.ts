import { database } from "../database/client.js";
import { initModels as initializeModels } from "./record.js";
import { RecordModel } from "./record.js";
import { initPlaceModel, Place } from "./place.js";
import { Source } from "./source.js";
import { initConversationModel } from "./conversation.js";

let initialized = false;
export function initModels(): void {
  if (initialized) return;
  initializeModels(database);
  initPlaceModel(database);
  initConversationModel(database);
  RecordModel.belongsTo(Source, { foreignKey: "sourceId", as: "source" });
  Source.hasMany(RecordModel, { foreignKey: "sourceId", as: "records" });
  Place.belongsTo(Source, { foreignKey: "sourceId", as: "source" });
  Source.hasMany(Place, { foreignKey: "sourceId", as: "places" });
  RecordModel.belongsTo(Place, { foreignKey: "placeId", as: "place" });
  Place.hasMany(RecordModel, { foreignKey: "placeId", as: "records" });
  initialized = true;
}
