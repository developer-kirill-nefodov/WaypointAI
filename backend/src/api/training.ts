import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { buildLessonBlock, validateLesson, type Lesson, type LessonInput } from "../assistant/lessons.js";
import type { EvalResult, EvalRun } from "../data/training.repository.js";
import { caseExpectationSchema, type ExamCase } from "../services/eval-checks.js";
import { EvalBusyError, NoExamCasesError, type EvalRunner } from "../services/eval-runner.js";
import { createRateLimit, type RateLimitOptions } from "./rate-limit.js";
import type { ModelCard } from "../llm/model-card.js";

/** Model metadata changes only when the model is replaced, so it is read from the runtime at most this often. */
const MODEL_CARD_CACHE_MS = 10 * 60_000;

export interface TrainingDependencies {
  /** Editing lessons and running the exam; reading works either way. */
  enabled: boolean;
  model: string;
  /** ROUTER_MODEL, when set. */
  routerModel?: string | null;
  lessons: {
    list(): Promise<Lesson[]>;
    create(input: LessonInput): Promise<Lesson>;
    update(id: string, input: LessonInput | { enabled: boolean }): Promise<Lesson | null>;
    remove(id: string): Promise<boolean>;
  };
  cases: {
    list(): Promise<ExamCase[]>;
    save(examCase: ExamCase): Promise<ExamCase>;
    remove(id: string): Promise<boolean>;
    addMissing(cases: ExamCase[]): Promise<number>;
    starter: ExamCase[];
    /** Generates the benchmark from the database (replacing earlier generated cases) and adds the hard cases. */
    generate(input: { perSkill: number; seed: number }): Promise<{ generated: number; hard: number }>;
  };
  runs: {
    list(): Promise<EvalRun[]>;
    get(id: string): Promise<{ run: EvalRun; results: EvalResult[] } | null>;
  };
  runner: Pick<EvalRunner, "start" | "cancel" | "activeRunId">;
  /** Models installed in the local runtime, the only ones a run may name. */
  installedModels: () => Promise<string[]>;
  /** The configured model's metadata from the local runtime; null when it is unavailable. */
  describeModel: () => Promise<ModelCard | null>;
  rateLimit?: RateLimitOptions;
  now?: () => number;
}

const lessonId = z.string().uuid();
const caseId = z.string().regex(/^[a-z0-9-]{1,80}$/);
const caseInputSchema = z.object({
  question: z.string().trim().min(1).max(300),
  language: z.enum(["ru", "en", "de"]),
  expect: caseExpectationSchema,
  enabled: z.boolean().optional(),
}).strict();
const toggleSchema = z.object({ enabled: z.boolean() }).strict();
const previewSchema = z.object({ message: z.string().trim().min(1).max(500) }).strict();
const runSchema = z.object({
  withLessons: z.boolean(),
  label: z.string().trim().max(120).optional(),
  mode: z.enum(["full", "first_step", "router"]).optional(),
  /** Another installed model to measure; validated against the runtime's model list. */
  model: z.string().trim().regex(/^[\w.:/-]{1,120}$/).optional(),
  origins: z.array(z.enum(["starter", "manual", "generated", "hard", "journal"])).max(5).optional(),
}).strict();
const generateSchema = z.object({ perSkill: z.number().int().min(5).max(60).default(20), seed: z.number().int().min(0).max(1_000_000).default(1) }).strict();
const SKILL_OF_TOOL: Record<string, string> = { search_places: "places", search_events: "events", plan_trip: "trips", edit_trip_plan: "trips", route_places: "trips", list_sources: "sources", reply: "reply" };

/** Lessons, the exam, and its runs: `/api/v1/training`. */
export function createTrainingRouter(deps: TrainingDependencies): Router {
  const router = Router();
  router.use(createRateLimit(deps.rateLimit ?? { windowMs: 60_000, max: 120 }));
  const editable: RequestHandler = (_request, response, next) => {
    if (!deps.enabled) return response.status(403).json({ error: "training_disabled" });
    next();
  };

  let modelCard: { at: number; card: ModelCard } | null = null;
  router.get("/model", async (_request, response, next) => {
    const now = deps.now?.() ?? Date.now();
    try {
      if (!modelCard || now - modelCard.at > MODEL_CARD_CACHE_MS) {
        const card = await deps.describeModel();
        // A failed read is not cached, so the card appears as soon as the runtime is back.
        if (!card) return response.status(503).json({ error: "model_unavailable" });
        modelCard = { at: now, card };
      }
      response.json({ model: modelCard.card });
    } catch (error) { next(error); }
  });

  router.get("/status", async (_request, response) => {
    response.json({ editEnabled: deps.enabled, model: deps.model, routerModel: deps.routerModel ?? null, installedModels: await deps.installedModels().catch(() => []), activeRunId: deps.runner.activeRunId });
  });

  router.get("/lessons", async (_request, response, next) => {
    try { response.json({ lessons: await deps.lessons.list() }); } catch (error) { next(error); }
  });

  router.post("/lessons", editable, async (request, response, next) => {
    const checked = validateLesson(request.body);
    if (!checked.ok) return response.status(400).json({ error: checked.error, ...(checked.field ? { field: checked.field } : {}) });
    try { response.status(201).json({ lesson: await deps.lessons.create(checked.value) }); } catch (error) { next(error); }
  });

  router.patch("/lessons/:id", editable, async (request, response, next) => {
    const id = lessonId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    const toggle = toggleSchema.safeParse(request.body);
    let input: LessonInput | { enabled: boolean };
    if (toggle.success) input = toggle.data;
    else {
      const checked = validateLesson(request.body);
      if (!checked.ok) return response.status(400).json({ error: checked.error, ...(checked.field ? { field: checked.field } : {}) });
      input = checked.value;
    }
    try {
      const lesson = await deps.lessons.update(id.data, input);
      if (!lesson) return response.status(404).json({ error: "not_found" });
      response.json({ lesson });
    } catch (error) { next(error); }
  });

  router.delete("/lessons/:id", editable, async (request, response, next) => {
    const id = lessonId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      if (!await deps.lessons.remove(id.data)) return response.status(404).json({ error: "not_found" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  // Which lessons a message would get, and the exact text the model would see; nothing is sent to the model.
  router.post("/lessons/preview", async (request, response, next) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_message" });
    try {
      const block = buildLessonBlock(await deps.lessons.list(), parsed.data.message);
      response.json({ applied: block?.applied ?? [], prompt: block?.content ?? null });
    } catch (error) { next(error); }
  });

  router.get("/cases", async (_request, response, next) => {
    try { response.json({ cases: await deps.cases.list() }); } catch (error) { next(error); }
  });

  router.post("/cases", editable, async (request, response, next) => {
    const parsed = caseInputSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_case" });
    try {
      response.status(201).json({ case: await deps.cases.save({ id: `case-${randomUUID().slice(0, 8)}`, ...parsed.data, enabled: parsed.data.enabled ?? true, skill: SKILL_OF_TOOL[parsed.data.expect.tool ?? ""] ?? "other", origin: "manual" }) });
    } catch (error) { next(error); }
  });

  router.post("/cases/generate", editable, async (request, response, next) => {
    const parsed = generateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return response.status(400).json({ error: "invalid_request" });
    if (deps.runner.activeRunId) return response.status(409).json({ error: "exam_running" });
    try { response.json(await deps.cases.generate(parsed.data)); } catch (error) { next(error); }
  });

  router.post("/cases/starter", editable, async (_request, response, next) => {
    try { response.json({ added: await deps.cases.addMissing(deps.cases.starter) }); } catch (error) { next(error); }
  });

  router.patch("/cases/:id", editable, async (request, response, next) => {
    const id = caseId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      const existing = (await deps.cases.list()).find((item) => item.id === id.data);
      if (!existing) return response.status(404).json({ error: "not_found" });
      const toggle = toggleSchema.safeParse(request.body);
      const full = caseInputSchema.safeParse(request.body);
      if (!toggle.success && !full.success) return response.status(400).json({ error: "invalid_case" });
      const updated = toggle.success ? { ...existing, enabled: toggle.data.enabled } : { ...existing, ...full.data!, enabled: full.data!.enabled ?? existing.enabled, skill: SKILL_OF_TOOL[full.data!.expect.tool ?? ""] ?? existing.skill };
      response.json({ case: await deps.cases.save(updated) });
    } catch (error) { next(error); }
  });

  router.delete("/cases/:id", editable, async (request, response, next) => {
    const id = caseId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      if (!await deps.cases.remove(id.data)) return response.status(404).json({ error: "not_found" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.get("/runs", async (_request, response, next) => {
    try { response.json({ runs: await deps.runs.list(), activeRunId: deps.runner.activeRunId }); } catch (error) { next(error); }
  });

  router.get("/runs/:id", async (request, response, next) => {
    const id = lessonId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      const run = await deps.runs.get(id.data);
      if (!run) return response.status(404).json({ error: "not_found" });
      response.json(run);
    } catch (error) { next(error); }
  });

  router.post("/runs", editable, async (request, response, next) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_run" });
    try {
      if (parsed.data.model && !(await deps.installedModels()).includes(parsed.data.model)) return response.status(400).json({ error: "unknown_model" });
      const run = await deps.runner.start(await deps.cases.list(), {
        withLessons: parsed.data.withLessons,
        label: parsed.data.label || null,
        mode: parsed.data.mode ?? "full",
        origins: parsed.data.origins ?? [],
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
      });
      response.status(202).json({ run });
    } catch (error) {
      if (error instanceof EvalBusyError) return response.status(409).json({ error: error.code });
      if (error instanceof NoExamCasesError) return response.status(409).json({ error: error.code });
      next(error);
    }
  });

  router.post("/runs/:id/cancel", editable, (request, response) => {
    const id = lessonId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    if (!deps.runner.cancel(id.data)) return response.status(404).json({ error: "not_running" });
    response.status(202).json({ cancelling: true });
  });

  return router;
}
