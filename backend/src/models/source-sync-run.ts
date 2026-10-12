import { DataTypes, Model, type Sequelize } from "sequelize";

export type SourceSyncStatus = "running" | "succeeded" | "failed";

export class SourceSyncRun extends Model {
  declare id: string;
  declare sourceId: string;
  declare status: SourceSyncStatus;
  declare startedAt: Date;
  declare finishedAt: Date | null;
  declare windowStart: Date;
  declare windowEnd: Date;
  declare fetchedCount: number;
  declare insertedCount: number;
  declare updatedCount: number;
  declare skippedCount: number;
  declare errorCode: string | null;
}

export function initSourceSyncRunModel(sequelize: Sequelize): void {
  SourceSyncRun.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      sourceId: { type: DataTypes.STRING(120), allowNull: false, field: "source_id" },
      status: { type: DataTypes.ENUM("running", "succeeded", "failed"), allowNull: false },
      startedAt: { type: DataTypes.DATE, allowNull: false, field: "started_at" },
      finishedAt: { type: DataTypes.DATE, allowNull: true, field: "finished_at" },
      windowStart: { type: DataTypes.DATE, allowNull: false, field: "window_start" },
      windowEnd: { type: DataTypes.DATE, allowNull: false, field: "window_end" },
      fetchedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "fetched_count" },
      insertedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "inserted_count" },
      updatedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "updated_count" },
      skippedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "skipped_count" },
      errorCode: { type: DataTypes.STRING(60), allowNull: true, field: "error_code" },
    },
    { sequelize, tableName: "source_sync_runs", underscored: true, timestamps: true },
  );
}
