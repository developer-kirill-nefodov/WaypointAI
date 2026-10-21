import { randomUUID } from "node:crypto";
import type { ServerFrame } from "@waypoint-ai/shared";
import { processTurn } from "../assistant/turn.js";
import type { CaseRunner } from "./eval-runner.js";
import { env } from "../config/env.js";

/** Exam turns run in their own workspace and conversation and are not stored, so they never mix with real chats. */
const EXAM_WORKSPACE = "exam";

/** Asks one exam question as a fresh chat turn and records what the assistant did. */
export const runExamCase: CaseRunner = async (examCase, { withLessons, signal, firstStepOnly, router, model }) => {
  const toolCalls: Array<{ tool: string; args: unknown }> = [];
  let appliedLessons: Array<{ id: string; title: string; kind: string; score: number }> = [];
  let answer = "";
  let citationsMode: "cited" | "shown_to_model" | undefined;
  let errorCode: string | undefined;
  const emit = (frame: ServerFrame) => {
    if (frame.type === "turn.completed") {
      answer = frame.assistantMessage;
      citationsMode = frame.citationsMode;
    } else if (frame.type === "turn.clarification") {
      answer = frame.message;
    } else if (frame.type === "turn.error") {
      errorCode = frame.code;
    } else if (frame.type === "turn.cancelled") {
      errorCode = "cancelled";
    }
  };
  await processTurn(
    {
      protocolVersion: 1,
      type: "turn.submit",
      requestId: `exam-${randomUUID()}`,
      conversationId: null,
      message: examCase.question,
      scope: { workspaceId: EXAM_WORKSPACE, language: examCase.language },
    },
    randomUUID(),
    signal,
    emit,
    {
      ephemeral: true,
      firstStepOnly,
      // A router run asks the router model (the run's model, else ROUTER_MODEL, else the main model); other runs use
      // the full prompt whatever ROUTER_MODEL says, so they measure the model itself.
      routerModel: router ? model ?? env.ROUTER_MODEL ?? env.OLLAMA_MODEL : null,
      ...(model && !router ? { model } : {}),
      ...(withLessons ? {} : { lessons: null }),
      onLessons: (applied) => { appliedLessons = applied; },
      onToolCall: (tool, args) => { toolCalls.push({ tool, args }); },
    },
  );
  return { toolCalls, answer, citationsMode, appliedLessons, ...(errorCode ? { errorCode } : {}) };
};
