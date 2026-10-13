import { WebSocket } from "ws";
import { env } from "../config/env.js";
import {
  TranscriptionProviderError,
  type TranscriptionEvents,
  type TranscriptionOptions,
  type TranscriptionStream,
} from "./transcription.provider.js";

// Upstream event names from the OpenAI Realtime transcription API.
const DELTA_EVENT = "conversation.item.input_audio_transcription.delta";
const COMPLETED_EVENT = "conversation.item.input_audio_transcription.completed";
const FAILED_EVENT = "conversation.item.input_audio_transcription.failed";
const EMPTY_COMMIT_ERROR = "input_audio_buffer_commit_empty";

export async function openRealtimeTranscription(
  options: TranscriptionOptions,
  events: TranscriptionEvents,
): Promise<TranscriptionStream> {
  if (!env.OPENAI_API_KEY) throw new TranscriptionProviderError("provider_unavailable");
  const upstream = new WebSocket(env.OPENAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    handshakeTimeout: env.VOICE_CONNECT_TIMEOUT_MS,
  });
  let ready = false;
  let finishing = false;
  let closedByClient = false;
  let failed = false;

  const stream: TranscriptionStream = {
    appendAudio(base64Audio) {
      sendUpstream(upstream, { type: "input_audio_buffer.append", audio: base64Audio });
    },
    finish() {
      finishing = true;
      sendUpstream(upstream, { type: "input_audio_buffer.commit" });
    },
    close() {
      closedByClient = true;
      upstream.close(1000);
    },
  };

  return new Promise<TranscriptionStream>((resolve, reject) => {
    const connectTimer = setTimeout(() => fail("timeout"), env.VOICE_CONNECT_TIMEOUT_MS);
    const onAbort = () => {
      closedByClient = true;
      clearTimeout(connectTimer);
      upstream.terminate();
      reject(new TranscriptionProviderError("provider_unavailable"));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    function fail(failure: "provider_unavailable" | "timeout") {
      if (failed) return;
      failed = true;
      clearTimeout(connectTimer);
      options.signal.removeEventListener("abort", onAbort);
      upstream.terminate();
      if (ready) events.onFailure(failure);
      else reject(new TranscriptionProviderError(failure));
    }

    upstream.on("open", () => {
      sendUpstream(upstream, {
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: env.OPENAI_TRANSCRIBE_MODEL,
                ...(options.language ? { languages: [options.language] } : {}),
              },
              // The client commits audio explicitly on voice.stop.
              turn_detection: null,
            },
          },
        },
      });
    });

    upstream.on("message", (raw) => {
      const event = parseEvent(raw.toString());
      if (!event) return;
      if (event.type === "session.updated" && !ready) {
        ready = true;
        clearTimeout(connectTimer);
        options.signal.removeEventListener("abort", onAbort);
        resolve(stream);
      } else if (event.type === DELTA_EVENT && typeof event.delta === "string") {
        events.onDelta(event.delta);
      } else if (event.type === COMPLETED_EVENT && typeof event.transcript === "string") {
        events.onCompleted(event.transcript);
      } else if (event.type === FAILED_EVENT) {
        fail("provider_unavailable");
      } else if (event.type === "error") {
        // Committing without speech is not a failure; it simply yields no transcript.
        if (finishing && getErrorCode(event) === EMPTY_COMMIT_ERROR) events.onCompleted("");
        else fail("provider_unavailable");
      }
    });

    upstream.on("error", () => fail("provider_unavailable"));
    upstream.on("close", () => {
      if (!closedByClient) fail("provider_unavailable");
    });
  });
}

type UpstreamEvent = { type: string } & Record<string, unknown>;

function parseEvent(raw: string): UpstreamEvent | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "type" in value && typeof value.type === "string") return value as UpstreamEvent;
  } catch {
    // Ignore malformed upstream frames; the session timeout bounds a silent provider.
  }
  return undefined;
}

function getErrorCode(event: UpstreamEvent): string | undefined {
  const error = event.error;
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function sendUpstream(upstream: WebSocket, event: Record<string, unknown>): void {
  if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(event));
}
