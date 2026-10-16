import { fetchWithRetry } from "../http.js";
import {
  SourceFetchError,
  type EventFetchResult,
  type EventSourceAdapter,
  type NormalizedEvent,
  type TimeWindow,
} from "../source-adapter.js";
import type { Bbox } from "../../services/geometry.js";
import { formatFdsnTime } from "../ingv/ingv.schema.js";
import { usgsCollectionSchema, usgsFeatureSchema, type UsgsFeature } from "./usgs.schema.js";

export const USGS_SOURCE_ID = "usgs-fdsn";
export const USGS_MAX_EVENTS_PER_REQUEST = 20_000;

export interface UsgsAdapterOptions {
  baseUrl: string;
  bbox: Bbox;
  timeoutMs: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxEventsPerRequest?: number;
}

/**
 * USGS FDSN event service: a second, independent catalogue used to cross-check INGV events. It is global and public
 * domain, but in Europe it lists few events below about M2.5, so a missing USGS match for a small event is expected.
 */
export function createUsgsAdapter(options: UsgsAdapterOptions): EventSourceAdapter {
  const maxEvents = options.maxEventsPerRequest ?? USGS_MAX_EVENTS_PER_REQUEST;
  return {
    descriptor: {
      id: USGS_SOURCE_ID,
      label: "USGS earthquake catalogue (FDSN event service)",
      mode: "approved_live",
      license: "Public domain (U.S. Government work)",
      attribution: "Earthquake data: U.S. Geological Survey",
      sourceUrl: "https://earthquake.usgs.gov/earthquakes/search/",
    },
    async fetchEvents(window: TimeWindow, signal?: AbortSignal): Promise<EventFetchResult> {
      const url = buildUsgsQueryUrl(options.baseUrl, window, options.bbox, maxEvents);
      const response = await fetchWithRetry(url, {
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
        signal,
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
      });
      // USGS answers an empty match with an empty collection; 204 is accepted as well.
      if (response.status === 204) return { events: [], skipped: 0, truncated: false };
      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new SourceFetchError("upstream_malformed", false);
      }
      return normalizeUsgsPayload(payload, maxEvents);
    },
  };
}

export function buildUsgsQueryUrl(baseUrl: string, window: TimeWindow, bbox: Bbox, limit: number): URL {
  const url = new URL(baseUrl);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  url.searchParams.set("format", "geojson");
  url.searchParams.set("starttime", formatFdsnTime(window.start));
  url.searchParams.set("endtime", formatFdsnTime(window.end));
  url.searchParams.set("minlatitude", String(minLat));
  url.searchParams.set("maxlatitude", String(maxLat));
  url.searchParams.set("minlongitude", String(minLon));
  url.searchParams.set("maxlongitude", String(maxLon));
  url.searchParams.set("orderby", "time");
  url.searchParams.set("limit", String(limit));
  return url;
}

export function normalizeUsgsPayload(payload: unknown, maxEvents = USGS_MAX_EVENTS_PER_REQUEST): EventFetchResult {
  const collection = usgsCollectionSchema.safeParse(payload);
  if (!collection.success) throw new SourceFetchError("upstream_malformed", false);
  const events: NormalizedEvent[] = [];
  let skipped = 0;
  for (const feature of collection.data.features) {
    const parsed = usgsFeatureSchema.safeParse(feature);
    const event = parsed.success ? normalizeUsgsFeature(parsed.data) : null;
    if (event) events.push(event);
    else skipped += 1;
  }
  return { events, skipped, truncated: collection.data.features.length >= maxEvents };
}

export function normalizeUsgsFeature(feature: UsgsFeature): NormalizedEvent | null {
  const { properties } = feature;
  const observedAt = new Date(properties.time);
  if (Number.isNaN(observedAt.getTime())) return null;
  const [lon, lat, depth] = feature.geometry.coordinates;
  const place = properties.place?.trim().slice(0, 200) || null;
  return {
    externalId: feature.id,
    observedAt,
    lat,
    lon,
    category: `seismic:${properties.type.trim().toLowerCase().replace(/\s+/g, "_")}`.slice(0, 120),
    // USGS has an update time, so a revised event replaces the stored one.
    revision: `u:${properties.updated ?? properties.time}`,
    attributes: {
      label: place ? `M${properties.mag ?? "?"} · ${place}`.slice(0, 200) : null,
      magnitude: properties.mag ?? null,
      magnitudeType: properties.magType?.trim() || null,
      depthKm: typeof depth === "number" ? depth : null,
      placeDescription: place,
      author: properties.net?.trim() || null,
      reviewStatus: properties.status?.trim() || null,
      // Built from the validated ID only; never from upstream text.
      sourceEventUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${feature.id}`,
    },
  };
}
