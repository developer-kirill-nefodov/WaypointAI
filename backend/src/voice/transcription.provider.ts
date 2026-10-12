import type { Language } from "@waypoint-ai/shared";

export type TranscriptionFailure = "provider_unavailable" | "timeout";

export interface TranscriptionEvents {
  onDelta(text: string): void;
  onCompleted(text: string): void;
  onFailure(failure: TranscriptionFailure): void;
}

export interface TranscriptionStream {
  /** Appends base64 PCM16 mono 24 kHz audio. */
  appendAudio(base64Audio: string): void;
  /** Commits buffered audio; the provider then emits the final transcript. */
  finish(): void;
  close(): void;
}

export interface TranscriptionOptions {
  language?: Language;
  signal: AbortSignal;
}

/** Resolves once the provider accepts audio; rejects with TranscriptionProviderError. */
export type TranscriptionProvider = (options: TranscriptionOptions, events: TranscriptionEvents) => Promise<TranscriptionStream>;

export class TranscriptionProviderError extends Error {
  constructor(readonly failure: TranscriptionFailure) {
    super(`Transcription provider failure: ${failure}`);
  }
}
