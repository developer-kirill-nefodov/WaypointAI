import type { ToolDefinition } from "../llm/ollama.provider.js";

export const ROUTE_PLACES_TOOL = "route_places";

/** The model only asks for the route; the backend takes the places of the conversation's latest place search. */
export const routePlacesToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: ROUTE_PLACES_TOOL,
    description: "Build a driving route through the places the latest search_places of this conversation found, and show it on the map as a plan. Use when the user asks for a route through these, the found, or the listed places. Takes no arguments.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
};

/** The tool takes no arguments; a small model may still send an empty string, null, or an empty object. */
export function routePlacesArgsValid(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === "") return true;
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0;
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
