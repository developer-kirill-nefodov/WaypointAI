import { z } from "zod";
import { SEARCH_LIMITS } from "../../config/search-limits.js";

// FDSN times are UTC. INGV omits the timezone suffix, so the suffix is optional here and added during parsing.
const FDSN_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z?$/;

export const ingvFeatureSchema = z.object({
  type: z.literal("Feature"),
  properties: z.object({
    eventId: z.number().int().positive(),
    originId: z.number().int().nullish(),
    time: z.string().regex(FDSN_TIME),
    author: z.string().max(120).nullish(),
    magType: z.string().max(20).nullish(),
    mag: z.number().finite().min(SEARCH_LIMITS.magnitude.min).max(SEARCH_LIMITS.magnitude.max).nullish(),
    type: z.string().min(1).max(60),
    place: z.string().max(300).nullish(),
    version: z.number().int().nullish(),
  }).passthrough(),
  geometry: z.object({
    type: z.literal("Point"),
    coordinates: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]).rest(z.number().finite().nullable()),
  }),
});

export const ingvCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.unknown()),
});

export type IngvFeature = z.infer<typeof ingvFeatureSchema>;

/** Parses an FDSN timestamp as UTC; JavaScript would treat a suffix-less ISO time as local time. */
export function parseFdsnTime(value: string): Date | null {
  if (!FDSN_TIME.test(value)) return null;
  const [base, fraction = ""] = value.replace(/Z$/, "").split(".");
  const milliseconds = fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : "";
  const date = new Date(`${base}${milliseconds}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** FDSN query parameter format: UTC without suffix, second precision. */
export function formatFdsnTime(date: Date): string {
  return date.toISOString().slice(0, 19);
}
