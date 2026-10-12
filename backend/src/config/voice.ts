import { z } from "zod";

// Demo, opt-in: voice input relays microphone audio to an external transcription provider.
// Only the OpenAI Realtime host is allowlisted.
const ALLOWED_REALTIME_HOSTS = new Set(["api.openai.com"]);

export function isAllowedRealtimeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && ALLOWED_REALTIME_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const voiceEnvironmentSchema = z.object({
  VOICE_INPUT_ENABLED: z.preprocess(
    (value) => value === undefined || value === "" ? "false" : value,
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ),
  OPENAI_API_KEY: z.string().optional().transform((value) => value?.trim() || undefined),
  OPENAI_REALTIME_URL: z.string().url()
    .refine(isAllowedRealtimeUrl, "OPENAI_REALTIME_URL must be a wss:// URL on an allowlisted OpenAI host")
    .default("wss://api.openai.com/v1/realtime?intent=transcription"),
  OPENAI_TRANSCRIBE_MODEL: z.string().min(1).max(80).default("gpt-live-transcribe"),
  VOICE_MAX_SESSION_SECONDS: z.coerce.number().int().min(10).max(600).default(120),
  VOICE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
});

export type VoiceEnvironment = z.infer<typeof voiceEnvironmentSchema>;

export function isVoiceInputConfigured(environment: VoiceEnvironment): boolean {
  return environment.VOICE_INPUT_ENABLED && Boolean(environment.OPENAI_API_KEY);
}
