import { z } from "zod";
import { SEARCH_LIMITS } from "../../config/search-limits.js";

/** USGS event IDs are a network code and an event code, for example `us6000u13t`. */
export const USGS_EVENT_ID = /^[a-z0-9]{2,40}$/;

export const usgsFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.string().regex(USGS_EVENT_ID),
  properties: z.object({
    // Epoch milliseconds (UTC).
    time: z.number().int().positive(),
    updated: z.number().int().positive().nullish(),
    mag: z.number().finite().min(SEARCH_LIMITS.magnitude.min).max(SEARCH_LIMITS.magnitude.max).nullish(),
    magType: z.string().max(20).nullish(),
    place: z.string().max(300).nullish(),
    type: z.string().min(1).max(60),
    status: z.string().max(20).nullish(),
    net: z.string().max(20).nullish(),
  }).passthrough(),
  geometry: z.object({
    type: z.literal("Point"),
    coordinates: z.tuple([
      z.number().min(-180).max(180),
      z.number().min(-90).max(90),
    ]).rest(z.number().finite().nullable()),
  }),
});

export const usgsCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.unknown()),
});

export type UsgsFeature = z.infer<typeof usgsFeatureSchema>;
