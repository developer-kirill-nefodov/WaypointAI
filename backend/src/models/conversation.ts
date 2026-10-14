import { DataTypes, Model, type Sequelize } from "sequelize";
import type { TripPlan } from "@waypoint-ai/shared";

export type ConversationMessage = { role: "user" | "assistant"; content: string };

export class Conversation extends Model {
  declare id: string;
  declare workspaceId: string;
  declare messages: ConversationMessage[];
  declare tripPlan: TripPlan | null;
  declare expiresAt: Date;
}

export function initConversationModel(sequelize: Sequelize): void {
  Conversation.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.STRING(120), allowNull: false, field: "workspace_id" },
      messages: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      tripPlan: { type: DataTypes.JSONB, allowNull: true, field: "trip_plan" },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
    },
    { sequelize, tableName: "assistant_conversations", underscored: true, timestamps: true },
  );
}
