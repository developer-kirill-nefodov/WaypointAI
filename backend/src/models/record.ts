import { DataTypes, Model, type Sequelize } from "sequelize";
import { initSourceModel, Source } from "./source.js";

export class RecordModel extends Model {
  declare id: string;
  declare sourceId: string;
  declare observedAt: Date;
  declare lat: number;
  declare lon: number;
  declare accuracyMeters: number | null;
  declare category: string;
  declare attributes: Record<string, unknown>;
  declare placeId: string | null;
}

export function initRecordModel(sequelize: Sequelize): void {
  RecordModel.init(
    {
      id: { type: DataTypes.STRING(120), primaryKey: true },
      sourceId: { type: DataTypes.STRING(120), allowNull: false, field: "source_id" },
      observedAt: { type: DataTypes.DATE, allowNull: false, field: "observed_at" },
      lat: { type: DataTypes.DOUBLE, allowNull: false },
      lon: { type: DataTypes.DOUBLE, allowNull: false },
      accuracyMeters: { type: DataTypes.DOUBLE, allowNull: true, field: "accuracy_meters" },
      category: { type: DataTypes.STRING(120), allowNull: false },
      attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      placeId: { type: DataTypes.STRING(120), allowNull: true, field: "place_id" },
    },
    { sequelize, tableName: "records", underscored: true, timestamps: true },
  );
}

export function initModels(sequelize: Sequelize): void {
  initSourceModel(sequelize);
  initRecordModel(sequelize);
}
