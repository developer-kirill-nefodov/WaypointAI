import type { AppliedEventFilters, InvestigationQueryResponse, QueryInterpretation } from "@waypoint-ai/shared";

/** A point the user asked to see on the map: the event itself or one of its linked places. */
export type MapFocusTarget = {
  kind: "record" | "place";
  id: string;
  lat: number;
  lon: number;
};

/** The revision changes on every request, so the map re-centers even on the same point. */
export type MapFocus = MapFocusTarget & {
  revision: number;
};

/** Radius filter around a point, labelled with what the user picked it from. */
export type NearFilter = {
  lat: number;
  lon: number;
  radiusKm: number;
  label: string;
};

export type EventFilterState = {
  days: number;
  minMagnitude: number | null;
  sourceIds: string[];
  near: NearFilter | null;
};

/** A failed natural-language query, with the place the interpreter extracted when there was one. */
export type QueryErrorState = {
  code: string;
  place?: string;
  fallbackReason?: string;
};

/** A completed natural-language query: what was asked, how it was read, and what the server applied. */
export type QueryResultInfo = {
  text: string;
  interpretation: QueryInterpretation;
  resolvedPlace: InvestigationQueryResponse["resolvedPlace"];
  appliedFilters: AppliedEventFilters;
  durationMs: number;
};
