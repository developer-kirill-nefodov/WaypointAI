/**
 * Central TypeScript mirror of contracts/websocket.schema.json.
 * Backend validates actual frames against that JSON Schema with Ajv.
 * Update both in the same change when the wire protocol changes.
 */
import type { SyncSummary } from "./investigation.js";
export type AssistantStatus = "ready" | "model_unavailable" | "data_unavailable" | "starting";
export type ToolName = "search_records" | "get_record_details" | "search_places" | "list_sources" | "search_events" | "plan_trip" | "edit_trip_plan";
export type Language = "en" | "ru" | "de";
export type VoiceErrorCode = "voice_disabled" | "invalid_message" | "busy" | "rate_limited" | "provider_unavailable" | "timeout" | "internal_error";

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

export type ImportJobStatus = "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type ImportSourceStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** One source of an import job, as the import dock shows it. */
export interface ImportJobSource {
  sourceId: string;
  label: string;
  status: ImportSourceStatus;
  /** 0..1 */
  progress: number;
  phase: "fetching" | "saving" | "linking" | "done" | null;
  /** Start of the day being fetched (ISO), for a phase line such as "INGV · 2026-10-08". */
  windowStart: string | null;
  /** Fetch steps done and in total (days for events, map tiles for an OSM area). */
  stepsDone: number;
  stepsTotal: number;
  fetched: number;
  inserted: number;
  updated: number;
  linkedPlaces: number;
  runId: string | null;
  errorCode: string | null;
  retryAfterSeconds: number | null;
}

/** Kinds of places an OpenStreetMap area import can load. */
export type OsmAreaCategory = "attraction" | "museum" | "gallery" | "viewpoint" | "monument" | "castle" | "church" | "theatre" | "park" | "restaurant" | "cafe" | "bar" | "hotel" | "transport";

/** What a job does: imports event sources over a period, OpenStreetMap places of an area or region, or deletes an imported dataset. */
export type ImportJobParams =
  | { kind: "events"; sourceIds: string[]; days: number }
  | { kind: "osm_area"; label: string; bbox: [number, number, number, number]; countryCode: string | null; categories: OsmAreaCategory[] }
  | { kind: "osm_region"; regionId: string; label: string; countryCode: string | null }
  | { kind: "dataset_delete"; datasetId: string; label: string };

/** An import started from the app. */
export interface ImportJob {
  id: string;
  workspaceId: string;
  status: ImportJobStatus;
  params: ImportJobParams;
  /** 0..1, the mean of the sources' progress. */
  progress: number;
  sources: ImportJobSource[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type ClientFrame =
  | (ClientBase & { type: "session.start"; workspaceId?: string })
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

/** A row an answer is based on: an event or record (ref E1, E2, …) or a place (P1, …) returned by a tool. */
export interface Citation {
  ref: string;
  entityType: "record" | "place";
  id: string;
  sourceId: string;
  label: string;
  observedAt?: string;
  /** The row's page at its source (INGV, USGS, OpenStreetMap), built from its ID; null when the source has none. */
  url: string | null;
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

/** A city of a multi-city trip, resolved to a verified OSM settlement. */
export interface TripCityView {
  name: string;
  placeId: string;
  lat: number;
  lon: number;
  countryCode: string | null;
}

export interface TripPlan {
  status: "ready" | "partial";
  countryCode: string;
  city: string;
  totalDays: number;
  supportedDays: number;
  travelMode: "driving" | "none";
  /** Present for city trips: every city in visiting order. */
  cities?: TripCityView[];
  airport: { placeId: string; code: string; name: string; lat: number; lon: number } | null;
  days: Array<{
    day: number;
    area: "airport_radius" | "city";
    /** City of this day for city trips. */
    city?: string;
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
  /** Progress of an import job of the connection's workspace; requestId is the job ID. */
  | (ClientBase & { type: "import.progress"; job: ImportJob })
  /** One line of the progress feed: the same stepId is sent as running, then done or failed. */
  | (ClientBase & { type: "turn.step"; stepId: string; label: string; state: "running" | "done" | "failed"; detail?: string })
  | (ClientBase & { type: "tool.started"; tool: ToolName; label: string })
  | (ClientBase & { type: "tool.completed"; tool: ToolName; recordsFound: number })
  | (ClientBase & { type: "assistant.delta"; text: string })
  | (ClientBase & { type: "turn.clarification"; conversationId: string; message: string; choices: Array<{ id: string; label: string }> })
  | (ClientBase & { type: "turn.completed"; conversationId: string; assistantMessage: string; appliedFilters: Array<Record<string, unknown>>; result: { total: number; records: RecordView[]; places?: PlaceView[]; tripPlan?: TripPlan; searchArea?: SearchArea; mapFeatures: GeoJSON.FeatureCollection }; sources: SourceView[]; citations?: Citation[]; citationsMode?: "cited" | "shown_to_model" })
  | (ClientBase & { type: "turn.cancelled" })
  | (ClientBase & { type: "turn.error"; code: string; message: string; retryable: boolean })
  | (ClientBase & { type: "voice.ready" })
  | (ClientBase & { type: "voice.transcript.delta"; text: string })
  | (ClientBase & { type: "voice.transcript.completed"; text: string })
  | (ClientBase & { type: "voice.stopped" })
  | (ClientBase & { type: "voice.error"; code: VoiceErrorCode; message: string; retryable: boolean });
