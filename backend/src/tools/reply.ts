import { z } from "zod";
import type { ToolDefinition } from "../llm/ollama.provider.js";

/**
 * Not a data tool: the model calls it to answer a message that needs no data (a greeting, a clarifying question,
 * what the app can do). Making every first step a tool call keeps lookups from being skipped silently.
 */
export const REPLY_TOOL = "reply";

const replyArgsSchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();

export function parseReplyArgs(raw: unknown): string | null {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  const parsed = replyArgsSchema.safeParse(value);
  return parsed.success ? parsed.data.text : null;
}

export const replyToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: REPLY_TOOL,
    description: "Answer the user directly when the reply needs no data: greetings, a short clarifying question, explaining what the app can do, or answering from the current trip plan or earlier tool results already in this conversation. Never use it to name places, events, or facts that no tool returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", maxLength: 4000, description: "The answer in the user's language." } },
    },
  },
};
