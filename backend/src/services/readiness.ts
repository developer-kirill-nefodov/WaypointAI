import { database } from "../database/client.js";
import { env } from "../config/env.js";
import type { AssistantStatus } from "@waypoint-ai/shared";
import { isConfiguredModelAvailable } from "../llm/ollama.provider.js";

let databaseReady = false;

export async function checkDatabase(): Promise<boolean> {
  try {
    await database.authenticate();
    databaseReady = true;
  } catch {
    databaseReady = false;
  }
  return databaseReady;
}

export async function getCapabilities() {
  const [hasModel, hasDatabase] = await Promise.all([isConfiguredModelAvailable(), checkDatabase()]);
  const assistantStatus: AssistantStatus = !hasModel ? "model_unavailable" : !hasDatabase ? "data_unavailable" : "ready";
  return {
    assistantStatus,
    transport: "websocket" as const,
    websocketPath: "/api/v1/assistant/ws" as const,
    modelLabel: env.OLLAMA_MODEL,
    supportedFilters: ["dateRange", "sourceIds", "category"],
    demoMode: env.DEMO_MODE,
  };
}
