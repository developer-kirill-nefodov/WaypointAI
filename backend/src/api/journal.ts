import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { JournalEntry, JournalStats, SettlementAlias } from "../data/journal.repository.js";
import type { ExamCase } from "../services/eval-checks.js";
import { EXAMPLE_TOOLS } from "../assistant/lessons.js";
import { searchEventsArgsSchema } from "../tools/search-events.js";
import { searchPlacesArgs } from "../tools/assistant-tools.js";
import { planTripArgsSchema } from "../tools/plan-trip.js";
import { createRateLimit } from "./rate-limit.js";

export interface JournalDependencies {
  /** Reviewing and aliases change what the assistant and the benchmark do; reading and feedback work either way. */
  enabled: boolean;
  journal: {
    list(input: { filter: "candidates" | "all" | "confirmed"; limit: number; offset: number }): Promise<{ total: number; entries: JournalEntry[] }>;
    get(id: string): Promise<JournalEntry | null>;
    review(id: string, review: { status: "confirmed"; corrected: { tool: string; args: Record<string, unknown> } } | { status: "dismissed" }): Promise<JournalEntry | null>;
    feedback(requestId: string, rating: 1 | -1 | null): Promise<boolean>;
    stats(): Promise<JournalStats>;
    gaps(): Promise<{ missingPlaces: Array<{ name: string; count: number; lastAt: string }>; emptySearches: Array<{ city: string; kind: string | null; count: number }> }>;
  };
  aliases: {
    list(): Promise<SettlementAlias[]>;
    save(alias: string, placeId: string, origin: "manual" | "journal"): Promise<void>;
    remove(alias: string): Promise<boolean>;
    /** The settlement a name resolves to now, exactly (no fuzzy match), or null. */
    resolve(name: string): Promise<{ id: string; name: string } | null>;
  };
  /** Adds a confirmed turn to the benchmark as a "journal" case. */
  addCase(examCase: ExamCase): Promise<unknown>;
}

const ARGS_SCHEMAS: Record<string, z.ZodTypeAny> = {
  search_places: searchPlacesArgs,
  search_events: searchEventsArgsSchema,
  plan_trip: planTripArgsSchema,
  list_sources: z.object({}).strict(),
  reply: z.object({}).strict(),
};
const SKILL_OF_TOOL: Record<string, string> = { search_places: "places", search_events: "events", plan_trip: "trips", list_sources: "sources", reply: "reply" };

const listSchema = z.object({
  filter: z.enum(["candidates", "all", "confirmed"]).default("candidates"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
const reviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), tool: z.enum(EXAMPLE_TOOLS), args: z.record(z.string(), z.unknown()).default({}), addToBenchmark: z.boolean().default(true) }).strict(),
  z.object({ status: z.literal("dismissed") }).strict(),
]);
const feedbackSchema = z.object({ requestId: z.string().min(1).max(120), rating: z.union([z.literal(1), z.literal(-1), z.null()]) }).strict();
const aliasSchema = z.object({ alias: z.string().trim().min(2).max(120), settlement: z.string().trim().min(1).max(120) }).strict();

/** The journal of chat turns, its review, chat feedback, data gaps, and settlement aliases: `/api/v1/training`. */
export function createJournalRouter(deps: JournalDependencies): Router {
  const router = Router();
  router.use(createRateLimit({ windowMs: 60_000, max: 120 }));
  const editable: RequestHandler = (_request, response, next) => {
    if (!deps.enabled) return response.status(403).json({ error: "training_disabled" });
    next();
  };

  router.get("/journal", async (request, response, next) => {
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return response.status(400).json({ error: "invalid_query" });
    try { response.json({ ...await deps.journal.list(parsed.data), stats: await deps.journal.stats() }); } catch (error) { next(error); }
  });

  router.post("/journal/:id/review", editable, async (request, response, next) => {
    const id = z.string().uuid().safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    const parsed = reviewSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_review" });
    try {
      const entry = await deps.journal.get(id.data);
      if (!entry) return response.status(404).json({ error: "not_found" });
      if (parsed.data.status === "dismissed") return response.json({ entry: await deps.journal.review(entry.id, { status: "dismissed" }) });
      // The confirmed call is validated like the tool validates the model's call, so the benchmark and the training
      // data never hold a call the tool would refuse.
      const args = ARGS_SCHEMAS[parsed.data.tool]!.safeParse(parsed.data.args);
      if (!args.success) return response.status(400).json({ error: "invalid_example_args" });
      const corrected = { tool: parsed.data.tool, args: args.data as Record<string, unknown> };
      const reviewed = await deps.journal.review(entry.id, { status: "confirmed", corrected });
      if (parsed.data.addToBenchmark && entry.language && ["ru", "en", "de"].includes(entry.language)) {
        const expectArgs = Object.fromEntries(Object.entries(corrected.args).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))) as Record<string, string | number | boolean>;
        await deps.addCase({
          id: `journal-${entry.id.slice(0, 8)}`,
          question: entry.message.slice(0, 300),
          language: entry.language as ExamCase["language"],
          enabled: true,
          skill: SKILL_OF_TOOL[corrected.tool] ?? "other",
          origin: "journal",
          expect: { tool: corrected.tool as ExamCase["expect"]["tool"], ...(Object.keys(expectArgs).length ? { args: expectArgs } : {}) },
        });
      }
      response.json({ entry: reviewed });
    } catch (error) { next(error); }
  });

  // Thumbs from the chat; they only mark the turn for review.
  router.post("/journal/feedback", async (request, response, next) => {
    const parsed = feedbackSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_feedback" });
    try {
      if (!await deps.journal.feedback(parsed.data.requestId, parsed.data.rating)) return response.status(404).json({ error: "not_found" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get("/gaps", async (_request, response, next) => {
    try { response.json(await deps.journal.gaps()); } catch (error) { next(error); }
  });

  router.get("/aliases", async (_request, response, next) => {
    try { response.json({ aliases: await deps.aliases.list() }); } catch (error) { next(error); }
  });

  router.post("/aliases", editable, async (request, response, next) => {
    const parsed = aliasSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_alias" });
    try {
      const settlement = await deps.aliases.resolve(parsed.data.settlement);
      if (!settlement) return response.status(404).json({ error: "settlement_not_found" });
      // An alias must not hide a real settlement of that name.
      const existing = await deps.aliases.resolve(parsed.data.alias);
      if (existing && existing.id !== settlement.id) return response.status(409).json({ error: "alias_is_a_settlement" });
      await deps.aliases.save(parsed.data.alias, settlement.id, "manual");
      response.status(201).json({ alias: parsed.data.alias.toLocaleLowerCase(), settlement });
    } catch (error) { next(error); }
  });

  router.delete("/aliases/:alias", editable, async (request, response, next) => {
    const alias = z.string().trim().min(2).max(120).safeParse(request.params.alias);
    if (!alias.success) return response.status(400).json({ error: "invalid_alias" });
    try {
      if (!await deps.aliases.remove(alias.data)) return response.status(404).json({ error: "not_found" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
