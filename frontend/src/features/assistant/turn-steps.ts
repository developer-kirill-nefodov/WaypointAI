import type { ServerFrame } from "@waypoint-ai/shared";
import type { TurnStep } from "./chat-storage";

/**
 * The progress feed of the running turn, updated from turn.step and turn.progress frames. The client stamps when a
 * step began (for its live timer); the server's duration replaces the client's measure when the step ends.
 */
export function applyStepFrame(steps: TurnStep[], frame: Extract<ServerFrame, { type: "turn.step" }>, now = Date.now()): TurnStep[] {
  const previous = steps.find((item) => item.id === frame.stepId);
  const startedAt = previous?.startedAt ?? now;
  const step: TurnStep = {
    id: frame.stepId, label: frame.label, state: frame.state, startedAt,
    ...(frame.detail ? { detail: frame.detail } : {}),
    ...(frame.state === "running" ? (previous?.progress ? { progress: previous.progress } : {}) : { durationMs: frame.durationMs ?? now - startedAt }),
  };
  return previous ? steps.map((item) => item.id === step.id ? step : item) : [...steps, step];
}

/** The model call's progress on a running step; a finished step keeps none. */
export function applyProgressFrame(steps: TurnStep[], frame: Extract<ServerFrame, { type: "turn.progress" }>): TurnStep[] {
  const progress = { phase: frame.phase, tokens: frame.tokens, ...(frame.tokensPerSecond ? { tokensPerSecond: frame.tokensPerSecond } : {}) };
  return steps.map((item) => item.id === frame.stepId && item.state === "running" ? { ...item, progress } : item);
}

/** The steps kept on a finished turn's message; a step still running when the turn ends is shown as not finished. */
export function finishSteps(steps: TurnStep[]): TurnStep[] | undefined {
  const finished = steps.map((step) => step.state === "running" ? { ...step, state: "failed" as const } : step);
  return finished.length ? finished : undefined;
}
