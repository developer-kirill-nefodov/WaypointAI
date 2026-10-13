/**
 * Central TypeScript mirror of contracts/websocket.schema.json.
 * Backend validates actual frames against that JSON Schema with Ajv.
 * Update both in the same change when the wire protocol changes.
 */
import type { SyncSummary } from "./investigation.js";
export type AssistantStatus = "ready" | "model_unavailable" | "data_unavailable" | "starting";
export type ToolName = "search_records" | "get_record_details" | "search_places" | "list_sources" | "search_events";
export type Language = "en" | "ru" | "de";
export type VoiceErrorCode = "voice_disabled" | "invalid_message" | "busy" | "provider_unavailable" | "timeout" | "internal_error";

export interface Scope {
  workspaceId?: string;
  dateRange?: { from?: string; to?: string } | null;
  polygonIds?: string[];
  sourceIds?: string[];
  filters?: Record<string, unknown>;
  selectedMapItem?: { type: "place" | "record"; id: string };
  language?: Language;
}

export interface ClientBase {
  protocolVersion: 1;
  requestId: string;
}

export type ClientFrame =
  | (ClientBase & { type: "session.start" })
  | (ClientBase & { type: "turn.submit"; conversationId: string | null; message: string; scope: Scope })
  | (ClientBase & { type: "turn.cancel" })
  | (ClientBase & { type: "voice.start"; language?: Language })
  | (ClientBase & { type: "voice.audio"; audio: string })
  | (ClientBase & { type: "voice.stop" });

export interface RecordView {
  id: string;
  sourceId: string;
  observedAt: string;
  label: string;
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  attributes: Record<string, unknown>;
}

export interface SourceView {
  id: string;
  label: string;
  mode: "synthetic_local" | "public_snapshot" | "approved_live" | "client_api";
  status?: "ready" | "unavailable";
  attribution?: string | null;
  snapshotDate?: string | null;
  sourceUrl?: string | null;
  license?: string | null;
  /** REST only: latest event import run; null for snapshot sources. */
  lastSync?: SyncSummary | null;
}

/** Radius applied by the search_events tool; the map draws it as a circle. */
export interface SearchArea {
  lat: number;
  lon: number;
  radiusKm: number;
  /** Settlement name or selected item label used as the center. */
  label: string;
}

export interface PlaceView {
  id: string;
  sourceId: string;
  name: string;
  category: string | null;
  countryCode: string | null;
  city: string | null;
  street: string | null;
  houseNumber: string | null;
  postcode: string | null;
  details?: Record<string, string>;
  lat: number;
  lon: number;
}

export interface TripPlan {
  status: "ready" | "partial";
  countryCode: string;
  city: string;
  totalDays: number;
  supportedDays: number;
  travelMode: "driving" | "none";
  airport: { placeId: string; code: string; name: string; lat: number; lon: number } | null;
  days: Array<{
    day: number;
    area: "airport_radius" | "city";
    stopPlaceIds: string[];
    straightLineDistanceMetersFromAirport: Record<string, number>;
    routeStatus: "pending" | "not_requested" | "unavailable";
  }>;
  sourceIds: string[];
}

export type ServerFrame =
  | (ClientBase & { type: "session.ready"; connectionId: string; assistantStatus: AssistantStatus; modelLabel: string | null; demoMode: boolean; supportedFilters: string[]; voiceInput?: boolean })
  | (ClientBase & { type: "turn.accepted"; conversationId: string })
  | (ClientBase & { type: "turn.status"; phase: "understanding" | "searching" | "composing"; label: string })
  | (ClientBase & { type: "tool.started"; tool: ToolName; label: string })
  | (ClientBase & { type: "tool.completed"; tool: ToolName; recordsFound: number })
  | (ClientBase & { type: "assistant.delta"; text: string })
  | (ClientBase & { type: "turn.clarification"; conversationId: string; message: string; choices: Array<{ id: string; label: string }> })
  | (ClientBase & { type: "turn.completed"; conversationId: string; assistantMessage: string; appliedFilters: Array<Record<string, unknown>>; result: { total: number; records: RecordView[]; places?: PlaceView[]; tripPlan?: TripPlan; searchArea?: SearchArea; mapFeatures: GeoJSON.FeatureCollection }; sources: SourceView[] })
  | (ClientBase & { type: "turn.cancelled" })
  | (ClientBase & { type: "turn.error"; code: string; message: string; retryable: boolean })
  | (ClientBase & { type: "voice.ready" })
  | (ClientBase & { type: "voice.transcript.delta"; text: string })
  | (ClientBase & { type: "voice.transcript.completed"; text: string })
  | (ClientBase & { type: "voice.stopped" })
  | (ClientBase & { type: "voice.error"; code: VoiceErrorCode; message: string; retryable: boolean });
