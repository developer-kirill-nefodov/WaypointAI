import { z } from "zod";
import { searchPlacesArgs, PLACE_KINDS } from "../tools/assistant-tools.js";
import { planTripArgsSchema } from "../tools/plan-trip.js";
import { normalizeToolArguments, searchEventsArgsSchema } from "../tools/search-events.js";

/**
 * The router picks the first tool call from a short prompt and answers with JSON only. It replaces the first step
 * of a turn, where the full system prompt and every tool definition (several thousand tokens) made each step take
 * seconds of prompt reading. A small model fine-tuned on this exact format (model/training) can serve as the router;
 * its output is validated with the same schemas as the tool calls of the full prompt.
 */
export const ROUTER_TOOLS = ["search_places", "search_events", "plan_trip", "list_sources", "reply"] as const;
export type RouterTool = typeof ROUTER_TOOLS[number];

const kinds = Object.keys(PLACE_KINDS).join(", ");

export const ROUTER_SYSTEM_PROMPT = `Pick one tool for the user's message and answer with JSON only: {"tool": "...", "args": {...}}.
Tools:
- search_places {kind, city?, query?}: places or sights. kind is one of ${kinds}; any when the user names one place, with its name in query. city is the city.
- search_events {place?, nearSelection?, radiusKm?, hours?, minMagnitude?, maxMagnitude?}: earthquakes. place is a town; omit it for a country or region. nearSelection for "here" or "this point". hours: 24 = a day, 72 = 3 days, 168 = a week, 720 = a month.
- plan_trip {cities: [{name, days?}], totalDays?, routeMode?}: a trip plan. routeMode driving or none, only if the user said so.
- list_sources {}: which data, sources, licences.
- reply {}: greetings, thanks, what the app can do, and anything no tool serves.
Write every city and town in its local spelling (Roma, Warszawa, Kraków, Firenze, București, Wien, München). Include only arguments the user stated. Never add coordinates.`;

/**
 * Plain JSON mode rather than a JSON schema: Ollama turns a schema into a grammar with the properties in alphabetical
 * order, so "args" came before "tool" and a model fine-tuned on {"tool", "args"} wrote garbled arguments. The schemas
 * below check every answer anyway.
 */
export const ROUTER_FORMAT = "json";

const ARGUMENTS: Record<RouterTool, z.ZodTypeAny> = {
  search_places: searchPlacesArgs,
  search_events: searchEventsArgsSchema,
  plan_trip: planTripArgsSchema,
  list_sources: z.object({}).strict(),
  // A reply needs no arguments; anything a model adds (such as a ready answer) is dropped.
  reply: z.object({}).passthrough().transform(() => ({})),
};

export type RouterDecision = { ok: true; tool: RouterTool; args: Record<string, unknown> } | { ok: false; error: "invalid_json" | "unknown_tool" | "invalid_args"; raw: string };

/** Parses and validates the router's JSON; nothing it says is used unless the tool's own schema accepts it. */
export function parseRouterOutput(raw: string): RouterDecision {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid_json", raw: raw.slice(0, 300) };
  }
  const tool = (value as { tool?: unknown } | null)?.tool;
  if (typeof tool !== "string" || !(ROUTER_TOOLS as readonly string[]).includes(tool)) return { ok: false, error: "unknown_tool", raw: raw.slice(0, 300) };
  const args = normalizeToolArguments((value as { args?: unknown }).args ?? {});
  const parsed = ARGUMENTS[tool as RouterTool].safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: "invalid_args", raw: raw.slice(0, 300) };
  return { ok: true, tool: tool as RouterTool, args: parsed.data as Record<string, unknown> };
}

/** The chat messages of one router call; training examples use the same messages plus the expected answer. */
export function routerMessages(message: string, hasSelection = false): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: `${ROUTER_SYSTEM_PROMPT}${hasSelection ? "\nThe user has selected a point on the map." : ""}` },
    { role: "user", content: message },
  ];
}
