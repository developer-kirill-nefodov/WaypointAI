import { z } from "zod";

// OpenStreetMap services are reached only through allowlisted hosts; URLs never come from a request or the model.
const ALLOWED_OSM_HOSTS = new Set(["overpass-api.de", "nominatim.openstreetmap.org"]);

export function isAllowedOsmUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_OSM_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const osmEnvironmentSchema = z.object({
  OSM_OVERPASS_URL: z.string().url().refine(isAllowedOsmUrl, "OSM_OVERPASS_URL must be an https:// URL on an allowlisted host").default("https://overpass-api.de/api/interpreter"),
  OSM_NOMINATIM_URL: z.string().url().refine(isAllowedOsmUrl, "OSM_NOMINATIM_URL must be an https:// URL on an allowlisted host").default("https://nominatim.openstreetmap.org/search"),
  /** Largest area an Overpass import may cover, in square degrees (about a large city with its suburbs). */
  OSM_AREA_MAX_SQUARE_DEGREES: z.coerce.number().min(0.01).max(4).default(1),
  OSM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(90_000),
  /** Largest Geofabrik file a region import may download (default 1.5 GB). */
  OSM_REGION_MAX_BYTES: z.coerce.number().int().min(1_000_000).max(20_000_000_000).default(1_500_000_000),
});
