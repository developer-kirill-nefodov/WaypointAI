import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { ROUTER_TOOLS } from "../assistant/router.js";
import type { BatchStatus, StoredTeacherExample, TeacherBatch } from "../data/teacher.repository.js";
import type { CheckedExample } from "../services/teacher/checks.js";
import { TeacherError, type TeacherExample } from "../services/teacher/openai-teacher.js";
import { BatchStateError, TeacherBusyError, TeacherLimitError, type TeacherService } from "../services/teacher/teacher-service.js";
import { TEACHER_LANGUAGES, TEACHER_TOPICS, TOPIC_IDS } from "../services/teacher/topics.js";
import { createRateLimit } from "./rate-limit.js";

/** Training examples from the teacher, in batches per topic: `/api/v1/training/teacher`. */
export interface TeacherRouterDependencies {
  enabled: boolean;
  available: boolean;
  model: string;
  service: Pick<TeacherService, "start" | "regenerate" | "cancel" | "progress" | "usage">;
  store: {
    listBatches(): Promise<TeacherBatch[]>;
    getBatch(id: string): Promise<TeacherBatch | null>;
    listExamples(batchId: string): Promise<StoredTeacherExample[]>;
    updateBatch(id: string, patch: { status: BatchStatus }): Promise<void>;
    deleteBatch(id: string): Promise<boolean>;
    getExample(id: string): Promise<StoredTeacherExample | null>;
    updateExample(id: string, example: Omit<CheckedExample, "status"> & { status: StoredTeacherExample["status"] }): Promise<StoredTeacherExample | null>;
    deleteExample(id: string): Promise<boolean>;
  };
  /** Runs the checks again on an edited example; its own former question does not count as a duplicate. */
  recheck(example: TeacherExample, topic: string, formerQuestion: string): Promise<CheckedExample>;
}

const uuid = z.string().uuid();
const batchSchema = z.object({
  topic: z.enum(TOPIC_IDS),
  languages: z.array(z.enum(["ru", "en", "de"])).min(1).max(3).refine((list) => new Set(list).size === list.length),
  count: z.number().int().min(5).max(200),
  crossCheck: z.boolean().default(false),
}).strict();
const exampleSchema = z.object({
  question: z.string().trim().min(3).max(400).optional(),
  language: z.enum(["ru", "en", "de"]).optional(),
  tool: z.enum(ROUTER_TOOLS).optional(),
  args: z.record(z.unknown()).optional(),
  // Keeps a disputed example as it is: a person decided the teacher's first answer was right.
  approve: z.boolean().optional(),
}).strict();

export function createTeacherRouter(deps: TeacherRouterDependencies): Router {
  const router = Router();
  router.use(createRateLimit({ windowMs: 60_000, max: 120 }));
  const editable: RequestHandler = (_request, response, next) => {
    if (!deps.enabled) return response.status(403).json({ error: "training_disabled" });
    next();
  };
  const failure = (error: unknown, response: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => {
    if (error instanceof TeacherLimitError) return response.status(429).json({ error: error.code, remaining: error.remaining });
    if (error instanceof TeacherBusyError) return response.status(409).json({ error: error.code });
    if (error instanceof BatchStateError) return response.status(error.code === "not_found" ? 404 : 409).json({ error: error.code });
    if (error instanceof TeacherError) return response.status(409).json({ error: error.code });
    next(error);
  };

  router.get("/", async (_request, response, next) => {
    try {
      response.json({
        available: deps.available,
        model: deps.model,
        topics: TEACHER_TOPICS.map(({ id, title, description, tools }) => ({ id, title, description, tools })),
        languages: TEACHER_LANGUAGES,
        usage: await deps.service.usage(),
        progress: deps.service.progress,
        batches: await deps.store.listBatches(),
      });
    } catch (error) { next(error); }
  });

  router.post("/batches", editable, async (request, response, next) => {
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_batch" });
    try { response.status(202).json({ batch: await deps.service.start(parsed.data) }); } catch (error) { failure(error, response, next); }
  });

  router.get("/batches/:id", async (request, response, next) => {
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      const batch = await deps.store.getBatch(id.data);
      if (!batch) return response.status(404).json({ error: "not_found" });
      response.json({ batch, examples: await deps.store.listExamples(id.data) });
    } catch (error) { next(error); }
  });

  router.post("/batches/:id/cancel", editable, (request, response) => {
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    if (!deps.service.cancel(id.data)) return response.status(404).json({ error: "not_running" });
    response.status(202).json({ cancelling: true });
  });

  router.post("/batches/:id/regenerate", editable, async (request, response, next) => {
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try { response.status(202).json({ batch: await deps.service.regenerate(id.data) }); } catch (error) { failure(error, response, next); }
  });

  // Accepted batches go into the dataset on its next build.
  router.post("/batches/:id/accept", editable, async (request, response, next) => {
    const id = uuid.safeParse(request.params.id);
    const body = z.object({ accepted: z.boolean() }).strict().safeParse(request.body);
    if (!id.success || !body.success) return response.status(400).json({ error: "invalid_request" });
    try {
      const batch = await deps.store.getBatch(id.data);
      if (!batch) return response.status(404).json({ error: "not_found" });
      if (batch.status !== "review" && batch.status !== "accepted") return response.status(409).json({ error: "batch_busy" });
      await deps.store.updateBatch(id.data, { status: body.data.accepted ? "accepted" : "review" });
      response.json({ batch: await deps.store.getBatch(id.data) });
    } catch (error) { next(error); }
  });

  router.delete("/batches/:id", editable, async (request, response, next) => {
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      if (!(await deps.store.deleteBatch(id.data))) return response.status(409).json({ error: "batch_busy" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  router.patch("/examples/:id", editable, async (request, response, next) => {
    const id = uuid.safeParse(request.params.id);
    const body = exampleSchema.safeParse(request.body);
    if (!id.success || !body.success) return response.status(400).json({ error: "invalid_example" });
    try {
      const example = await deps.store.getExample(id.data);
      if (!example) return response.status(404).json({ error: "not_found" });
      const batch = await deps.store.getBatch(example.batchId);
      if (!batch || batch.status === "generating") return response.status(409).json({ error: "batch_busy" });
      if (body.data.approve) {
        if (example.status !== "disputed") return response.status(409).json({ error: "not_disputed" });
        const approved = await deps.store.updateExample(example.id, { question: example.question, language: example.language as TeacherExample["language"], call: { tool: example.tool as TeacherExample["tool"], args: example.args }, reasons: example.reasons, status: "edited" });
        return response.json({ example: approved });
      }
      const checked = await deps.recheck({
        question: body.data.question ?? example.question,
        language: body.data.language ?? (example.language as TeacherExample["language"]),
        tool: body.data.tool ?? (example.tool as TeacherExample["tool"]),
        args: body.data.args ?? example.args,
      }, batch.topic, example.question);
      // A person's edit that passes the checks counts as approved.
      const stored = await deps.store.updateExample(example.id, { ...checked, status: checked.status === "rejected" ? "rejected" : "edited" });
      response.json({ example: stored });
    } catch (error) { next(error); }
  });

  router.delete("/examples/:id", editable, async (request, response, next) => {
    const id = uuid.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      if (!(await deps.store.deleteExample(id.data))) return response.status(404).json({ error: "not_found" });
      response.status(204).end();
    } catch (error) { next(error); }
  });

  return router;
}
