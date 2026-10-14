import { z } from "zod";
import type { ToolDefinition } from "../llm/ollama.provider.js";

export const PLAN_TRIP_TOOL = "plan_trip";
export const MAX_TRIP_CITIES = 5;
export const MAX_TRIP_DAYS = 7;

const days = z.coerce.number().int().min(1).max(MAX_TRIP_DAYS);

export const planTripArgsSchema = z.object({
  cities: z.array(z.object({ name: z.string().trim().min(1).max(100), days: days.optional() }).strict()).min(1).max(MAX_TRIP_CITIES),
  totalDays: days.optional(),
  routeMode: z.enum(["driving", "none"]).optional(),
  airportCode: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((code) => code.toUpperCase()).optional(),
}).strict();
export type PlanTripArgs = z.infer<typeof planTripArgsSchema>;

/**
 * Small models send optional fields as null and sometimes a city as a bare string; both are normalized before
 * the strict schema validates the arguments. Unknown fields are still rejected.
 */
export function parsePlanTripArgs(raw: unknown) {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return planTripArgsSchema.safeParse(value);
  const withoutNulls = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && field !== ""));
  const cities = Array.isArray(withoutNulls.cities)
    ? withoutNulls.cities.map((city: unknown) => typeof city === "string"
      ? { name: city }
      : city && typeof city === "object" ? Object.fromEntries(Object.entries(city).filter(([, field]) => field !== null && field !== "")) : city)
    : withoutNulls.cities;
  return planTripArgsSchema.safeParse({ ...withoutNulls, cities });
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** The model only names cities, days, and the travel mode; the backend resolves cities and picks every stop. */
export const planTripToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: PLAN_TRIP_TOOL,
    description: "Create a new trip plan for one or more cities and show it on the map. Cities in local spelling, in visiting order. totalDays is the whole stay. Omit routeMode unless the user chose a driving route or places only. The backend picks all stops.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["cities"],
      properties: {
        cities: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TRIP_CITIES,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string", maxLength: 100 },
              days: { type: "integer", minimum: 1, maximum: MAX_TRIP_DAYS, description: "Only if the user gave days for this city." },
            },
          },
        },
        totalDays: { type: "integer", minimum: 1, maximum: MAX_TRIP_DAYS },
        routeMode: { type: "string", enum: ["driving", "none"] },
        airportCode: { type: "string", description: "IATA code if the trip starts near an airport." },
      },
    },
  },
};
