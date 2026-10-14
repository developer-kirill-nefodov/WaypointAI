import type { ToolDefinition } from "../llm/ollama.provider.js";

/**
 * Not a data tool: the model calls it when the message needs no data (a greeting, a clarifying question, what the
 * app can do, or facts already in the conversation). The backend then lets the model write the answer as a stream.
 * Making every first step a tool call keeps lookups from being skipped silently.
 */
export const REPLY_TOOL = "reply";

export const replyToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: REPLY_TOOL,
    description: "Answer the user directly when the reply needs no data: greetings, a short clarifying question, explaining what the app can do, or answering from the current trip plan or earlier tool results already in this conversation. Takes no arguments; you write the answer next. Never use it to name places, events, or facts that no tool returned.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
};
