import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { database } from "./database/client.js";
import { apiRouter } from "./api/http.js";
import { attachWebSocket } from "./api/websocket.js";
import { errorHandler } from "./api/error-handler.js";
import { createInvestigationsRouter } from "./api/investigations.js";
import { getEntityDetails, getEventDetails, searchEvents } from "./data/investigation.repository.js";
import { resolveSettlement } from "./data/settlement.repository.js";
import { runInvestigationQuery } from "./assistant/investigation-query.js";
import { chat } from "./llm/ollama.provider.js";
import { releaseInference, tryAcquireInference } from "./llm/inference-gate.js";
import { getSources } from "./data/record.repository.js";
import { failInterruptedRuns, sqlEventImportStore } from "./data/event-import.repository.js";
import { importEvents, startBackgroundImport } from "./services/event-import.js";
import { createEventSourceAdapter } from "./sources/registry.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", env.TRUST_PROXY);
app.use(cors({ origin: env.FRONTEND_ORIGIN, methods: ["GET", "POST", "DELETE"] }));
app.use(express.json({ limit: "32kb" }));
app.use("/api/v1", apiRouter);
app.use("/api/v1/investigations", createInvestigationsRouter({
  searchEvents,
  getEventDetails,
  getEntityDetails,
  getSources,
  importEnabled: env.INVESTIGATION_IMPORT_ENABLED,
  startImport: (sourceId, days) => startBackgroundImport((onRunStarted) => importEvents({
    adapter: createEventSourceAdapter(sourceId),
    store: sqlEventImportStore,
    days,
    cooldownSeconds: env.EVENT_IMPORT_COOLDOWN_SECONDS,
    onRunStarted,
  })),
  runQuery: (input) => runInvestigationQuery(input, {
    chat,
    tryAcquireInference,
    releaseInference,
    resolveSettlement,
    searchEvents,
  }),
}));
app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.use(errorHandler);

const server = createServer(app);
attachWebSocket(server);
server.listen(env.API_PORT, env.API_HOST, () => {
  console.log(`Waypoint AI API listening on http://${env.API_HOST}:${env.API_PORT}`);
  void database.authenticate()
    .then(() => failInterruptedRuns())
    .then((count) => { if (count) console.warn("Marked interrupted event imports as failed", { count }); })
    .catch(() => console.warn("PostgreSQL is not available yet; start it and apply migrations."));
});

async function shutdown(): Promise<void> {
  server.close();
  await database.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
