import type { ClientFrame, ServerFrame, VoiceErrorCode } from "@waypoint-ai/shared";
import {
  TranscriptionProviderError,
  type TranscriptionFailure,
  type TranscriptionProvider,
  type TranscriptionStream,
} from "./transcription.provider.js";

type VoiceClientFrame = Extract<ClientFrame, { type: "voice.start" | "voice.audio" | "voice.stop" }>;
type VoiceServerFrame = Extract<ServerFrame, { type: `voice.${string}` }>;

export interface VoiceSessionConfig {
  enabled: boolean;
  maxSessionMs: number;
  /** How long to wait for the final transcript after the audio is committed. */
  finishTimeoutMs: number;
}

interface ActiveVoiceSession {
  requestId: string;
  phase: "connecting" | "streaming" | "finishing";
  controller: AbortController;
  stream?: TranscriptionStream;
  maxTimer?: NodeJS.Timeout;
  finishTimer?: NodeJS.Timeout;
  audioCharacters: number;
  startedAt: number;
}

// Base64 PCM16 mono 24 kHz is 64,000 characters per second; allow headroom for chunk jitter.
const BASE64_CHARACTERS_PER_SECOND = 64_000;
const AUDIO_ALLOWANCE = 1.25;
const MAX_TRANSCRIPT_LENGTH = 4000;

const ERROR_MESSAGES: Record<VoiceErrorCode, string> = {
  voice_disabled: "Voice input is not enabled on this server.",
  invalid_message: "The audio stream could not be accepted.",
  busy: "A voice recording is already active in this connection.",
  provider_unavailable: "Speech recognition is temporarily unavailable.",
  timeout: "Speech recognition did not respond in time.",
  internal_error: "Speech recognition failed unexpectedly.",
};

export function isVoiceFrame(frame: ClientFrame): frame is VoiceClientFrame {
  return frame.type === "voice.start" || frame.type === "voice.audio" || frame.type === "voice.stop";
}

/** Owns at most one voice session for one assistant WebSocket connection. */
export class VoiceSessionManager {
  #session: ActiveVoiceSession | undefined;

  constructor(
    private readonly config: VoiceSessionConfig,
    private readonly provider: TranscriptionProvider,
    private readonly send: (frame: VoiceServerFrame) => void,
  ) {}

  get activeRequestId(): string | undefined {
    return this.#session?.requestId;
  }

  handle(frame: VoiceClientFrame): void {
    if (frame.type === "voice.start") void this.#start(frame);
    else if (frame.type === "voice.audio") this.#append(frame);
    else this.#stop(frame.requestId);
  }

  dispose(): void {
    if (this.#session) this.#end(this.#session, "disconnected");
  }

  async #start(frame: Extract<VoiceClientFrame, { type: "voice.start" }>): Promise<void> {
    if (!this.config.enabled) {
      this.#sendError(frame.requestId, "voice_disabled", false);
      return;
    }
    if (this.#session) {
      this.#sendError(frame.requestId, "busy", true);
      return;
    }
    const session: ActiveVoiceSession = {
      requestId: frame.requestId,
      phase: "connecting",
      controller: new AbortController(),
      audioCharacters: 0,
      startedAt: Date.now(),
    };
    this.#session = session;

    let stream: TranscriptionStream;
    try {
      stream = await this.provider(
        { language: frame.language, signal: session.controller.signal },
        {
          onDelta: (text) => this.#onDelta(session, text),
          onCompleted: (text) => this.#onCompleted(session, text),
          onFailure: (failure) => this.#onFailure(session, failure),
        },
      );
    } catch (error) {
      if (this.#session !== session) return;
      const failure: TranscriptionFailure = error instanceof TranscriptionProviderError ? error.failure : "provider_unavailable";
      this.#end(session, failure);
      return;
    }

    if (this.#session !== session) {
      stream.close();
      return;
    }
    session.stream = stream;
    session.phase = "streaming";
    session.maxTimer = setTimeout(() => this.#stop(session.requestId), this.config.maxSessionMs);
    this.send({ protocolVersion: 1, type: "voice.ready", requestId: session.requestId });
  }

  #append(frame: Extract<VoiceClientFrame, { type: "voice.audio" }>): void {
    const session = this.#session;
    if (!session || session.requestId !== frame.requestId || session.phase !== "streaming") return;
    session.audioCharacters += frame.audio.length;
    const allowedCharacters = (this.config.maxSessionMs / 1000) * BASE64_CHARACTERS_PER_SECOND * AUDIO_ALLOWANCE;
    if (session.audioCharacters > allowedCharacters) {
      this.#end(session, "invalid_message");
      return;
    }
    session.stream?.appendAudio(frame.audio);
  }

  #stop(requestId: string): void {
    const session = this.#session;
    if (!session || session.requestId !== requestId) return;
    if (session.phase === "connecting") {
      this.#end(session, "stopped");
      return;
    }
    if (session.phase === "finishing") return;
    session.phase = "finishing";
    clearTimeout(session.maxTimer);
    session.finishTimer = setTimeout(() => this.#end(session, "stopped"), this.config.finishTimeoutMs);
    session.stream?.finish();
  }

  #onDelta(session: ActiveVoiceSession, text: string): void {
    if (this.#session !== session || !text) return;
    this.send({ protocolVersion: 1, type: "voice.transcript.delta", requestId: session.requestId, text: text.slice(0, MAX_TRANSCRIPT_LENGTH) });
  }

  #onCompleted(session: ActiveVoiceSession, text: string): void {
    if (this.#session !== session) return;
    const transcript = text.trim();
    if (transcript) {
      this.send({ protocolVersion: 1, type: "voice.transcript.completed", requestId: session.requestId, text: transcript.slice(0, MAX_TRANSCRIPT_LENGTH) });
    }
    if (session.phase === "finishing") this.#end(session, "stopped");
  }

  #onFailure(session: ActiveVoiceSession, failure: TranscriptionFailure): void {
    if (this.#session === session) this.#end(session, failure);
  }

  #end(session: ActiveVoiceSession, outcome: "stopped" | "disconnected" | TranscriptionFailure | "invalid_message"): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    clearTimeout(session.maxTimer);
    clearTimeout(session.finishTimer);
    session.controller.abort();
    session.stream?.close();

    if (outcome === "stopped") this.send({ protocolVersion: 1, type: "voice.stopped", requestId: session.requestId });
    else if (outcome !== "disconnected") this.#sendError(session.requestId, outcome, outcome !== "invalid_message");

    // Diagnostics include timing and outcome only, never audio or transcript text.
    console.info("Voice session finished", {
      requestId: session.requestId,
      durationMs: Date.now() - session.startedAt,
      audioCharacters: session.audioCharacters,
      outcome,
    });
  }

  #sendError(requestId: string, code: VoiceErrorCode, retryable: boolean): void {
    this.send({ protocolVersion: 1, type: "voice.error", requestId, code, message: ERROR_MESSAGES[code], retryable });
  }
}
