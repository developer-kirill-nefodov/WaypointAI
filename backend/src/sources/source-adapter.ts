/** Source-independent shape of one imported event, produced by an adapter after validation. */
export interface NormalizedEvent {
  externalId: string;
  observedAt: Date;
  lat: number;
  lon: number;
  category: string;
  /** Changes when the source revises the event; null when the source has no revision marker. */
  revision: string | null;
  attributes: Record<string, string | number | null>;
}

export interface EventSourceDescriptor {
  id: string;
  label: string;
  mode: "synthetic_local" | "approved_live";
  license: string;
  attribution: string;
  sourceUrl: string | null;
}

export interface TimeWindow {
  start: Date;
  end: Date;
}

export interface EventFetchResult {
  events: NormalizedEvent[];
  /** Features that failed validation and were not imported. */
  skipped: number;
  /** True when the source returned its maximum page size, so events may be missing. */
  truncated: boolean;
}

export interface EventSourceAdapter {
  descriptor: EventSourceDescriptor;
  fetchEvents(window: TimeWindow, signal?: AbortSignal): Promise<EventFetchResult>;
}

export type SourceErrorCode =
  | "upstream_bad_request"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "upstream_malformed"
  /** A download larger than the configured limit. */
  | "file_too_large";

/** Upstream failure with a stable code; the message never contains response bodies or credentials. */
export class SourceFetchError extends Error {
  constructor(readonly code: SourceErrorCode, readonly retryable: boolean) {
    super(code);
    this.name = "SourceFetchError";
  }
}
