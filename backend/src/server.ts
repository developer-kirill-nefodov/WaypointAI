import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { database } from "./database/client.js";
import { apiRouter } from "./api/http.js";
import { WS_CLOSE_SERVICE_RESTART } from "@waypoint-ai/shared";
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
import { importEvents, STALE_RUN_MS, startBackgroundImport } from "./services/event-import.js";
import { createEventSourceAdapter, EVENT_SOURCE_IDS, EVENT_SOURCE_USER_AGENT, type EventSourceId } from "./sources/registry.js";
import { fetchOverpassTile, geocode, lookupPlaceCodes } from "./sources/osm/osm-area.js";
import { importOsmArea, osmAreaSourceId } from "./services/osm-area-import.js";
import { sqlOsmAreaStore } from "./data/osm-area.repository.js";
import { childRegions, downloadGeofabrikFile, geofabrikFileInfo, geofabrikRegions, regionsForPlace, searchRegions } from "./sources/osm/geofabrik.js";
import { importOsmRegion, osmRegionSourceId, runOsmParser } from "./services/osm-region-import.js";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listCatalogCategories, listCatalogPlaces, listCountries, listDatasetEvents, listDatasets, listSettlements, sqlDatasetDeleteStore } from "./data/dataset.repository.js";
import { deleteDataset } from "./services/dataset-delete.js";
import { Source } from "./models/source.js";
import { invalidatePlaceCoverage } from "./data/coverage.js";
import { createDatasetsRouter } from "./api/datasets.js";
import { ImportJobRunner } from "./services/import-jobs.js";
import { importJobEvents } from "./services/import-job-events.js";
import { sqlImportJobStore } from "./data/import-job.repository.js";
import { createTrainingRouter } from "./api/training.js";
import * as training from "./data/training.repository.js";
import { EvalRunner } from "./services/eval-runner.js";
import { runExamCase } from "./services/exam-turn.js";
import { STARTER_EXAM } from "./services/starter-exam.js";
import { generateBenchmark } from "./services/benchmark-generator.js";
import { HARD_CASES } from "./services/benchmark-hard-cases.js";
import { describeConfiguredModel } from "./llm/model-card.js";
import { listInstalledModels } from "./llm/ollama.provider.js";
import { createJournalRouter } from "./api/journal.js";
import { createFinetuneRouter, type DatasetSummary } from "./api/finetune.js";
import { LoraTrainer } from "./services/lora-trainer.js";
import { buildDataset, datasetSummary, toJsonl } from "./services/training-dataset.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as journal from "./data/journal.repository.js";
import { resolveSettlementExactly } from "./data/settlement.repository.js";
import { createTeacherRouter } from "./api/teacher.js";
import * as teacherStore from "./data/teacher.repository.js";
import { OpenAiTeacher } from "./services/teacher/openai-teacher.js";
import { TeacherService } from "./services/teacher/teacher-service.js";
import { checkExample, normalizeQuestion } from "./services/teacher/checks.js";
import { findTopic } from "./services/teacher/topics.js";

const REGION_DIRECTORY = fileURLToPath(new URL("../../data/local/regions/", import.meta.url));
const findRegion = async (regionId: string) => (await geofabrikRegions(EVENT_SOURCE_USER_AGENT)).find((region) => region.id === regionId) ?? null;

const importJobRunner = new ImportJobRunner({
  store: sqlImportJobStore,
  publish: (job) => {
    importJobEvents.publish(job);
    // A new or deleted area is known to the assistant on its next turn.
    if (job.status !== "running" && job.params.kind !== "events") invalidatePlaceCoverage();
  },
  kinds: {
    events: {
      sources: ({ sourceIds }) => sourceIds.map((sourceId) => ({ sourceId, label: createEventSourceAdapter(sourceId as EventSourceId).descriptor.label })),
      run: async ({ days }, sourceId, { signal, onProgress }) => {
        const summary = await importEvents({
          adapter: createEventSourceAdapter(sourceId as EventSourceId),
          store: sqlEventImportStore,
          days,
          cooldownSeconds: env.EVENT_IMPORT_COOLDOWN_SECONDS,
          signal,
          onProgress: (progress) => onProgress({ phase: progress.phase, fraction: progress.fraction, fetched: progress.fetched, stepsDone: progress.windowsDone, stepsTotal: progress.windowsTotal, windowStart: progress.windowStart }),
        });
        return { runId: summary.runId, fetched: summary.counts.fetched, inserted: summary.counts.inserted, updated: summary.counts.updated, linkedPlaces: summary.linkedPlaces, warning: summary.truncated ? "window_truncated" : null };
      },
    },
    osm_area: {
      // The public Overpass instance asks for one heavy client at a time.
      exclusive: true,
      sources: ({ label }) => [{ sourceId: osmAreaSourceId(label), label }],
      run: (params, sourceId, { signal, onProgress }) => importOsmArea({
        ...params,
        sourceId,
        sourceUrl: env.OSM_OVERPASS_URL,
        store: sqlOsmAreaStore,
        signal,
        onProgress,
        fetchTile: (tile, tileSignal) => fetchOverpassTile(tile, params.categories, params.countryCode, { url: env.OSM_OVERPASS_URL, timeoutMs: env.OSM_REQUEST_TIMEOUT_MS, userAgent: EVENT_SOURCE_USER_AGENT, signal: tileSignal }),
      }),
    },
    osm_region: {
      // A region file is large and parsed in a child process; one at a time.
      exclusive: true,
      sources: ({ regionId, label }) => [{ sourceId: osmRegionSourceId(regionId), label }],
      run: async ({ regionId, label, countryCode }, sourceId, { signal, onProgress }) => {
        const region = await findRegion(regionId);
        if (!region) throw Object.assign(new Error("unknown_region"), { code: "unknown_region" });
        // Region files live only under data/local/regions, named by their catalogue ID.
        const file = resolve(REGION_DIRECTORY, `${region.id}-latest.osm.pbf`);
        return importOsmRegion({
          region,
          sourceId,
          file,
          store: sqlOsmAreaStore,
          signal,
          onProgress,
          download: async (onBytes, downloadSignal) => {
            // A file downloaded earlier is reused when it still matches the catalogue's size.
            const info = await geofabrikFileInfo(region, EVENT_SOURCE_USER_AGENT).catch(() => null);
            const existing = await stat(file).catch(() => null);
            if (existing && info?.bytes && existing.size === info.bytes) {
              onBytes(existing.size, existing.size);
              return { bytes: existing.size };
            }
            return downloadGeofabrikFile(region, file, { userAgent: EVENT_SOURCE_USER_AGENT, maxBytes: env.OSM_REGION_MAX_BYTES, signal: downloadSignal, onProgress: onBytes });
          },
          parse: (onParse, parseSignal) => runOsmParser({
            file,
            sourceId,
            sourceName: `OpenStreetMap: ${label} regional extract`,
            sourceUrl: region.pbfUrl,
            countryCode: countryCode ?? "XX",
          }, onParse, parseSignal),
        });
      },
    },
    dataset_delete: {
      sources: ({ datasetId, label }) => [{ sourceId: datasetId, label }],
      run: ({ datasetId }, _sourceId, { signal, onProgress }) => deleteDataset({ datasetId, store: sqlDatasetDeleteStore, signal, onProgress }),
    },
  },
});

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
const evalRunner = new EvalRunner({
  store: training,
  runCase: runExamCase,
  enabledLessonIds: async () => (await training.enabledLessons()).map((lesson) => lesson.id),
  model: env.OLLAMA_MODEL,
});
app.use("/api/v1/training", createTrainingRouter({
  enabled: env.TRAINING_ENABLED ?? env.NODE_ENV === "development",
  model: env.OLLAMA_MODEL,
  lessons: { list: training.listLessons, create: training.createLesson, update: training.updateLesson, remove: training.deleteLesson },
  cases: {
    list: training.listCases, save: training.saveCase, remove: training.deleteCase, addMissing: training.addMissingCases, starter: STARTER_EXAM,
    generate: async ({ perSkill, seed }) => {
      const generated = generateBenchmark({ ...await training.benchmarkSettlements(), perSkill, seed });
      await training.replaceGeneratedCases(generated);
      return { generated: generated.length, hard: await training.addMissingCases(HARD_CASES) };
    },
  },
  runs: { list: () => training.listRuns(), get: training.getRun },
  runner: evalRunner,
  describeModel: describeConfiguredModel,
  installedModels: listInstalledModels,
  routerModel: env.ROUTER_MODEL ?? null,
}));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TRAINING_DIRECTORY = resolve(REPOSITORY_ROOT, "data/local/training");
const DATASET_FILE = resolve(TRAINING_DIRECTORY, "router-dataset.jsonl");
const DATASET_SUMMARY_FILE = resolve(TRAINING_DIRECTORY, "router-dataset.summary.json");
const loraTrainer = new LoraTrainer({
  root: REPOSITORY_ROOT,
  python: resolve(REPOSITORY_ROOT, "model/training/.venv/bin/python"),
  script: resolve(REPOSITORY_ROOT, "model/training/train_router.py"),
  mergeScript: resolve(REPOSITORY_ROOT, "model/training/merge_adapter.py"),
  publishScript: resolve(REPOSITORY_ROOT, "model/training/publish_router.sh"),
  converter: resolve(REPOSITORY_ROOT, "model/training/llama.cpp/convert_hf_to_gguf.py"),
  dataset: DATASET_FILE,
  runs: resolve(TRAINING_DIRECTORY, "runs"),
}, {
  // After an automatic publish: the router benchmark of the new model, as "Compare on the benchmark" would start it.
  benchmark: async (model) => (await evalRunner.start(await training.listCases(), { withLessons: false, label: `auto · ${model}`, mode: "router", origins: [], model })).id,
});
const resolveLocalName = async (name: string) => (await resolveSettlementExactly(name))?.name ?? null;
const teacherService = new TeacherService({
  teacher: new OpenAiTeacher({ apiKey: env.OPENAI_API_KEY, model: env.TEACHER_MODEL }),
  store: teacherStore,
  settlements: () => training.benchmarkSettlements(),
  benchmarkQuestions: async () => (await training.listCases()).map((item) => item.question),
  resolveSettlement: resolveLocalName,
  dailyLimit: env.TEACHER_MAX_EXAMPLES_PER_DAY,
});
app.use("/api/v1/training/teacher", createTeacherRouter({
  enabled: env.TRAINING_ENABLED ?? env.NODE_ENV === "development",
  available: Boolean(env.OPENAI_API_KEY),
  model: env.TEACHER_MODEL,
  service: teacherService,
  store: teacherStore,
  recheck: async (example, topicId, formerQuestion) => {
    const [known, cases] = await Promise.all([teacherStore.knownQuestions(), training.listCases()]);
    const seen = new Set(known.map(normalizeQuestion));
    seen.delete(normalizeQuestion(formerQuestion));
    return checkExample(example, { topic: findTopic(topicId)!, resolveSettlement: resolveLocalName, benchmark: new Set(cases.map((item) => normalizeQuestion(item.question))), seen });
  },
}));
app.use("/api/v1/training/finetune", createFinetuneRouter({
  enabled: env.TRAINING_ENABLED ?? env.NODE_ENV === "development",
  trainer: loraTrainer,
  uploads: resolve(TRAINING_DIRECTORY, "uploads"),
  dataset: {
    last: async () => {
      try { return JSON.parse(await readFile(DATASET_SUMMARY_FILE, "utf8")) as DatasetSummary; } catch { return null; }
    },
    build: async ({ perSkill, seed }) => {
      const [settlements, cases, confirmed, teacher] = await Promise.all([training.benchmarkSettlements(), training.listCases(), journal.listJournal({ filter: "confirmed", limit: 1000, offset: 0 }), teacherStore.acceptedExamples()]);
      const { examples, excludedAsBenchmark } = buildDataset({
        ...settlements,
        benchmarkQuestions: cases.map((item) => item.question),
        confirmed: confirmed.entries.flatMap((entry) => (entry.corrected ? [{ message: entry.message, language: entry.language, corrected: entry.corrected }] : [])),
        teacher: teacher.map(({ question, language, tool, args, topic }) => ({ question, language, tool, args, topic })),
        perSkill,
        seed,
      });
      await mkdir(TRAINING_DIRECTORY, { recursive: true });
      await writeFile(DATASET_FILE, toJsonl(examples));
      const summary: DatasetSummary = { ...datasetSummary(examples), excludedAsBenchmark, createdAt: new Date().toISOString(), path: "data/local/training/router-dataset.jsonl" };
      await writeFile(DATASET_SUMMARY_FILE, JSON.stringify(summary, null, 1));
      return summary;
    },
  },
}));
app.use("/api/v1/training", createJournalRouter({
  enabled: env.TRAINING_ENABLED ?? env.NODE_ENV === "development",
  journal: { list: journal.listJournal, get: journal.getJournalEntry, review: journal.reviewJournalEntry, feedback: journal.setFeedback, stats: journal.journalStats, gaps: journal.dataGaps },
  aliases: {
    list: journal.listAliases,
    save: journal.saveAlias,
    remove: journal.deleteAlias,
    resolve: async (name) => { const place = await resolveSettlementExactly(name); return place ? { id: place.id, name: place.name } : null; },
  },
  addCase: training.saveCase,
}));
app.use((_request, response) => response.status(404).json({ error: "not_found" }));
app.use(errorHandler);

/** The journal keeps chat requests only for JOURNAL_RETENTION_DAYS; checked at start and daily. */
async function purgeJournal(): Promise<void> {
  const removed = await journal.purgeJournal(env.JOURNAL_RETENTION_DAYS).catch(() => 0);
  if (removed) console.info("Removed old journal entries", { removed, retentionDays: env.JOURNAL_RETENTION_DAYS });
}
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
    .then(() => training.failInterruptedRuns())
    .then((count) => { if (count) console.warn("Marked interrupted exam runs as failed", { count }); })
    .then(() => teacherStore.failInterruptedBatches())
    .then((count) => { if (count) console.warn("Stopped interrupted teacher batches", { count }); })
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
