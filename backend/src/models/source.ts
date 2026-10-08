import { DataTypes, Model, type Sequelize } from "sequelize";

export class Source extends Model {
  declare id: string;
  declare label: string;
  declare mode: "synthetic_local" | "public_snapshot" | "approved_live" | "client_api";
  declare status: "ready" | "unavailable";
  declare attribution: string | null;
  declare snapshotDate: string | null;
  declare sourceUrl: string | null;
  declare license: string | null;
}

export function initSourceModel(sequelize: Sequelize): void {
  Source.init(
    {
      id: { type: DataTypes.STRING(120), primaryKey: true },
      label: { type: DataTypes.STRING(200), allowNull: false },
      mode: { type: DataTypes.ENUM("synthetic_local", "public_snapshot", "approved_live", "client_api"), allowNull: false },
      status: { type: DataTypes.ENUM("ready", "unavailable"), allowNull: false },
      attribution: { type: DataTypes.TEXT, allowNull: true },
      snapshotDate: { type: DataTypes.DATEONLY, allowNull: true, field: "snapshot_date" },
      sourceUrl: { type: DataTypes.TEXT, allowNull: true, field: "source_url" },
      license: { type: DataTypes.STRING(120), allowNull: true },
    },
    { sequelize, tableName: "data_sources", underscored: true, timestamps: true },
  );
}
