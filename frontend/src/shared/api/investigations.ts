import type {
  AppliedEventFilters,
  EventDetailsResponse,
  EventSearchResponse,
  QueryInterpretation,
} from "@waypoint-ai/shared";
import { apiBase } from "./client";

/** Error with the server's stable error code, or "network_error" when the server was unreachable. */
export class InvestigationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly interpretation: QueryInterpretation | null = null,
    readonly fallbackReason: string | null = null,
  ) {
    super(code);
  }
}

/** Stable error code for any failure from this module; unexpected errors map to "http_error". */
export function errorCode(error: unknown): string {
  return error instanceof InvestigationApiError ? error.code : "http_error";
}

export type EventQuery = {
  days: number;
  minMagnitude: number | null;
  sourceIds: string[];
  near: { lat: number; lon: number; radiusKm: number } | null;
  limit: number;
  cursor?: string | null;
};

export function eventQueryParams(query: EventQuery, now = new Date()): URLSearchParams {
  const params = new URLSearchParams();
  params.set("from", new Date(now.getTime() - query.days * 86_400_000).toISOString());
  params.set("to", now.toISOString());
  params.set("limit", String(query.limit));
  if (query.minMagnitude !== null) params.set("minMagnitude", String(query.minMagnitude));
  if (query.sourceIds.length) params.set("sourceIds", query.sourceIds.join(","));
  if (query.near) {
    params.set("lat", query.near.lat.toFixed(5));
    params.set("lon", query.near.lon.toFixed(5));
    params.set("radiusKm", String(query.near.radiusKm));
  }
  if (query.cursor) params.set("cursor", query.cursor);
  return params;
}

export async function searchEvents(params: URLSearchParams, signal?: AbortSignal): Promise<EventSearchResponse> {
  return getJson(`/api/v1/investigations/events?${params}`, signal);
}

export async function loadEventDetails(id: string, signal?: AbortSignal): Promise<EventDetailsResponse> {
  return getJson(`/api/v1/investigations/events/${encodeURIComponent(id)}`, signal);
}

/** Rebuilds GET parameters from the filters the server applied, so "Show more" continues the same search. */
export function paramsFromAppliedFilters(filters: AppliedEventFilters): URLSearchParams {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    limit: String(filters.limit),
  });
  if (filters.near) {
    params.set("lat", String(filters.near.lat));
    params.set("lon", String(filters.near.lon));
    params.set("radiusKm", String(filters.near.radiusKm));
  }
  if (filters.bbox) params.set("bbox", filters.bbox.join(","));
  if (filters.minMagnitude !== undefined) params.set("minMagnitude", String(filters.minMagnitude));
  if (filters.maxMagnitude !== undefined) params.set("maxMagnitude", String(filters.maxMagnitude));
  if (filters.sourceIds?.length) params.set("sourceIds", filters.sourceIds.join(","));
  if (filters.category) params.set("category", filters.category);
  return params;
}

async function getJson<T>(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, { ...init, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new InvestigationApiError(0, "network_error");
  }
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<T>;
}

async function apiError(response: Response): Promise<InvestigationApiError> {
  const body: unknown = await response.json().catch(() => null);
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const code = typeof record.error === "string" ? record.error : "http_error";
  const interpretation = record.interpretation && typeof record.interpretation === "object"
    ? record.interpretation as QueryInterpretation
    : null;
  const fallbackReason = typeof record.fallbackReason === "string" ? record.fallbackReason : null;
  return new InvestigationApiError(response.status, code, interpretation, fallbackReason);
}
