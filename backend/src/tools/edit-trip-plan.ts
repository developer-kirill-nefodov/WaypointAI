import type { ToolDefinition } from "../llm/ollama.provider.js";
import { TRIP_STOP_CATEGORIES } from "../assistant/trip-plan-edit.js";

export const EDIT_TRIP_PLAN_TOOL = "edit_trip_plan";

const dayNumber = { type: "integer", minimum: 1, maximum: 7 };
const stopCategory = { type: "string", enum: Object.keys(TRIP_STOP_CATEGORIES) };

/**
 * Model-facing definition: one flat operation per call (small models fill a flat object more reliably than an
 * array of operations); several calls in one turn apply in order. The model only names the operation, days,
 * categories, and existing stops; the backend picks every new stop from the local database.
 */
export const editTripPlanToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: EDIT_TRIP_PLAN_TOOL,
    description: "Change the trip plan shown on the map with one operation; call it again for each further change. Name an existing stop by its ref from the current plan (\"1.2\" = day 1, stop 2) or its exact name. The backend picks every new stop.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["op"],
      properties: {
        op: {
          type: "string",
          enum: ["add_stops", "remove_stops", "move_stop", "add_day", "remove_day", "set_days", "replace_day", "set_route_mode"],
          description: "add_stops {day, count?, category?}; remove_stops {stops}; move_stop {stop, toDay}; add_day {category?}; remove_day {day}; set_days {totalDays}; replace_day {day, category?}; set_route_mode {mode}.",
        },
        day: dayNumber,
        count: { type: "integer", minimum: 1, maximum: 5 },
        category: stopCategory,
        stops: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
        stop: { type: "string" },
        toDay: dayNumber,
        totalDays: dayNumber,
        mode: { type: "string", enum: ["driving", "none"] },
      },
    },
  },
};
