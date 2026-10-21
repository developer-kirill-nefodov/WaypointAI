import { checkTurn, type ExamCase, type TurnObservation } from "./eval-checks.js";
import { summarizeResults, type RunMetrics } from "./benchmark-metrics.js";
import type { EvalResult, EvalRun } from "../data/training.repository.js";

/**
 * full: the whole turn with its answer; first_step: only the model's first tool call with the full prompt;
 * router: only the first call from the short router prompt (assistant/router.ts).
 */
export type RunMode = "full" | "first_step" | "router";

export interface RunInput {
  withLessons: boolean;
  label: string | null;
  mode: RunMode;
  /** Which kinds of cases to ask; empty asks every enabled case. */
  origins: string[];
  /** Another installed model to compare with the configured one. */
  model?: string;
}

export interface EvalRunStore {
  createRun(input: { withLessons: boolean; lessonIds: string[]; model: string; label: string | null; caseCount: number; mode: RunMode; caseOrigins: string[] }): Promise<EvalRun>;
  addResult(runId: string, result: EvalResult): Promise<EvalRun>;
  finishRun(runId: string, status: "succeeded" | "failed" | "cancelled", errorCode?: string | null, metrics?: RunMetrics | null): Promise<void>;
}

/** One exam question asked as a fresh chat turn; the observation says what the assistant did. */
export type CaseRunner = (examCase: ExamCase, options: { withLessons: boolean; signal: AbortSignal; firstStepOnly: boolean; router: boolean; model?: string }) => Promise<TurnObservation & { appliedLessons: EvalResult["appliedLessons"] }>;

export interface EvalRunnerOptions {
  store: EvalRunStore;
  runCase: CaseRunner;
  /** IDs of the lessons enabled now, recorded with the run. */
  enabledLessonIds: () => Promise<string[]>;
  model: string;
  /** Called after every case and when the run ends, for the progress shown in the app. */
  onProgress?: (run: EvalRun) => void;
  /** The chat and the exam share one local model; a busy model is retried after this pause. */
  busyRetryMs?: number;
  busyRetries?: number;
  unavailableRetryMs?: number;
  unavailableRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class EvalBusyError extends Error {
  readonly code = "exam_running";
}

export class NoExamCasesError extends Error {
  readonly code = "no_cases";
}

/** Runs one exam at a time in the background, case by case, so it can be cancelled between and within cases. */
export class EvalRunner {
  #active: { id: string; controller: AbortController } | null = null;

  constructor(private readonly options: EvalRunnerOptions) {}

  get activeRunId(): string | null {
    return this.#active?.id ?? null;
  }

  /** Records the run and starts it; resolves with the run row before any question is asked. */
  async start(cases: ExamCase[], input: Partial<RunInput> & { withLessons: boolean; label: string | null }): Promise<EvalRun> {
    if (this.#active) throw new EvalBusyError("exam_running");
    const run: RunInput = { mode: "full", origins: [], ...input };
    const enabled = cases.filter((examCase) => examCase.enabled && (!run.origins.length || run.origins.includes(examCase.origin ?? "manual")));
    if (!enabled.length) throw new NoExamCasesError("no_cases");
    const controller = new AbortController();
    // Reserve the slot before the first await so two requests cannot both start.
    this.#active = { id: "", controller };
    try {
      const lessonIds = run.withLessons ? await this.options.enabledLessonIds() : [];
      const created = await this.options.store.createRun({ withLessons: run.withLessons, lessonIds, model: run.model ?? this.options.model, label: run.label, caseCount: enabled.length, mode: run.mode, caseOrigins: run.origins });
      this.#active = { id: created.id, controller };
      void this.#execute(created, enabled, run, controller);
      return created;
    } catch (error) {
      this.#active = null;
      throw error;
    }
  }

  cancel(runId: string): boolean {
    if (this.#active?.id !== runId) return false;
    this.#active.controller.abort();
    return true;
  }

  async #execute(run: EvalRun, cases: ExamCase[], input: RunInput, controller: AbortController): Promise<void> {
    const { store, onProgress } = this.options;
    const done: EvalResult[] = [];
    try {
      for (const examCase of cases) {
        if (controller.signal.aborted) break;
        const result = await this.#runCase(examCase, input, controller.signal);
        if (controller.signal.aborted) break;
        done.push(result);
        // Stored first: an optional call would skip evaluating its argument when there is no listener.
        const updated = await store.addResult(run.id, result);
        onProgress?.(updated);
      }
      await store.finishRun(run.id, controller.signal.aborted ? "cancelled" : "succeeded", null, done.length ? summarizeResults(done) : null);
    } catch (error) {
      console.error("Exam run failed", { runId: run.id, error: error instanceof Error ? error.message : error });
      await store.finishRun(run.id, "failed", "exam_failed").catch(() => undefined);
    } finally {
      this.#active = null;
      onProgress?.({ ...run, status: controller.signal.aborted ? "cancelled" : run.status });
    }
  }

  async #runCase(examCase: ExamCase, input: RunInput, signal: AbortSignal): Promise<EvalResult> {
    const firstStepOnly = input.mode !== "full";
    const { busyRetryMs = 3_000, busyRetries = 100, unavailableRetryMs = 10_000, unavailableRetries = 2, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = this.options;
    let startedAt = performance.now();
    let observation: Awaited<ReturnType<CaseRunner>>;
    for (let attempt = 0; ; attempt += 1) {
      // Time spent waiting for a busy model is not the answer's time.
      startedAt = performance.now();
      try {
        observation = await this.options.runCase(examCase, { withLessons: input.withLessons, signal, firstStepOnly, router: input.mode === "router", ...(input.model ? { model: input.model } : {}) });
      } catch (error) {
        observation = { toolCalls: [], answer: "", appliedLessons: [], errorCode: signal.aborted ? "cancelled" : error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "case_failed" };
      }
      // Someone is chatting: wait for the model instead of failing the case. A runtime hiccup (the model was
      // unloaded or the request failed) is retried a few times too; it says nothing about the answer.
      const retry = observation.errorCode === "busy" ? attempt < busyRetries : observation.errorCode === "model_unavailable" && attempt < unavailableRetries;
      if (!retry || signal.aborted) break;
      await sleep(observation.errorCode === "busy" ? busyRetryMs : unavailableRetryMs);
    }
    const checks = checkTurn(examCase, observation, firstStepOnly);
    return {
      caseId: examCase.id,
      question: examCase.question,
      skill: examCase.skill ?? "other",
      language: examCase.language,
      passed: checks.every((check) => check.passed),
      checks,
      toolCalls: observation.toolCalls,
      answer: observation.answer,
      appliedLessons: observation.appliedLessons,
      durationMs: Math.round(performance.now() - startedAt),
      errorCode: observation.errorCode ?? null,
    };
  }
}
