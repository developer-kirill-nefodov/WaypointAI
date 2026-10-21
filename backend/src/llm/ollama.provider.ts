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

/**
 * One chat call. `format` constrains the reply to a JSON schema (Ollama structured outputs) or, with "json", to any JSON. With `onDelta`, the reply
 * is streamed and each text fragment is passed on as it arrives; with `onToken`, it is streamed and only counted (for
 * progress). The returned message is the complete reply either way.
 */
export interface ChatOptions {
  format?: Record<string, unknown> | "json";
  onDelta?: (text: string) => void;
  /** Called with the number of chunks (about one token each) received so far. */
  onToken?: (tokens: number) => void;
  /** Overrides OLLAMA_NUM_PREDICT for one call, for example a short budget for a call that only picks a tool. */
  maxTokens?: number;
  /** Another installed model, for benchmark runs that compare models; set only by the server, never from a request. */
  model?: string;
}

export async function chat(messages: ChatMessage[], tools: ToolDefinition[], signal: AbortSignal, { format, onDelta, onToken, maxTokens, model }: ChatOptions = {}): Promise<ChatResult> {
  let response: Response;
  try { response = await fetch(new URL("/api/chat", env.OLLAMA_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model ?? env.OLLAMA_MODEL,
      messages,
      tools,
      ...(format ? { format } : {}),
      stream: Boolean(onDelta || onToken),
      think: false,
      keep_alive: env.OLLAMA_KEEP_ALIVE,
      options: {
        num_ctx: env.OLLAMA_NUM_CONTEXT,
        num_predict: maxTokens ?? env.OLLAMA_NUM_PREDICT,
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
  const payload = onDelta || onToken ? await readStream(response, onDelta, onToken) : await response.json() as unknown;
  if (!payload || typeof payload !== "object" || !("message" in payload) || !payload.message || typeof payload.message !== "object") {
    throw new Error("Ollama returned an invalid chat response");
  }
  const result = payload as Record<string, unknown>;
  const message = result.message as ChatMessage;
  if (typeof message.content !== "string") throw new Error("Ollama returned an invalid message");
  return {
    message,
    metrics: {
      totalDurationMs: nanosecondsToMilliseconds(result.total_duration),
      loadDurationMs: nanosecondsToMilliseconds(result.load_duration),
      promptEvaluationDurationMs: nanosecondsToMilliseconds(result.prompt_eval_duration),
      promptTokenCount: finiteNumber(result.prompt_eval_count),
      generationDurationMs: nanosecondsToMilliseconds(result.eval_duration),
      generatedTokenCount: finiteNumber(result.eval_count),
    },
  };
}

/**
 * Reads Ollama's newline-delimited JSON stream: content fragments are forwarded and joined, tool calls collected,
 * and the final chunk's metrics kept. Returns the same shape as a non-streamed reply.
 */
async function readStream(response: Response, onDelta?: (text: string) => void, onToken?: (tokens: number) => void): Promise<unknown> {
  if (!response.body) throw new Error("Ollama returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];
  let last: Record<string, unknown> = {};
  let tokens = 0;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line) as Record<string, unknown>;
    if (typeof chunk.error === "string") throw new OllamaUnavailableError("Ollama stream failed");
    const message = chunk.message as Partial<ChatMessage> | undefined;
    if (message?.content) {
      content += message.content;
      onDelta?.(message.content);
    }
    if (message?.tool_calls?.length) toolCalls.push(...message.tool_calls);
    if (!chunk.done && (message?.content || message?.tool_calls?.length)) onToken?.(++tokens);
    last = chunk;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line);
  }
  handle(buffer + decoder.decode());
  return { ...last, message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } };
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

/** Names of the models installed in the local runtime; empty when it is unreachable. */
export async function listInstalledModels(): Promise<string[]> {
  try {
    const response = await fetch(new URL("/api/tags", env.OLLAMA_BASE_URL), { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("models" in payload) || !Array.isArray(payload.models)) return [];
    return payload.models.flatMap((item: unknown) => item && typeof item === "object" && "name" in item && typeof item.name === "string" ? [item.name] : []);
  } catch { return []; }
}
