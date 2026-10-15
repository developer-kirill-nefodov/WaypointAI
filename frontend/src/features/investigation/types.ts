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
