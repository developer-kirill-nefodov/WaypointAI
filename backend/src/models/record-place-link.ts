import { DataTypes, Model, type Sequelize } from "sequelize";
import type { Place } from "./place.js";
import type { RecordModel } from "./record.js";

/** Derived relationship between an imported record and a nearby verified place. */
export class RecordPlaceLink extends Model {
  declare recordId: string;
  declare placeId: string;
  declare relation: "nearby";
  declare distanceMeters: number;
  /** Present when the association is included in the query. */
  declare place?: Place;
  declare record?: RecordModel;
}

export function initRecordPlaceLinkModel(sequelize: Sequelize): void {
  RecordPlaceLink.init(
    {
      recordId: { type: DataTypes.STRING(120), primaryKey: true, field: "record_id" },
      placeId: { type: DataTypes.STRING(120), primaryKey: true, field: "place_id" },
      relation: { type: DataTypes.STRING(40), primaryKey: true },
      distanceMeters: { type: DataTypes.INTEGER, allowNull: false, field: "distance_meters" },
    },
    { sequelize, tableName: "record_place_links", underscored: true, timestamps: true },
  );
}
