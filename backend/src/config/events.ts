import { z } from "zod";
import { isValidBbox } from "../services/geometry.js";

// External event sources are reached only through allowlisted hosts; the URL never comes from a request or the model.
// Each source's URL must be on that source's own host.
const EVENT_SOURCE_HOSTS = { ingv: "webservices.ingv.it", usgs: "earthquake.usgs.gov" } as const;

export function isAllowedEventSourceUrl(value: string, source: keyof typeof EVENT_SOURCE_HOSTS = "ingv"): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === EVENT_SOURCE_HOSTS[source];
  } catch {
    return false;
  }
}

const bboxSchema = z.string()
  .transform((value) => value.split(",").map(Number))
  .refine(isValidBbox, "EVENT_IMPORT_BBOX must be minLon,minLat,maxLon,maxLat");

export const eventsEnvironmentSchema = z.object({
  EVENT_SOURCE_INGV_URL: z.string().url()
    .refine(isAllowedEventSourceUrl, "EVENT_SOURCE_INGV_URL must be an https:// URL on an allowlisted host")
    .default("https://webservices.ingv.it/fdsnws/event/1/query"),
  EVENT_SOURCE_USGS_URL: z.string().url()
    .refine((value) => isAllowedEventSourceUrl(value, "usgs"), "EVENT_SOURCE_USGS_URL must be an https:// URL on earthquake.usgs.gov")
    .default("https://earthquake.usgs.gov/fdsnws/event/1/query"),
  // Default covers Italy and nearby seas, the area INGV catalogues in detail.
  EVENT_IMPORT_BBOX: bboxSchema.default("6,35,19,48"),
  EVENT_IMPORT_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(86_400).default(600),
  EVENT_IMPORT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(20_000),
  INVESTIGATION_IMPORT_ENABLED: z.preprocess(
    (value) => value === undefined || value === "" ? "false" : value,
    z.enum(["true", "false"]).transform((value) => value === "true"),
  ),
});
