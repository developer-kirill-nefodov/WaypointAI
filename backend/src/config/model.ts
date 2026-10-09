import { z } from "zod";

export function isLocalOllamaUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export const modelEnvironmentSchema = z.object({
  OLLAMA_BASE_URL: z.string().url()
    .refine(isLocalOllamaUrl, "Ollama must be bound to loopback for local inference")
    .default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).default("qwen3:4b-instruct-2507-q4_K_M"),
  OLLAMA_NUM_CONTEXT: z.coerce.number().int().min(512).max(32768).default(4096),
  OLLAMA_NUM_PREDICT: z.coerce.number().int().min(128).max(2048).default(768),
  OLLAMA_NUM_BATCH: z.coerce.number().int().min(1).max(2048).default(256),
  OLLAMA_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  OLLAMA_KEEP_ALIVE: z.string().min(1).default("60s"),
});

export type ModelEnvironment = z.infer<typeof modelEnvironmentSchema>;
