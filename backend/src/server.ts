import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { WS_CLOSE_SERVICE_RESTART } from "@waypoint-ai/shared";
import { env } from "./config/env.js";
import { database } from "./database/client.js";
import { apiRouter } from "./api/http.js";
import { attachWebSocket } from "./api/websocket.js";
import { errorHandler } from "./api/error-handler.js";
import { createInvestigationsRouter } from "./api/investigations.js";
import { createDatasetsRouter } from "./api/datasets.js";
import { getEntityDetails, getEventDetails, searchEvents } from "./data/investigation.repository.js";
import { resolveSettlement } from "./data/settlement.repository.js";
import { getSources } from "./data/record.repository.js";
import { failInterruptedRuns, sqlEventImportStore } from "./data/event-import.repository.js";
import { listCatalogCategories, listCatalogPlaces, listCountries, listDatasetEvents, listDatasets, listSettlements } from "./data/dataset.repository.js";
import { sqlImportJobStore } from "./data/import-job.repository.js";
import { Source } from "./models/source.js";
import { runInvestigationQuery } from "./assistant/investigation-query.js";
import { chat } from "./llm/ollama.provider.js";
import { releaseInference, tryAcquireInference } from "./llm/inference-gate.js";
import { importEvents, STALE_RUN_MS, startBackgroundImport } from "./services/event-import.js";
import { createEventSourceAdapter, EVENT_SOURCE_IDS, EVENT_SOURCE_USER_AGENT } from "./sources/registry.js";
import { geocode, lookupPlaceCodes } from "./sources/osm/osm-area.js";
import { childRegions, geofabrikFileInfo, geofabrikRegions, regionsForPlace, searchRegions } from "./sources/osm/geofabrik.js";
import { findRegion, importJobRunner } from "./setup/import-jobs.js";
import { createTrainingRoutes, failInterruptedTraining, purgeJournal } from "./setup/training.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", env.TRUST_PROXY);
app.use(cors({ origin: env.FRONTEND_ORIGIN, methods: ["GET", "POST", "PATCH", "DELETE"] }));
app.use(express.json({ limit: "32kb" }));
app.use("/api/v1", apiRouter);
const datasetsRouter = createDatasetsRouter({
  listDatasets,
  listCountries,
  listSettlements,
  listCatalogPlaces,
  listCatalogCategories,
  listDatasetEvents,
  searchRegions: async (query) => searchRegions(await geofabrikRegions(EVENT_SOURCE_USER_AGENT), query),
  childRegions: async (parentId) => childRegions(await geofabrikRegions(EVENT_SOURCE_USER_AGENT), parentId),
  locateRegions: async (query, language) => {
    const place = await lookupPlaceCodes(query, language, { url: env.OSM_NOMINATIM_URL, timeoutMs: env.OSM_REQUEST_TIMEOUT_MS, userAgent: EVENT_SOURCE_USER_AGENT });
    return place ? { place: place.name, regions: regionsForPlace(await geofabrikRegions(EVENT_SOURCE_USER_AGENT), place) } : null;
  },
  regionInfo: async (regionId) => {
    const region = await findRegion(regionId);
    return region ? { region, file: await geofabrikFileInfo(region, EVENT_SOURCE_USER_AGENT) } : null;
  },
  geocode: (query, language) => geocode(query, language, { url: env.OSM_NOMINATIM_URL, timeoutMs: env.OSM_REQUEST_TIMEOUT_MS, userAgent: EVENT_SOURCE_USER_AGENT }),
});
app.use("/api/v1/data", datasetsRouter);
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
  osmAreaMaxSquareDegrees: env.OSM_AREA_MAX_SQUARE_DEGREES,
  imports: {
    runner: importJobRunner,
    store: sqlImportJobStore,
    findRegion,
    findDataset: async (datasetId) => {
      const source = await Source.findOne({ where: { id: datasetId, status: "ready" }, attributes: ["id", "label"], raw: true });
      return source ? { id: source.id, label: source.label } : null;
    },
    clearHistory: (workspaceId) => sqlImportJobStore.clearFinished(workspaceId),
    cooldowns: async () => Object.fromEntries(await Promise.all(EVENT_SOURCE_IDS.map(async (sourceId) => {
      const startedAt = await sqlEventImportStore.lastRunStartedAt(sourceId);
      const elapsedSeconds = startedAt ? (Date.now() - startedAt.getTime()) / 1000 : Number.POSITIVE_INFINITY;
      return [sourceId, Math.max(0, Math.ceil(env.EVENT_IMPORT_COOLDOWN_SECONDS - elapsedSeconds))];
    }))),
  },
  runQuery: (input) => runInvestigationQuery(input, {
    chat,
    tryAcquireInference,
    releaseInference,
    resolveSettlement,
    searchEvents,
  }),
}));
app.use("/api/v1/training", createTrainingRoutes());
app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.use(errorHandler);

setInterval(() => void purgeJournal(), 24 * 60 * 60 * 1000).unref();

const server = createServer(app);
const closeWebSockets = attachWebSocket(server);
server.listen(env.API_PORT, env.API_HOST, () => {
  console.log(`Waypoint AI API listening on http://${env.API_HOST}:${env.API_PORT}`);
  void database.authenticate()
    .then(() => failInterruptedRuns(STALE_RUN_MS))
    .then((count) => { if (count) console.warn("Marked interrupted event imports as failed", { count }); })
    // Jobs run in this process, so any job still marked running was stopped with the previous process.
    .then(() => sqlImportJobStore.failInterrupted())
    .then((count) => { if (count) console.warn("Marked interrupted import jobs as failed", { count }); })
    .then(() => failInterruptedTraining())
    .then(() => purgeJournal())
    .catch(() => console.warn("PostgreSQL is not available yet; start it and apply migrations."));
});

async function shutdown(): Promise<void> {
  // Close WebSockets with "service restart" first: clients reconnect promptly and proxies see a clean close.
  await closeWebSockets(WS_CLOSE_SERVICE_RESTART, "Server restarting");
  server.close();
  await database.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
