import { z } from "zod";
import { SEARCH_LIMITS } from "../config/search-limits.js";
import type { ToolDefinition } from "../llm/ollama.provider.js";

export const SEARCH_EVENTS_TOOL = "search_events";

const { radiusKm, hours, magnitude } = SEARCH_LIMITS;

/**
 * Model-facing arguments. The model names a place; the backend resolves coordinates from verified rows,
 * so the model never supplies latitude or longitude.
 */
export const searchEventsArgsSchema = z.object({
  place: z.string().trim().min(1).max(100).optional(),
  nearSelection: z.boolean().optional(),
  radiusKm: z.number().positive().max(radiusKm.max).optional(),
  hours: z.number().int().min(1).max(hours.max).optional(),
  minMagnitude: z.number().min(magnitude.min).max(magnitude.max).optional(),
  maxMagnitude: z.number().min(magnitude.min).max(magnitude.max).optional(),
}).strict()
  .refine((value) => !(value.place && value.nearSelection), "Use either place or nearSelection")
  .refine(
    (value) => value.minMagnitude === undefined
      || value.maxMagnitude === undefined
      || value.minMagnitude <= value.maxMagnitude,
    "minMagnitude must not exceed maxMagnitude",
  );

export type SearchEventsArgs = z.infer<typeof searchEventsArgsSchema>;

export const searchEventsToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: SEARCH_EVENTS_TOOL,
    description: "Search imported earthquakes (INGV and USGS, merged and cross-checked) by place, radius, period, and magnitude. Every argument is optional; omit what the user did not ask for. Without place or nearSelection it searches the whole imported area.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        place: {
          type: "string",
          maxLength: 100,
          description: "Settlement name to search around, in the local official spelling used by OpenStreetMap "
            + "(for example Roma, Napoli, Firenze).",
        },
        nearSelection: {
          type: "boolean",
          description: "True when the user refers to the selected event or point, such as 'here' or 'this location'.",
        },
        radiusKm: {
          type: "number",
          minimum: 1,
          maximum: radiusKm.max,
          description: "Search radius in kilometers around the place or selection.",
        },
        hours: {
          type: "integer",
          minimum: 1,
          maximum: hours.max,
          description: "Look back this many hours from now. 24 = last day, 168 = last week.",
        },
        minMagnitude: { type: "number", minimum: magnitude.min, maximum: magnitude.max },
        maxMagnitude: { type: "number", minimum: magnitude.min, maximum: magnitude.max },
      },
    },
  },
};

/** Ollama returns arguments as an object; some models send a JSON string instead. */
export function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Parses raw tool arguments: JSON strings are decoded and nulls for omitted optional fields are dropped. */
export function normalizeToolArguments(raw: unknown): unknown {
  const value = parseToolArguments(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // Small models sometimes send null for omitted optional fields.
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}
