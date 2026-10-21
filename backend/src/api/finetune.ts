import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { ExportUnavailableError, LORA_BASE_MODELS, PublishBusyError, RunNotFinishedError, TrainerBusyError, TrainerUnavailableError, type LoraRun, type LoraTrainer } from "../services/lora-trainer.js";
import { PackageError } from "../services/model-package.js";
import { createRateLimit } from "./rate-limit.js";

export interface DatasetSummary {
  total: number;
  bySkill: Record<string, number>;
  byLanguage: Record<string, number>;
  bySource: Record<string, number>;
  /** Teacher examples per topic. */
  byTopic?: Record<string, number>;
  excludedAsBenchmark: number;
  createdAt: string;
  /** Repository-relative path of the JSON Lines file. */
  path: string;
}

export interface FinetuneDependencies {
  enabled: boolean;
  trainer: Pick<LoraTrainer, "availability" | "list" | "start" | "cancel" | "publish" | "active" | "exportRun" | "importPackage">;
  /** Where an uploaded package is kept while it is checked. */
  uploads: string;
  dataset: { last(): Promise<DatasetSummary | null>; build(input: { perSkill: number; seed: number }): Promise<DatasetSummary> };
}

const datasetSchema = z.object({ perSkill: z.number().int().min(20).max(500).default(150), seed: z.number().int().min(0).max(1_000_000).default(1000) }).strict();
const runSchema = z.object({
  baseModel: z.enum(LORA_BASE_MODELS),
  epochs: z.number().min(0.5).max(5).default(2),
  learningRate: z.number().min(1e-5).max(1e-3).default(2e-4),
  rank: z.union([z.literal(8), z.literal(16), z.literal(32)]).default(16),
  autoBenchmark: z.boolean().default(false),
}).strict();
const runId = z.string().regex(/^\d{8}-[0-9a-f]{6}$/);
const exportKind = z.enum(["adapter", "gguf"]);
/** The largest package: a GGUF of the larger base model with its adapter. */
const MAX_UPLOAD_BYTES = 7 * 1024 ** 3;

/**
 * Router fine-tuning: the dataset, LoRA runs, publishing a run to Ollama, and moving a trained run between machines
 * as a package: `/api/v1/training/finetune`.
 */
export function createFinetuneRouter(deps: FinetuneDependencies): Router {
  const router = Router();
  let importing = false;
  router.use(createRateLimit({ windowMs: 60_000, max: 120 }));
  const editable: RequestHandler = (_request, response, next) => {
    if (!deps.enabled) return response.status(403).json({ error: "training_disabled" });
    next();
  };

  router.get("/", async (_request, response, next) => {
    try {
      response.json({ availability: deps.trainer.availability(), baseModels: LORA_BASE_MODELS, dataset: await deps.dataset.last(), runs: await deps.trainer.list(), activeRunId: deps.trainer.active?.id ?? null });
    } catch (error) { next(error); }
  });

  router.post("/dataset", editable, async (request, response, next) => {
    const parsed = datasetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return response.status(400).json({ error: "invalid_request" });
    if (deps.trainer.active) return response.status(409).json({ error: "training_running" });
    try { response.json({ dataset: await deps.dataset.build(parsed.data) }); } catch (error) { next(error); }
  });

  router.post("/runs", editable, async (request, response, next) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "invalid_run" });
    try {
      const run: LoraRun = await deps.trainer.start(parsed.data);
      response.status(202).json({ run });
    } catch (error) {
      if (error instanceof TrainerBusyError || error instanceof TrainerUnavailableError) return response.status(409).json({ error: error.code });
      next(error);
    }
  });

  router.post("/runs/:id/cancel", editable, (request, response) => {
    const id = runId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    if (!deps.trainer.cancel(id.data)) return response.status(404).json({ error: "not_running" });
    response.status(202).json({ cancelling: true });
  });

  // Publishing runs in the background; the run shows its stage and, when it ends, its model or error.
  router.post("/runs/:id/publish", editable, async (request, response, next) => {
    const id = runId.safeParse(request.params.id);
    if (!id.success) return response.status(400).json({ error: "invalid_id" });
    try {
      response.status(202).json({ run: await deps.trainer.publish(id.data) });
    } catch (error) {
      if (error instanceof RunNotFinishedError || error instanceof PublishBusyError || error instanceof TrainerUnavailableError) return response.status(409).json({ error: error.code });
      next(error);
    }
  });

  router.get("/runs/:id/export", editable, async (request, response, next) => {
    const id = runId.safeParse(request.params.id);
    const kind = exportKind.safeParse(request.query.kind);
    if (!id.success || !kind.success) return response.status(400).json({ error: "invalid_request" });
    try {
      const run = (await deps.trainer.list()).find((item) => item.id === id.data);
      if (!run || run.status !== "succeeded") return response.status(409).json({ error: "run_not_finished" });
      if (!run.exports[kind.data]) return response.status(409).json({ error: "export_unavailable" });
      response.setHeader("content-type", "application/x-tar");
      response.setHeader("content-disposition", `attachment; filename="waypoint-router-${id.data}-${kind.data}.tar"`);
      await deps.trainer.exportRun(id.data, kind.data, response);
      response.end();
    } catch (error) {
      if (response.headersSent) return response.destroy(error instanceof Error ? error : undefined);
      if (error instanceof RunNotFinishedError || error instanceof ExportUnavailableError) return response.status(409).json({ error: error.code });
      next(error);
    }
  });

  // The body is the package itself (application/x-tar), streamed to disk and checked before anything is kept.
  router.post("/import", editable, async (request, response, next) => {
    if (!/^application\/(x-tar|octet-stream)\b/.test(request.headers["content-type"] ?? "")) return response.status(415).json({ error: "unsupported_media_type" });
    if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) return response.status(413).json({ error: "too_large" });
    if (importing) return response.status(409).json({ error: "import_running" });
    importing = true;
    const file = join(deps.uploads, `${randomUUID()}.tar`);
    try {
      await mkdir(deps.uploads, { recursive: true });
      let received = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          callback(received > MAX_UPLOAD_BYTES ? new PackageError("too_large") : null, chunk);
        },
      });
      await pipeline(request, limit, createWriteStream(file, { flags: "wx" }));
      response.status(201).json({ run: await deps.trainer.importPackage(file) });
    } catch (error) {
      if (error instanceof PackageError) return response.status(error.code === "too_large" ? 413 : 422).json({ error: error.code });
      if (request.destroyed || request.aborted) return;
      next(error);
    } finally {
      importing = false;
      await rm(file, { force: true });
    }
  });

  return router;
}
