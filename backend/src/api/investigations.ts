import { Router } from "express";
import { z } from "zod";
import type { QueryInput, QueryOutcome } from "../assistant/investigation-query.js";
import type {
  EntityDetails,
  EventDetails,
  EventSearchInput,
  EventSearchResult,
} from "../data/investigation.repository.js";
import type { getSources } from "../data/record.repository.js";
import { ImportAlreadyRunningError, ImportCooldownError, MAX_IMPORT_DAYS } from "../services/event-import.js";
import { DatasetBusyError, ImportKindBusyError, TooManyImportJobsError, type ImportJobRunner, type ImportJobStore } from "../services/import-jobs.js";
import { isDeletableDataset } from "../services/dataset-delete.js";
import { bboxArea, OSM_AREA_CATEGORIES, type OsmAreaCategory } from "../sources/osm/osm-area.js";
import type { GeofabrikRegion } from "../sources/osm/geofabrik.js";
import type { ImportJobParams } from "@waypoint-ai/shared";
import { EVENT_SOURCE_IDS, isEventSourceId, type EventSourceId } from "../sources/registry.js";
import { toPointFeatureCollection } from "./geojson.js";
import { createRateLimit, type RateLimitOptions } from "./rate-limit.js";
import {
  describeAppliedFilters,
  encodeEventCursor,
  entityLimitSchema,
  importBodySchema,
  parseEventSearchQuery,
  recordIdSchema,
} from "./investigation-params.js";

const DEFAULT_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, max: 120 };

export interface InvestigationDependencies {
  searchEvents: (input: EventSearchInput) => Promise<EventSearchResult>;
  getEventDetails: (id: string) => Promise<EventDetails | null>;
  getEntityDetails: (id: string, limit: number) => Promise<EntityDetails | null>;
  getSources: typeof getSources;
  importEnabled: boolean;
  /** Starts an import; resolves with the run ID once the run is recorded, rejects on cooldown or a running import. */
  startImport: (sourceId: EventSourceId, days: number) => Promise<string>;
  runQuery: (input: QueryInput) => Promise<QueryOutcome>;
  /** Import jobs started from the app; listing works without INVESTIGATION_IMPORT_ENABLED, starting does not. */
  imports?: {
    runner: Pick<ImportJobRunner, "start" | "cancel">;
    store: Pick<ImportJobStore, "get" | "list">;
    /** Seconds until each source may be imported again (0 when it may run now). */
    cooldowns: () => Promise<Record<string, number>>;
    /** A region of the Geofabrik catalogue, for region imports. */
    findRegion?: (regionId: string) => Promise<GeofabrikRegion | null>;
    /** The label of a ready dataset, or null when there is none; a deletion names only the dataset ID. */
    findDataset?: (datasetId: string) => Promise<{ id: string; label: string } | null>;
    /** Removes the workspace's finished jobs from the history; returns how many. */
    clearHistory?: (workspaceId: string) => Promise<number>;
  };
  /** Largest area an OSM area import may cover, in square degrees. */
  osmAreaMaxSquareDegrees?: number;
  now?: () => Date;
  rateLimit?: RateLimitOptions;
}

export function createInvestigationsRouter(deps: InvestigationDependencies): Router {
  const router = Router();
  router.use(createRateLimit(deps.rateLimit ?? DEFAULT_RATE_LIMIT));

  router.get("/events", async (request, response, next) => {
    const parsed = parseEventSearchQuery(request.query, deps.now?.() ?? new Date());
    if (!parsed.ok) return response.status(400).json({ error: parsed.error });
    try {
      const result = await deps.searchEvents(parsed.value);
      response.json(await eventSearchBody(result, parsed.value, deps.getSources));
    } catch (error) {
      next(error);
    }
  });

  router.post("/query", async (request, response, next) => {
    const body = queryBodySchema.safeParse(request.body);
    if (!body.success) return response.status(400).json({ error: "invalid_query_request" });
    try {
      const outcome = await deps.runQuery({ ...body.data, now: deps.now?.() });
      if (!outcome.ok) {
        return response.status(outcome.status).json({
          error: outcome.error,
          interpretation: outcome.interpretation,
          ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
        });
      }
      response.json({
        interpretation: outcome.interpretation,
        resolvedPlace: outcome.resolvedPlace,
        ...await eventSearchBody(outcome.result, outcome.search, deps.getSources),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/events/:id", async (request, response, next) => {
    const id = recordIdSchema.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      const details = await deps.getEventDetails(id.data);
      if (!details) return response.status(404).json({ error: "not_found" });
      response.json(details);
    } catch (error) {
      next(error);
    }
  });

  router.get("/entities/:id", async (request, response, next) => {
    const id = recordIdSchema.safeParse(request.params.id);
    const query = entityLimitSchema.safeParse(request.query);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    if (!query.success) return response.status(400).json({ error: "invalid_query" });
    try {
      const details = await deps.getEntityDetails(id.data, query.data.limit);
      if (!details) return response.status(404).json({ error: "not_found" });
      response.json(details);
    } catch (error) {
      next(error);
    }
  });

  router.post("/import/:sourceId", async (request, response, next) => {
    // No authentication exists in this demo, so the trigger is opt-in and off by default.
    if (!deps.importEnabled) return response.status(403).json({ error: "import_disabled" });
    if (!request.is("application/json")) return response.status(415).json({ error: "unsupported_media_type" });
    const sourceId = request.params.sourceId;
    if (!isEventSourceId(sourceId)) return response.status(404).json({ error: "unknown_source" });
    const body = importBodySchema.safeParse(request.body ?? {});
    if (!body.success) return response.status(400).json({ error: "invalid_import_request" });
    try {
      const runId = await deps.startImport(sourceId, body.data.days);
      response.status(202).json({ runId, sourceId, status: "running" });
    } catch (error) {
      if (error instanceof ImportCooldownError) {
        response.setHeader("Retry-After", String(error.retryAfterSeconds));
        return response.status(429).json({ error: error.code, retryAfterSeconds: error.retryAfterSeconds });
      }
      if (error instanceof ImportAlreadyRunningError) return response.status(409).json({ error: error.code });
      next(error);
    }
  });

  const workspaceSchema = z.string().trim().regex(/^[\w.-]{1,120}$/).default("demo");
  const jobIdSchema = z.string().uuid();
  const eventsJobSchema = z.object({
    kind: z.literal("events").default("events"),
    sourceIds: z.array(z.enum(EVENT_SOURCE_IDS)).min(1).max(EVENT_SOURCE_IDS.length).refine((ids) => new Set(ids).size === ids.length, "duplicate source"),
    days: z.number().int().min(1).max(MAX_IMPORT_DAYS).default(7),
    workspaceId: workspaceSchema,
  }).strict();
  const osmAreaJobSchema = z.object({
    kind: z.literal("osm_area"),
    label: z.string().trim().min(1).max(120),
    bbox: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .refine(([minLon, minLat, maxLon, maxLat]) => minLon < maxLon && minLat < maxLat, "empty bbox")
      .refine((bbox) => bboxArea(bbox) <= (deps.osmAreaMaxSquareDegrees ?? 1), "area_too_large"),
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
    categories: z.array(z.enum(Object.keys(OSM_AREA_CATEGORIES) as [OsmAreaCategory, ...OsmAreaCategory[]])).min(1).max(Object.keys(OSM_AREA_CATEGORIES).length)
      .transform((categories) => [...new Set(categories)]),
    workspaceId: workspaceSchema,
  }).strict();
  const osmRegionJobSchema = z.object({
    kind: z.literal("osm_region"),
    regionId: z.string().regex(/^[a-z0-9-]{1,80}$/),
    workspaceId: workspaceSchema,
  }).strict();

  const datasetDeleteJobSchema = z.object({
    kind: z.literal("dataset_delete"),
    datasetId: z.string().regex(/^[a-z0-9-]{1,120}$/),
    workspaceId: workspaceSchema,
  }).strict();

  router.get("/imports", async (request, response, next) => {
    if (!deps.imports) return response.json({ importEnabled: false, jobs: [], cooldowns: {} });
    const workspaceId = workspaceSchema.safeParse(request.query.workspaceId);
    const limit = z.coerce.number().int().min(1).max(50).default(10).safeParse(request.query.limit);
    if (!workspaceId.success) return response.status(400).json({ error: "invalid_workspace" });
    if (!limit.success) return response.status(400).json({ error: "invalid_query" });
    try {
      const [jobs, cooldowns] = await Promise.all([
        deps.imports.store.list(workspaceId.data, { active: request.query.active === "true", limit: limit.data }),
        deps.imports.cooldowns(),
      ]);
      response.json({ importEnabled: deps.importEnabled, jobs, cooldowns, osmAreaMaxSquareDegrees: deps.osmAreaMaxSquareDegrees ?? 1 });
    } catch (error) { next(error); }
  });

  router.get("/imports/:id", async (request, response, next) => {
    const id = jobIdSchema.safeParse(request.params.id);
    const workspaceId = workspaceSchema.safeParse(request.query.workspaceId);
    if (!id.success || !workspaceId.success || !deps.imports) return response.status(404).json({ error: "not_found" });
    try {
      const job = await deps.imports.store.get(id.data, workspaceId.data);
      if (!job) return response.status(404).json({ error: "not_found" });
      response.json({ job });
    } catch (error) { next(error); }
  });

  router.post("/imports", async (request, response, next) => {
    // No authentication exists in this demo, so starting imports is opt-in and off by default.
    if (!deps.importEnabled || !deps.imports) return response.status(403).json({ error: "import_disabled" });
    if (!request.is("application/json")) return response.status(415).json({ error: "unsupported_media_type" });
    const raw = (request.body ?? {}) as { kind?: unknown };
    const parsed = raw.kind === "osm_area" ? osmAreaJobSchema.safeParse(raw)
      : raw.kind === "osm_region" ? osmRegionJobSchema.safeParse(raw)
        : raw.kind === "dataset_delete" ? datasetDeleteJobSchema.safeParse(raw)
          : eventsJobSchema.safeParse(raw);
    if (!parsed.success) {
      const tooLarge = parsed.error.issues.some((issue) => issue.message === "area_too_large");
      return response.status(400).json({ error: tooLarge ? "area_too_large" : "invalid_import_request" });
    }
    const { workspaceId, ...rest } = parsed.data;
    try {
      let params: ImportJobParams;
      if (rest.kind === "osm_region") {
        // The region must be in the Geofabrik catalogue; its name and country come from there, never from the request.
        const region = await deps.imports.findRegion?.(rest.regionId);
        if (!region) return response.status(400).json({ error: "unknown_region" });
        params = { kind: "osm_region", regionId: region.id, label: region.name, countryCode: region.countryCode };
      } else if (rest.kind === "dataset_delete") {
        // Only datasets imported from the app; the built-in extracts and event sources are refused.
        if (!isDeletableDataset(rest.datasetId)) return response.status(403).json({ error: "dataset_not_deletable" });
        const dataset = await deps.imports.findDataset?.(rest.datasetId);
        if (!dataset) return response.status(404).json({ error: "not_found" });
        params = { kind: "dataset_delete", datasetId: dataset.id, label: dataset.label };
      } else {
        params = rest;
      }
      const job = await deps.imports.runner.start(workspaceId, params);
      response.status(202).json({ job });
    } catch (error) {
      if (error instanceof TooManyImportJobsError) return response.status(429).json({ error: error.code });
      if (error instanceof ImportKindBusyError || error instanceof DatasetBusyError) return response.status(409).json({ error: error.code });
      next(error);
    }
  });

  router.post("/imports/history/clear", async (request, response, next) => {
    if (!deps.importEnabled || !deps.imports?.clearHistory) return response.status(403).json({ error: "import_disabled" });
    if (!request.is("application/json")) return response.status(415).json({ error: "unsupported_media_type" });
    const workspaceId = workspaceSchema.safeParse(request.body?.workspaceId);
    if (!workspaceId.success) return response.status(400).json({ error: "invalid_workspace" });
    try {
      response.json({ removed: await deps.imports.clearHistory(workspaceId.data) });
    } catch (error) { next(error); }
  });

  router.post("/imports/:id/cancel", async (request, response) => {
    if (!deps.importEnabled || !deps.imports) return response.status(403).json({ error: "import_disabled" });
    const id = jobIdSchema.safeParse(request.params.id);
    const workspaceId = workspaceSchema.safeParse(request.body?.workspaceId);
    if (!id.success || !workspaceId.success) return response.status(404).json({ error: "not_found" });
    const job = await deps.imports.store.get(id.data, workspaceId.data).catch(() => null);
    if (!job) return response.status(404).json({ error: "not_found" });
    response.json({ cancelled: deps.imports.runner.cancel(job.id) });
  });

  return router;
}

const queryBodySchema = z.object({
  text: z.string().trim().min(1).max(300),
  language: z.enum(["en", "ru", "de"]).default("en"),
  selection: z.object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    label: z.string().max(200),
  }).strict().nullish(),
}).strict();

async function eventSearchBody(
  result: EventSearchResult,
  input: EventSearchInput,
  getSourcesFor: InvestigationDependencies["getSources"],
) {
  const sources = await getSourcesFor([...new Set(result.events.map((event) => event.sourceId))]);
  return {
    total: result.total,
    magnitudeRange: result.magnitudeRange ?? null,
    events: result.events,
    nextCursor: result.nextCursor ? encodeEventCursor(result.nextCursor) : null,
    appliedFilters: describeAppliedFilters(input),
    mapFeatures: toPointFeatureCollection(result.events, (event) => ({
      entityType: "record",
      id: event.id,
      sourceId: event.sourceId,
      label: event.label,
      observedAt: event.observedAt,
      category: event.attributes.category ?? null,
    })),
    sources,
  };
}
