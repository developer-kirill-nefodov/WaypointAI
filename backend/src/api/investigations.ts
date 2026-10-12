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
import { ImportAlreadyRunningError, ImportCooldownError } from "../services/event-import.js";
import { isEventSourceId, type EventSourceId } from "../sources/registry.js";
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
