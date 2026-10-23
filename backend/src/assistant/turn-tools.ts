import type { ClarificationFieldKey, ClientFrame, PlaceView, SourceView, ToolName, TripPlan } from "@waypoint-ai/shared";
import { getPlaceDetails, getRecordDetails, getSources, searchNearbyPlaces, searchPlaces } from "../data/record.repository.js";
import { EVENT_SOURCE_IDS } from "../sources/registry.js";
import { applyClarificationAnswers } from "./clarification.js";
import { resolveSettlement } from "../data/settlement.repository.js";
import { toolLabel, text } from "./copy.js";
import type { PlanTripDependencies } from "./plan-trip.js";
import { applyTripPlanEdits, parseEditTripPlanArgs, type TripStopFinder } from "./trip-plan-edit.js";

/** The map item the user selected, checked against the turn's sources and period; the model gets it as context. */
export async function resolveSelectedMapItem(selection: { type: "place" | "record"; id: string } | undefined, sourceIds: string[] | undefined, dateRange: { from?: string; to?: string } | null | undefined) {
  if (!selection) return null;
  if (selection.type === "place") {
    const place = await getPlaceDetails(selection.id);
    if (!place || (sourceIds?.length && !sourceIds.includes(place.sourceId))) return { unavailable: true, reason: "The selected place is not part of the active source scope." };
    return { type: "place", ...place };
  }
  const record = await getRecordDetails(selection.id);
  if (!record || (sourceIds?.length && !sourceIds.includes(record.sourceId))) return { unavailable: true, reason: "The selected record was not found in the active source scope." };
  const at = Date.parse(record.observedAt);
  if ((dateRange?.from && at < Date.parse(dateRange.from)) || (dateRange?.to && at > Date.parse(dateRange.to))) return { unavailable: true, reason: "The selected record is outside the active date range." };
  return { type: "record", ...record };
}

export type SelectedMapItem = Awaited<ReturnType<typeof resolveSelectedMapItem>>;

/** Center for "near this point" searches: only a verified, in-scope selected map item. */
export function selectionPoint(selected: SelectedMapItem): { lat: number; lon: number; label: string } | null {
  if (!selected || !("lat" in selected)) return null;
  return {
    lat: selected.lat,
    lon: selected.lon,
    label: "name" in selected ? selected.name : selected.label,
  };
}

/** New stops for plan edits: nearest named places of the requested kinds, widening the radius when too few are close. */
function tripStopFinder(sourceIds: string[] | undefined): TripStopFinder {
  return async ({ center, categories, count, excludeIds }) => {
    let candidates: PlaceView[] = [];
    for (const radiusMeters of [2_500, 6_000, 15_000]) {
      const results = await Promise.all(categories.map((category) => searchNearbyPlaces({ category, sourceIds, center, radiusMeters, limit: 50 })));
      const lists = results.map((result) => (result.places as PlaceView[]).filter((place) => /\p{L}/u.test(place.name) && !excludeIds.has(place.id)));
      // Interleave categories so a mixed request gets some of each.
      const merged: PlaceView[] = [];
      for (let position = 0; position < 50; position += 1) for (const list of lists) if (list[position]) merged.push(list[position]!);
      candidates = [...new Map(merged.map((place) => [place.id, place])).values()];
      if (candidates.length >= count) break;
    }
    return candidates.slice(0, count);
  };
}

export async function runTripPlanEdit(state: { plan: TripPlan; places: PlaceView[] } | null, rawArgs: unknown, sourceIds: string[] | undefined) {
  if (!state) return { ok: false as const, error: "There is no trip plan in this conversation yet. Ask which city and how many days to plan." };
  const parsed = parseEditTripPlanArgs(rawArgs);
  if (!parsed.success) return { ok: false as const, error: "Invalid edit_trip_plan arguments. Use only the documented operations and fields." };
  return applyTripPlanEdits(state.plan, state.places, parsed.data.operations, tripStopFinder(sourceIds));
}

/** Database lookups behind plan_trip: settlements, the airport row, and places around it. */
export function planTripDependencies(sourceIds: string[] | undefined): PlanTripDependencies {
  return {
    resolveSettlement,
    findAirport: async (code) => (await searchPlaces({ airportCode: code, sourceIds, limit: 1 })).places[0] as PlaceView | undefined ?? null,
    findNearAirport: async (center, radiusMeters, count) => {
      const lists = await Promise.all(["tourism:attraction", "tourism:museum"].map((category) => searchNearbyPlaces({ category, sourceIds, center, radiusMeters, limit: count })));
      const places = [...new Map(lists.flatMap((list) => list.places as PlaceView[]).filter((place) => /\p{L}/u.test(place.name)).map((place) => [place.id, place])).values()].slice(0, count);
      return { places, distancesMeters: Object.assign({}, ...lists.map((list) => list.distancesMeters)) };
    },
  };
}

/** A short progress line for a tool call, from the validated-or-not arguments; only plain values are shown. */
export function toolStepLabel(tool: ToolName, rawArgs: unknown, language: "en" | "ru" | "de"): string {
  let args: Record<string, unknown> = {};
  try { args = (typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs) as Record<string, unknown> ?? {}; } catch { args = {}; }
  const plain = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value).slice(0, 40) : null);
  const details = tool === "plan_trip" && Array.isArray(args.cities)
    ? [args.cities.map((city) => plain((city as { name?: unknown })?.name ?? city)).filter(Boolean).join(", "), args.totalDays ? text(language, `${plain(args.totalDays)} дн.`, `${plain(args.totalDays)} days`) : null]
    : tool === "edit_trip_plan"
      ? [plain(args.op), args.day ? text(language, `день ${plain(args.day)}`, `day ${plain(args.day)}`) : null, plain(args.category)]
      : [plain(args.kind), plain(args.category), plain(args.query), plain(args.city), plain(args.place), args.radiusKm ? `${plain(args.radiusKm)} km` : null];
  const summary = details.filter((value) => value && value !== "any").join(" · ");
  return summary ? `${toolLabel(tool, language)}: ${summary}` : toolLabel(tool, language);
}

type SubmitFrame = Extract<ClientFrame, { type: "turn.submit" }>;

/** The imported event catalogues, offered as a field of an earthquake clarification. */
export async function eventSources(): Promise<SourceView[]> {
  const sources = await getSources([...EVENT_SOURCE_IDS]);
  return (sources as SourceView[]).filter((source) => source.status === "ready");
}

/**
 * The turn with the answers of a clarification applied: the details in its text and chosen event sources in its
 * scope. Unknown sources and values outside the offered options are dropped.
 */
export async function applyAnswers(frame: SubmitFrame, language: "en" | "ru" | "de"): Promise<{ frame: SubmitFrame; answered: Set<ClarificationFieldKey> }> {
  if (!frame.answers?.length) return { frame, answered: new Set() };
  const requested = frame.answers.find((answer) => answer.key === "sources")?.values ?? [];
  const known = requested.length ? new Set((await eventSources().catch(() => [])).map((source) => source.id)) : new Set<string>();
  const applied = applyClarificationAnswers(frame, language, known);
  return {
    frame: { ...frame, message: applied.message, scope: applied.sourceIds ? { ...frame.scope, sourceIds: applied.sourceIds } : frame.scope },
    answered: applied.answered,
  };
}
