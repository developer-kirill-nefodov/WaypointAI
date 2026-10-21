import { env } from "../config/env.js";

/**
 * What the local runtime reports about the configured model: its family, size, architecture, quantization, and
 * licence from the GGUF metadata (Ollama /api/show), plus our own runtime settings. Only known fields are copied, as
 * plain values; nothing is inferred beyond the metadata.
 */
export interface ModelCard {
  name: string;
  family: string | null;
  version: string | null;
  /** The developer's fine-tune of the base model, for example "Instruct". */
  finetune: string | null;
  parameterCount: number | null;
  parameterSize: string | null;
  format: string | null;
  quantization: string | null;
  architecture: { layers: number | null; attentionHeads: number | null; keyValueHeads: number | null; embeddingLength: number | null; feedForwardLength: number | null };
  contextLength: number | null;
  license: string | null;
  licenseUrl: string | null;
  /** The developer's model page, derived from the licence link when it is on Hugging Face. */
  modelUrl: string | null;
  capabilities: string[];
  /** When the model was pulled into the local runtime. */
  installedAt: string | null;
  runtimeVersion: string | null;
  settings: { contextLength: number; maxAnswerTokens: number; temperature: number; keepAlive: string };
}

/** Links from model metadata are shown in the app, so only these hosts are accepted. */
const LINK_HOSTS = new Set(["huggingface.co", "github.com", "qwenlm.github.io"]);

function safeLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && LINK_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max = 80) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** Builds the card from /api/show and /api/version payloads; exported for tests. */
export function toModelCard(show: unknown, version: unknown): ModelCard {
  const payload = (show && typeof show === "object" ? show : {}) as Record<string, unknown>;
  const details = (payload.details && typeof payload.details === "object" ? payload.details : {}) as Record<string, unknown>;
  const info = (payload.model_info && typeof payload.model_info === "object" ? payload.model_info : {}) as Record<string, unknown>;
  const architecture = text(info["general.architecture"], 40);
  const field = (name: string) => (architecture ? info[`${architecture}.${name}`] : undefined);
  const licenseUrl = safeLink(info["general.license.link"]);
  const modelUrl = licenseUrl && new URL(licenseUrl).hostname === "huggingface.co" ? licenseUrl.replace(/\/(blob|resolve)\/.*$/, "") : null;
  const installedAt = text(payload.modified_at, 60);
  return {
    name: env.OLLAMA_MODEL,
    family: text(info["general.basename"]) ?? text(details.family),
    version: text(info["general.version"], 40),
    finetune: text(info["general.finetune"], 40),
    parameterCount: count(info["general.parameter_count"]),
    parameterSize: text(details.parameter_size, 20),
    format: text(details.format, 20),
    quantization: text(details.quantization_level, 20),
    architecture: {
      layers: count(field("block_count")),
      attentionHeads: count(field("attention.head_count")),
      keyValueHeads: count(field("attention.head_count_kv")),
      embeddingLength: count(field("embedding_length")),
      feedForwardLength: count(field("feed_forward_length")),
    },
    contextLength: count(field("context_length")),
    license: text(info["general.license"], 40),
    licenseUrl,
    modelUrl,
    capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 30)).slice(0, 10) : [],
    installedAt: installedAt && !Number.isNaN(Date.parse(installedAt)) ? new Date(installedAt).toISOString() : null,
    runtimeVersion: text((version as { version?: unknown } | null)?.version, 20),
    settings: { contextLength: env.OLLAMA_NUM_CONTEXT, maxAnswerTokens: env.OLLAMA_NUM_PREDICT, temperature: env.OLLAMA_TEMPERATURE, keepAlive: env.OLLAMA_KEEP_ALIVE },
  };
}

/** Reads the configured model's metadata from the local runtime; null when the runtime or the model is unavailable. */
export async function describeConfiguredModel(): Promise<ModelCard | null> {
  try {
    const [show, version] = await Promise.all([
      fetch(new URL("/api/show", env.OLLAMA_BASE_URL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: env.OLLAMA_MODEL }),
        signal: AbortSignal.timeout(3000),
      }),
      fetch(new URL("/api/version", env.OLLAMA_BASE_URL), { signal: AbortSignal.timeout(3000) }),
    ]);
    if (!show.ok) return null;
    return toModelCard(await show.json(), version.ok ? await version.json() : null);
  } catch {
    return null;
  }
}
