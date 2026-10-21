import type { ClientFrame } from "@waypoint-ai/shared";
import { EDIT_TRIP_PLAN_TOOL } from "../tools/edit-trip-plan.js";
import { PLAN_TRIP_TOOL } from "../tools/plan-trip.js";
import { REPLY_TOOL } from "../tools/reply.js";
import { SYSTEM_PROMPT } from "./prompts/system-prompt.js";

type Language = "en" | "ru" | "de";
type Scope = Extract<ClientFrame, { type: "turn.submit" }>["scope"];

const languageName = (language: Language) => (language === "ru" ? "Russian" : language === "de" ? "German" : "English");

/** The main system prompt with the imported regions, the answer language, and the turn's sources and period. */
export function systemPrompt(coverage: string, language: Language, allowedSourceIds: string[] | undefined, dateRange: Scope["dateRange"]): string {
  return `${SYSTEM_PROMPT.replace("{{PLACE_COVERAGE}}", coverage)}\nResponse language: ${languageName(language)}. Always answer in this language.\nAllowed sources: ${allowedSourceIds?.length ? allowedSourceIds.join(", ") : "all available"}. Date range: ${dateRange?.from ?? "not set"} — ${dateRange?.to ?? "not set"}.`;
}

export function selectedItemPrompt(selected: unknown): string {
  return `User-selected map object (verified from the local database; use it as the main referent for “this point” or “this place”):\n${JSON.stringify(selected)}`;
}

export function currentPlanPrompt(plan: string): string {
  return `Current trip plan shown on the map (stops from the local database). To change it, call ${EDIT_TRIP_PLAN_TOOL} once per change, naming stops by ref or name; to plan other cities from scratch, call ${PLAN_TRIP_TOOL}.\n${plan}`;
}

/** Sent after a first answer without a tool call, before the one retry. */
export function toolRequiredPrompt(hasPlan: boolean): string {
  return `Answer by calling a tool.${hasPlan ? ` If the user wants to change the current trip plan, call ${EDIT_TRIP_PLAN_TOOL}.` : ""} Use a data tool when the reply depends on places, events, records, sources, or a trip plan; call ${REPLY_TOOL} only when no data is needed. Never name places or facts that a tool did not return.`;
}

/** Prompt for writing an answer that needs no data: what the app can do, and the trip plan if one is shown. */
export function replyPrompt(language: Language, plan: string | null, coverage: string): string {
  return `You are Waypoint AI, a local map assistant. Answer the user's last message in ${languageName(language)} in at most four short sentences of plain text. Do not call or name tools and do not write code or JSON.
What the app can do: find places and sights in the local OpenStreetMap snapshots (${coverage}); build and edit multi-day trip plans with a driving route per day; search imported INGV and USGS earthquakes by place, radius, period, and magnitude, and say whether the two catalogues agree; describe the data sources.
Use only facts from this conversation${plan ? " and the trip plan below" : ""}; never name places, events, or numbers that are not there.${plan ? `\nCurrent trip plan: ${plan}` : ""}`;
}
