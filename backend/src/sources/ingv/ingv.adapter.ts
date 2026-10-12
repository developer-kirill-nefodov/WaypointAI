import { createHash } from "node:crypto";
import { fetchWithRetry } from "../http.js";
import {
  SourceFetchError,
  type EventFetchResult,
  type EventSourceAdapter,
  type NormalizedEvent,
  type TimeWindow,
} from "../source-adapter.js";
import type { Bbox } from "../../services/geometry.js";
import {
  formatFdsnTime,
  ingvCollectionSchema,
  ingvFeatureSchema,
  parseFdsnTime,
  type IngvFeature,
} from "./ingv.schema.js";

export const INGV_SOURCE_ID = "ingv-fdsn";
export const INGV_MAX_EVENTS_PER_REQUEST = 20_000;

export interface IngvAdapterOptions {
  baseUrl: string;
  bbox: Bbox;
  timeoutMs: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxEventsPerRequest?: number;
}

export function createIngvAdapter(options: IngvAdapterOptions): EventSourceAdapter {
  const maxEvents = options.maxEventsPerRequest ?? INGV_MAX_EVENTS_PER_REQUEST;
  return {
    descriptor: {
      id: INGV_SOURCE_ID,
      label: "INGV earthquake catalogue (FDSN event service)",
      mode: "approved_live",
      license: "CC-BY-4.0",
      attribution: "Earthquake data: INGV – Istituto Nazionale di Geofisica e Vulcanologia, CC BY 4.0",
      sourceUrl: "https://terremoti.ingv.it/en",
    },
    async fetchEvents(window: TimeWindow, signal?: AbortSignal): Promise<EventFetchResult> {
      const url = buildIngvQueryUrl(options.baseUrl, window, options.bbox, maxEvents);
      const response = await fetchWithRetry(url, {
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
        signal,
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
      });
      // FDSN services answer 204 when nothing matches.
      if (response.status === 204) return { events: [], skipped: 0, truncated: false };
      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new SourceFetchError("upstream_malformed", false);
      }
      return normalizeIngvPayload(payload, maxEvents);
    },
  };
}

export function buildIngvQueryUrl(baseUrl: string, window: TimeWindow, bbox: Bbox, limit: number): URL {
  const url = new URL(baseUrl);
  const [minLon, minLat, maxLon, maxLat] = bbox;
  url.searchParams.set("format", "geojson");
  url.searchParams.set("starttime", formatFdsnTime(window.start));
  url.searchParams.set("endtime", formatFdsnTime(window.end));
  url.searchParams.set("minlat", String(minLat));
  url.searchParams.set("maxlat", String(maxLat));
  url.searchParams.set("minlon", String(minLon));
  url.searchParams.set("maxlon", String(maxLon));
  url.searchParams.set("orderby", "time");
  url.searchParams.set("limit", String(limit));
  return url;
}

export function normalizeIngvPayload(payload: unknown, maxEvents = INGV_MAX_EVENTS_PER_REQUEST): EventFetchResult {
  const collection = ingvCollectionSchema.safeParse(payload);
  if (!collection.success) throw new SourceFetchError("upstream_malformed", false);
  const events: NormalizedEvent[] = [];
  let skipped = 0;
  for (const feature of collection.data.features) {
    const parsed = ingvFeatureSchema.safeParse(feature);
    const event = parsed.success ? normalizeIngvFeature(parsed.data) : null;
    if (event) events.push(event);
    else skipped += 1;
  }
  return { events, skipped, truncated: collection.data.features.length >= maxEvents };
}

export function normalizeIngvFeature(feature: IngvFeature): NormalizedEvent | null {
  const { properties } = feature;
  const observedAt = parseFdsnTime(properties.time);
  if (!observedAt) return null;
  const [lon, lat, depth] = feature.geometry.coordinates;
  const revision = properties.originId === null || properties.originId === undefined
    ? contentRevision(feature)
    : `${properties.originId}:${properties.version ?? 0}`;
  return {
    externalId: String(properties.eventId),
    observedAt,
    lat,
    lon,
    category: `seismic:${properties.type.trim().toLowerCase().replace(/\s+/g, "_")}`.slice(0, 120),
    revision,
    attributes: {
      label: properties.place?.trim()
        ? `M${properties.mag ?? "?"} · ${properties.place.trim()}`.slice(0, 200)
        : null,
      magnitude: properties.mag ?? null,
      magnitudeType: properties.magType?.trim() || null,
      depthKm: typeof depth === "number" ? depth : null,
      placeDescription: properties.place?.trim().slice(0, 200) || null,
      author: properties.author?.trim() || null,
      // Built from the numeric ID only; never from upstream text.
      sourceEventUrl: `https://terremoti.ingv.it/en/event/${properties.eventId}`,
    },
  };
}

/** Without an origin ID, a content hash still lets a corrected event replace the stored one. */
function contentRevision(feature: IngvFeature): string {
  const { properties } = feature;
  const [lon, lat, depth] = feature.geometry.coordinates;
  const content = JSON.stringify([
    properties.time,
    lat,
    lon,
    depth ?? null,
    properties.mag ?? null,
    properties.place ?? null,
  ]);
  return `h:${createHash("sha1").update(content).digest("hex").slice(0, 16)}`;
}
