import { env } from "../config/env.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: Array<{ type?: "function"; function: { index?: number; name: string; arguments: unknown } }>;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OllamaCallMetrics {
  totalDurationMs: number;
  loadDurationMs: number;
  promptEvaluationDurationMs: number;
  promptTokenCount: number;
  generationDurationMs: number;
  generatedTokenCount: number;
}

export interface ChatResult { message: ChatMessage; metrics: OllamaCallMetrics }
export class OllamaUnavailableError extends Error {}

export async function chat(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal): Promise<ChatResult> {
  let response: Response;
  try { response = await fetch(new URL("/api/chat", env.OLLAMA_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OLLAMA_MODEL,
      messages,
      tools,
      stream: false,
      think: false,
      keep_alive: env.OLLAMA_KEEP_ALIVE,
      options: {
        num_ctx: env.OLLAMA_NUM_CONTEXT,
        num_predict: env.OLLAMA_NUM_PREDICT,
        num_batch: env.OLLAMA_NUM_BATCH,
        temperature: env.OLLAMA_TEMPERATURE,
      },
    }),
    signal,
  }); } catch (error) {
    if (signal.aborted) throw error;
    throw new OllamaUnavailableError("Local Ollama API could not be reached");
  }
  if (!response.ok) throw new OllamaUnavailableError(`Ollama returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("message" in value) || !value.message || typeof value.message !== "object") {
    throw new Error("Ollama returned an invalid chat response");
  }
  const payload = value as Record<string, unknown>;
  const message = payload.message as ChatMessage;
  if (typeof message.content !== "string") throw new Error("Ollama returned an invalid message");
  return {
    message,
    metrics: {
      totalDurationMs: nanosecondsToMilliseconds(payload.total_duration),
      loadDurationMs: nanosecondsToMilliseconds(payload.load_duration),
      promptEvaluationDurationMs: nanosecondsToMilliseconds(payload.prompt_eval_duration),
      promptTokenCount: finiteNumber(payload.prompt_eval_count),
      generationDurationMs: nanosecondsToMilliseconds(payload.eval_duration),
      generatedTokenCount: finiteNumber(payload.eval_count),
    },
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function nanosecondsToMilliseconds(value: unknown): number {
  return Math.round(finiteNumber(value) / 1_000_000);
}

/** Only probes configured local Ollama; this does not call a model. */
export async function isConfiguredModelAvailable(): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/tags", env.OLLAMA_BASE_URL), { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("models" in payload) || !Array.isArray(payload.models)) return false;
    return payload.models.some((item: unknown) => item && typeof item === "object" && "name" in item && item.name === env.OLLAMA_MODEL);
  } catch { return false; }
}
