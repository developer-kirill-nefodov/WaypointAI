import type { BatchStatus, StoredTeacherExample, TeacherBatch } from "../../data/teacher.repository.js";
import { checkExample, crossCheck, normalizeQuestion, type CheckContext, type CheckedExample } from "./checks.js";
import { TeacherError, type OpenAiTeacher, type SettlementName, type TeacherUsage } from "./openai-teacher.js";
import { findTopic, type TeacherLanguage, type TeacherTopic } from "./topics.js";

/**
 * Generates a batch in the background: the teacher writes the examples in chunks (two requests at a time), each
 * chunk is checked (and cross-checked when asked) and stored at once, so the batch fills while it runs. One batch
 * runs at a time. A batch that stops early keeps what it has and can be reviewed or regenerated.
 */
export interface TeacherStore {
  createBatch(input: { topic: string; languages: string[]; requested: number; model: string; crossCheck: boolean }): Promise<TeacherBatch>;
  getBatch(id: string): Promise<TeacherBatch | null>;
  updateBatch(id: string, patch: { status?: BatchStatus; errorCode?: string | null; generated?: number; usage?: TeacherUsage; finished?: boolean }): Promise<void>;
  insertExamples(batchId: string, examples: CheckedExample[]): Promise<void>;
  listExamples(batchId: string): Promise<StoredTeacherExample[]>;
  deleteRejected(batchId: string): Promise<number>;
  knownQuestions(): Promise<string[]>;
  generatedToday(): Promise<number>;
}

export interface TeacherServiceOptions {
  teacher: Pick<OpenAiTeacher, "available" | "model" | "generate" | "answer">;
  store: TeacherStore;
  settlements(): Promise<{ cities: SettlementName[]; eventTowns: SettlementName[] }>;
  benchmarkQuestions(): Promise<string[]>;
  resolveSettlement: CheckContext["resolveSettlement"];
  dailyLimit: number;
  chunkSize?: number;
  concurrency?: number;
  /** Waits before a retry; replaced in tests. */
  sleep?(ms: number): Promise<void>;
}

export class TeacherBusyError extends Error { readonly code = "teacher_running"; }
export class TeacherLimitError extends Error { readonly code = "daily_limit"; constructor(readonly remaining: number) { super("daily_limit"); } }
export class BatchStateError extends Error { constructor(readonly code: "not_found" | "batch_busy" | "nothing_to_regenerate") { super(code); } }

const SETTLEMENTS_PER_PROMPT = 40;
const RETRIES = 2;

export class TeacherService {
  #active: { batchId: string; done: number; total: number; controller: AbortController } | null = null;
  /** Set from the first check until the batch runs, so two requests cannot both start one. */
  #reserving = false;

  constructor(private readonly options: TeacherServiceOptions) {}

  get progress(): { batchId: string; done: number; total: number } | null {
    return this.#active ? { batchId: this.#active.batchId, done: this.#active.done, total: this.#active.total } : null;
  }

  async usage(): Promise<{ generatedToday: number; dailyLimit: number }> {
    return { generatedToday: await this.options.store.generatedToday(), dailyLimit: this.options.dailyLimit };
  }

  async start(input: { topic: string; languages: TeacherLanguage[]; count: number; crossCheck: boolean }): Promise<TeacherBatch> {
    const topic = findTopic(input.topic);
    if (!topic) throw new BatchStateError("not_found");
    await this.#reserve(input.count);
    try {
      const batch = await this.options.store.createBatch({ topic: topic.id, languages: input.languages, requested: input.count, model: this.options.teacher.model, crossCheck: input.crossCheck });
      this.#run(batch, topic, input.languages, input.count, input.crossCheck);
      return batch;
    } finally { this.#reserving = false; }
  }

  /** Replaces the rejected examples of a batch with new ones and brings it back to the requested size. */
  async regenerate(batchId: string): Promise<TeacherBatch> {
    const batch = await this.options.store.getBatch(batchId);
    if (!batch) throw new BatchStateError("not_found");
    if (batch.status === "generating" || batch.status === "accepted") throw new BatchStateError("batch_busy");
    const kept = batch.counts.passed + batch.counts.disputed + batch.counts.edited;
    const count = Math.max(0, batch.requested - kept);
    if (!count) throw new BatchStateError("nothing_to_regenerate");
    await this.#reserve(count);
    try {
      await this.options.store.deleteRejected(batchId);
      await this.options.store.updateBatch(batchId, { status: "generating", errorCode: null, generated: count });
      this.#run(batch, findTopic(batch.topic)!, batch.languages as TeacherLanguage[], count, batch.crossCheck);
    } finally { this.#reserving = false; }
    return (await this.options.store.getBatch(batchId))!;
  }

  cancel(batchId: string): boolean {
    if (this.#active?.batchId !== batchId) return false;
    this.#active.controller.abort();
    return true;
  }

  /** Takes the single slot and checks the key and the daily limit before anything is stored. */
  async #reserve(count: number): Promise<void> {
    if (!this.options.teacher.available) throw new TeacherError("teacher_unavailable");
    if (this.#active || this.#reserving) throw new TeacherBusyError("teacher_running");
    this.#reserving = true;
    try {
      const remaining = this.options.dailyLimit - await this.options.store.generatedToday();
      if (count > remaining) throw new TeacherLimitError(Math.max(0, remaining));
    } catch (error) {
      this.#reserving = false;
      throw error;
    }
  }

  #run(batch: TeacherBatch, topic: TeacherTopic, languages: TeacherLanguage[], count: number, withCrossCheck: boolean): void {
    const controller = new AbortController();
    const active = { batchId: batch.id, done: 0, total: count, controller };
    this.#active = active;
    void this.#execute(active, topic, languages, withCrossCheck).finally(() => { if (this.#active === active) this.#active = null; });
  }

  async #execute(active: { batchId: string; done: number; total: number; controller: AbortController }, topic: TeacherTopic, languages: TeacherLanguage[], withCrossCheck: boolean): Promise<void> {
    const { store, teacher } = this.options;
    const chunkSize = this.options.chunkSize ?? 20;
    let errorCode: string | null = null;
    // Examples actually asked of the teacher; chunks never sent are given back to the daily limit.
    let asked = 0;
    try {
      const [settlements, benchmark, known, existing] = await Promise.all([this.options.settlements(), this.options.benchmarkQuestions(), store.knownQuestions(), store.listExamples(active.batchId)]);
      const pool = topic.settlements === "none" ? [] : topic.settlements === "eventTowns" ? settlements.eventTowns : settlements.cities;
      const eventTowns = topic.settlements === "both" ? settlements.eventTowns : [];
      const context: CheckContext = { topic, resolveSettlement: this.options.resolveSettlement, benchmark: new Set(benchmark.map(normalizeQuestion)), seen: new Set(known.map(normalizeQuestion)) };
      const written = existing.map((example) => example.question);
      const chunks: number[] = [];
      for (let left = active.total; left > 0; left -= chunkSize) chunks.push(Math.min(chunkSize, left));
      let next = 0;
      // A failed chunk stops the other worker after its current chunk, so nothing is written after the batch closes.
      let failed = false;
      const worker = async () => {
        while (next < chunks.length && !active.controller.signal.aborted && !failed) {
          const size = chunks[next++]!;
          asked += size;
          const { examples, usage } = await this.#withRetry(() => teacher.generate({ topic, languages, count: size, settlements: sample(pool, topic.id === "exonyms"), eventTowns: sample(eventTowns, false).slice(0, 20), avoid: written.slice(-30) }, active.controller.signal));
          let checked: CheckedExample[] = [];
          for (const example of examples.slice(0, size)) checked.push(await checkExample(example, context));
          let total = usage;
          if (withCrossCheck) {
            const passed = checked.filter((example) => example.status === "passed");
            if (passed.length) {
              const blind = await this.#withRetry(() => teacher.answer(passed.map((example) => example.question), active.controller.signal));
              const answers = new Map(passed.map((example, index) => [example, blind.answers[index] ?? null]));
              checked = await Promise.all(checked.map((example) => (answers.has(example) ? crossCheck(example, answers.get(example)!, this.options.resolveSettlement) : example)));
              total = { promptTokens: total.promptTokens + blind.usage.promptTokens, completionTokens: total.completionTokens + blind.usage.completionTokens };
            }
          }
          await store.insertExamples(active.batchId, checked);
          await store.updateBatch(active.batchId, { usage: total });
          written.push(...checked.map((example) => example.question));
          active.done += size;
        }
      };
      const results = await Promise.allSettled(Array.from({ length: Math.min(this.options.concurrency ?? 2, chunks.length) }, () => worker().catch((error: unknown) => { failed = true; throw error; })));
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
      if (active.controller.signal.aborted) errorCode = "cancelled";
    } catch (error) {
      errorCode = active.controller.signal.aborted ? "cancelled" : error instanceof TeacherError ? error.code : "teacher_failed";
      if (!(error instanceof TeacherError) && !active.controller.signal.aborted) console.error("Teacher batch failed", { batchId: active.batchId, error: error instanceof Error ? error.message : String(error) });
    }
    // What was written stays reviewable; a batch with nothing in it is closed.
    const batch = await store.getBatch(active.batchId).catch(() => null);
    const stored = batch ? batch.counts.passed + batch.counts.disputed + batch.counts.rejected + batch.counts.edited : 0;
    const status: BatchStatus = stored > 0 ? "review" : errorCode === "cancelled" ? "cancelled" : errorCode ? "failed" : "review";
    await store.updateBatch(active.batchId, { status, errorCode, finished: true, ...(asked < active.total ? { generated: asked - active.total } : {}) }).catch(() => undefined);
  }

  /** Rate limits and transient failures are retried twice; a wrong key or a refusal is not. */
  async #withRetry<T>(call: () => Promise<T>): Promise<T> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        const retriable = error instanceof TeacherError && (error.code === "teacher_rate_limited" || error.code === "teacher_failed" || error.code === "teacher_invalid_answer");
        if (!retriable || attempt >= RETRIES) throw error;
        await sleep(attempt === 0 ? 3_000 : 10_000);
      }
    }
  }
}

/** A random handful of settlements per request; for city names, those whose English name differs come first. */
function sample(pool: SettlementName[], preferExonyms: boolean): SettlementName[] {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  if (preferExonyms) shuffled.sort((left, right) => Number(Boolean(right.nameEn && right.nameEn !== right.name)) - Number(Boolean(left.nameEn && left.nameEn !== left.name)));
  return shuffled.slice(0, SETTLEMENTS_PER_PROMPT);
}
