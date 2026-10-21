import type { ServerFrame } from "@waypoint-ai/shared";
import type { OllamaCallMetrics } from "../llm/ollama.provider.js";

/** turn.progress at most four times a second, so a fast model does not flood the socket. */
export const PROGRESS_INTERVAL_MS = 250;

type StatusPhase = Extract<ServerFrame, { type: "turn.status" }>["phase"];

export interface TurnStep {
  done(detail?: string): void;
  fail(detail?: string): void;
}

/**
 * What a turn tells the chat while it runs: its frames, the lines of the progress feed with their durations, and the
 * token progress of a model call on the latest running step. It also notes how the turn ended (for the journal) and
 * which models it called (sent with the answer for its header).
 */
export class TurnReporter {
  readonly models = new Set<string>();
  readonly ending: { errorCode: string | null; clarification: boolean; cancelled: boolean } = { errorCode: null, clarification: false, cancelled: false };
  #stepCount = 0;
  /** Steps still running, latest last: a model call reports its progress on the latest one. */
  readonly #running: string[] = [];

  constructor(readonly requestId: string, private readonly send: (event: ServerFrame) => void, private readonly now: () => number = () => performance.now()) {}

  emit(event: ServerFrame): void {
    if (event.type === "turn.completed" && this.models.size) event = { ...event, models: [...this.models] };
    if (event.type === "turn.error") this.ending.errorCode = event.code;
    if (event.type === "turn.clarification") this.ending.clarification = true;
    if (event.type === "turn.cancelled") this.ending.cancelled = true;
    this.send(event);
  }

  status(phase: StatusPhase, label: string): void {
    this.emit({ protocolVersion: 1, type: "turn.status", requestId: this.requestId, phase, label });
  }

  delta(text: string): void {
    this.emit({ protocolVersion: 1, type: "assistant.delta", requestId: this.requestId, text });
  }

  /** Replies assembled from database rows go out section by section, in the order they were built. */
  sections(message: string): void {
    const sections = message.split("\n\n");
    sections.forEach((section, index) => this.delta(index < sections.length - 1 ? `${section}\n\n` : section));
  }

  /** One line of the progress feed; done and failed carry the step's duration. */
  step(label: string): TurnStep {
    const stepId = `step-${++this.#stepCount}`;
    const startedAt = this.now();
    const send = (state: "running" | "done" | "failed", detail?: string) => {
      if (state !== "running") this.#running.splice(this.#running.indexOf(stepId) >>> 0, 1);
      this.emit({
        protocolVersion: 1, type: "turn.step", requestId: this.requestId, stepId, label: label.slice(0, 160), state,
        ...(detail ? { detail: detail.slice(0, 160) } : {}), ...(state === "running" ? {} : { durationMs: Math.round(this.now() - startedAt) }),
      });
    };
    this.#running.push(stepId);
    send("running");
    return { done: (detail) => send("done", detail), fail: (detail) => send("failed", detail) };
  }

  /**
   * Progress of one model call on the latest running step: "reading" until the first token, then the tokens so far
   * and their rate. Returns the call's onToken callback.
   */
  modelProgress(): (tokens: number) => void {
    const stepId = this.#running.at(-1);
    let firstTokenAt = 0;
    let lastProgressAt = 0;
    const progress = (phase: "reading" | "generating", tokens: number) => {
      if (!stepId || !this.#running.includes(stepId)) return;
      const now = this.now();
      if (phase === "generating" && tokens > 1 && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      const seconds = (now - firstTokenAt) / 1000;
      this.emit({ protocolVersion: 1, type: "turn.progress", requestId: this.requestId, stepId, phase, tokens, ...(phase === "generating" && tokens > 1 && seconds > 0.2 ? { tokensPerSecond: Math.round((tokens - 1) / seconds * 10) / 10 } : {}) });
    };
    progress("reading", 0);
    return (tokens) => {
      if (tokens === 1) firstTokenAt = this.now();
      progress("generating", tokens);
    };
  }
}

/** Where a turn spent its time, logged when it ends. */
export class TurnMetrics {
  readonly startedAt = performance.now();
  databaseDurationMs = 0;
  toolDurationMs = 0;
  modelCallCount = 0;
  modelDurationMs = 0;
  promptEvaluationDurationMs = 0;
  generationDurationMs = 0;
  promptTokenCount = 0;
  generatedTokenCount = 0;

  addModelCall(metrics: OllamaCallMetrics): void {
    this.modelCallCount += 1;
    this.modelDurationMs += metrics.totalDurationMs;
    this.promptEvaluationDurationMs += metrics.promptEvaluationDurationMs;
    this.generationDurationMs += metrics.generationDurationMs;
    this.promptTokenCount += metrics.promptTokenCount;
    this.generatedTokenCount += metrics.generatedTokenCount;
  }

  /** Adds the time since `startedAt` to the database or tool total. */
  addSince(kind: "database" | "tool", startedAt: number): void {
    const elapsed = Math.round(performance.now() - startedAt);
    if (kind === "database") this.databaseDurationMs += elapsed;
    else this.toolDurationMs += elapsed;
  }

  elapsedMs(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  summary() {
    return {
      totalDurationMs: this.elapsedMs(),
      databaseDurationMs: this.databaseDurationMs,
      toolDurationMs: this.toolDurationMs,
      modelCallCount: this.modelCallCount,
      modelDurationMs: this.modelDurationMs,
      promptEvaluationDurationMs: this.promptEvaluationDurationMs,
      generationDurationMs: this.generationDurationMs,
      promptTokenCount: this.promptTokenCount,
      generatedTokenCount: this.generatedTokenCount,
    };
  }
}
