import { Router } from "express";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFinetuneRouter, type DatasetSummary } from "../api/finetune.js";
import { createJournalRouter } from "../api/journal.js";
import { createTeacherRouter } from "../api/teacher.js";
import { createTrainingRouter } from "../api/training.js";
import { env } from "../config/env.js";
import * as journal from "../data/journal.repository.js";
import { resolveSettlementExactly } from "../data/settlement.repository.js";
import * as teacherStore from "../data/teacher.repository.js";
import * as training from "../data/training.repository.js";
import { describeConfiguredModel } from "../llm/model-card.js";
import { listInstalledModels } from "../llm/ollama.provider.js";
import { generateBenchmark } from "../services/benchmark-generator.js";
import { HARD_CASES } from "../services/benchmark-hard-cases.js";
import { EvalRunner } from "../services/eval-runner.js";
import { runExamCase } from "../services/exam-turn.js";
import { LoraTrainer } from "../services/lora-trainer.js";
import { STARTER_EXAM } from "../services/starter-exam.js";
import { checkExample, normalizeQuestion } from "../services/teacher/checks.js";
import { OpenAiTeacher } from "../services/teacher/openai-teacher.js";
import { TeacherService } from "../services/teacher/teacher-service.js";
import { findTopic } from "../services/teacher/topics.js";
import { buildDataset, datasetSummary, toJsonl } from "../services/training-dataset.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TRAINING_DIRECTORY = resolve(REPOSITORY_ROOT, "data/local/training");
const DATASET_FILE = resolve(TRAINING_DIRECTORY, "router-dataset.jsonl");
const DATASET_SUMMARY_FILE = resolve(TRAINING_DIRECTORY, "router-dataset.summary.json");

/** Editing lessons and starting runs need TRAINING_ENABLED; unset, it is on only in development (there is no login). */
const editEnabled = env.TRAINING_ENABLED ?? env.NODE_ENV === "development";

/** The settlement's local name, when the database knows it exactly. */
const resolveLocalName = async (name: string) => (await resolveSettlementExactly(name))?.name ?? null;

/** Writes the router dataset from generated questions, confirmed journal turns, and accepted teacher examples. */
async function buildRouterDataset({ perSkill, seed }: { perSkill: number; seed: number }): Promise<DatasetSummary> {
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
}

/**
 * Everything under /api/v1/training: lessons and the benchmark, the OpenAI teacher, LoRA fine-tuning with export and
 * import, and the turn journal.
 */
export function createTrainingRoutes(): Router {
  const evalRunner = new EvalRunner({
    store: training,
    runCase: runExamCase,
    enabledLessonIds: async () => (await training.enabledLessons()).map((lesson) => lesson.id),
    model: env.OLLAMA_MODEL,
  });
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
  const teacherService = new TeacherService({
    teacher: new OpenAiTeacher({ apiKey: env.OPENAI_API_KEY, model: env.TEACHER_MODEL }),
    store: teacherStore,
    settlements: () => training.benchmarkSettlements(),
    benchmarkQuestions: async () => (await training.listCases()).map((item) => item.question),
    resolveSettlement: resolveLocalName,
    dailyLimit: env.TEACHER_MAX_EXAMPLES_PER_DAY,
  });

  const routes = Router();
  routes.use(createTrainingRouter({
    enabled: editEnabled,
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
  routes.use("/teacher", createTeacherRouter({
    enabled: editEnabled,
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
  routes.use("/finetune", createFinetuneRouter({
    enabled: editEnabled,
    trainer: loraTrainer,
    uploads: resolve(TRAINING_DIRECTORY, "uploads"),
    dataset: {
      last: async () => {
        try { return JSON.parse(await readFile(DATASET_SUMMARY_FILE, "utf8")) as DatasetSummary; } catch { return null; }
      },
      build: buildRouterDataset,
    },
  }));
  routes.use(createJournalRouter({
    enabled: editEnabled,
    journal: { list: journal.listJournal, get: journal.getJournalEntry, review: journal.reviewJournalEntry, feedback: journal.setFeedback, stats: journal.journalStats, gaps: journal.dataGaps },
    aliases: {
      list: journal.listAliases,
      save: journal.saveAlias,
      remove: journal.deleteAlias,
      resolve: async (name) => { const place = await resolveSettlementExactly(name); return place ? { id: place.id, name: place.name } : null; },
    },
    addCase: training.saveCase,
  }));
  return routes;
}

/** The journal keeps chat requests only for JOURNAL_RETENTION_DAYS; checked at start and daily. */
export async function purgeJournal(): Promise<void> {
  const removed = await journal.purgeJournal(env.JOURNAL_RETENTION_DAYS).catch(() => 0);
  if (removed) console.info("Removed old journal entries", { removed, retentionDays: env.JOURNAL_RETENTION_DAYS });
}

/** Exam runs and teacher batches run in this process; any still marked running stopped with the previous process. */
export async function failInterruptedTraining(): Promise<void> {
  const runs = await training.failInterruptedRuns();
  if (runs) console.warn("Marked interrupted exam runs as failed", { count: runs });
  const batches = await teacherStore.failInterruptedBatches();
  if (batches) console.warn("Stopped interrupted teacher batches", { count: batches });
}
