import { z } from "zod";
import type { PlaceView, TripPlan } from "@waypoint-ai/shared";

const MAX_TRIP_DAYS = 7;
const MAX_STOPS_PER_DAY = 8;
const STOPS_PER_NEW_DAY = 4;
const DEFAULT_ADDED_STOPS = 1;

/** Stop kinds the model may ask for; each maps to OSM categories that exist in the imported snapshots. */
export const TRIP_STOP_CATEGORIES = {
  attraction: ["tourism:attraction"],
  museum: ["tourism:museum"],
  gallery: ["tourism:gallery"],
  viewpoint: ["tourism:viewpoint"],
  monument: ["historic:monument", "historic:memorial"],
  castle: ["historic:castle"],
  church: ["amenity:place_of_worship"],
  theatre: ["amenity:theatre"],
  park: ["leisure:park", "leisure:garden"],
  restaurant: ["amenity:restaurant"],
  cafe: ["amenity:cafe"],
  bar: ["amenity:bar", "amenity:pub"],
} as const satisfies Record<string, readonly string[]>;
export type TripStopCategory = keyof typeof TRIP_STOP_CATEGORIES;
const SIGHTSEEING = ["tourism:attraction", "tourism:museum"];

const day = z.coerce.number().int().min(1).max(MAX_TRIP_DAYS);
const category = z.enum(Object.keys(TRIP_STOP_CATEGORIES) as [TripStopCategory, ...TripStopCategory[]]);
const stopReference = z.string().trim().min(1).max(200);

export const tripPlanOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_stops"), day, count: z.coerce.number().int().min(1).max(5).optional(), category: category.optional() }).strict(),
  z.object({ op: z.literal("remove_stops"), stops: z.array(stopReference).min(1).max(MAX_STOPS_PER_DAY) }).strict(),
  z.object({ op: z.literal("move_stop"), stop: stopReference, toDay: day }).strict(),
  z.object({ op: z.literal("add_day"), category: category.optional() }).strict(),
  z.object({ op: z.literal("remove_day"), day }).strict(),
  z.object({ op: z.literal("set_days"), totalDays: day }).strict(),
  z.object({ op: z.literal("replace_day"), day, category: category.optional() }).strict(),
  z.object({ op: z.literal("set_route_mode"), mode: z.enum(["driving", "none"]) }).strict(),
]);
export type TripPlanOperation = z.infer<typeof tripPlanOperationSchema>;
export const editTripPlanArgsSchema = z.object({ operations: z.array(tripPlanOperationSchema).min(1).max(6) }).strict();

const OPERATION_FIELDS: Record<TripPlanOperation["op"], readonly string[]> = {
  add_stops: ["day", "count", "category"],
  remove_stops: ["stops"],
  move_stop: ["stop", "toDay"],
  add_day: ["category"],
  remove_day: ["day"],
  set_days: ["totalDays"],
  replace_day: ["day", "category"],
  set_route_mode: ["mode"],
};

/**
 * The model sees one flat operation shape and small models often fill unused fields with null or defaults.
 * Fields that do not belong to the operation are dropped before the strict schema validates the rest.
 */
export function parseEditTripPlanArgs(raw: unknown) {
  const parsedValue = typeof raw === "string" ? safeJson(raw) : raw;
  // One flat operation per call is the model-facing shape; a list of operations is accepted as well.
  const value = parsedValue && typeof parsedValue === "object" && "op" in parsedValue ? { operations: [parsedValue] } : parsedValue;
  if (!value || typeof value !== "object" || !Array.isArray((value as { operations?: unknown }).operations)) return editTripPlanArgsSchema.safeParse(value);
  const operations = (value as { operations: unknown[] }).operations.map((operation) => {
    if (!operation || typeof operation !== "object") return operation;
    const op = (operation as { op?: unknown }).op;
    const fields = typeof op === "string" && op in OPERATION_FIELDS ? OPERATION_FIELDS[op as TripPlanOperation["op"]] : null;
    if (!fields) return operation;
    return Object.fromEntries(Object.entries(operation).filter(([key, field]) => key === "op" || (fields.includes(key) && field !== null && field !== "")));
  });
  return editTripPlanArgsSchema.safeParse({ ...value, operations });
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/** Looks up new verified stops near a point; the caller excludes places that are already in the plan. */
export type TripStopFinder = (input: {
  center: { lat: number; lon: number };
  categories: readonly string[];
  count: number;
  excludeIds: ReadonlySet<string>;
}) => Promise<PlaceView[]>;

export type TripPlanEditResult =
  | { ok: true; plan: TripPlan; places: PlaceView[]; changes: TripPlanChange[] }
  | { ok: false; error: string };

export type TripPlanChange =
  | { kind: "stops_added"; day: number; names: string[] }
  | { kind: "stops_removed"; names: string[] }
  | { kind: "stop_moved"; name: string; toDay: number }
  | { kind: "day_added"; day: number; names: string[] }
  | { kind: "day_removed"; day: number; renumbered: boolean }
  | { kind: "days_set"; totalDays: number }
  | { kind: "day_replaced"; day: number; names: string[] }
  | { kind: "route_mode"; mode: "driving" | "none" };

class EditError extends Error {}

/**
 * Applies the operations to a copy of the plan. Stops are referenced only by plan IDs or names, and new stops come
 * only from `findStops`, so an edit can neither invent a place nor reshuffle days it does not touch.
 */
export async function applyTripPlanEdits(
  plan: TripPlan,
  places: PlaceView[],
  operations: TripPlanOperation[],
  findStops: TripStopFinder,
): Promise<TripPlanEditResult> {
  const next: TripPlan = structuredClone(plan);
  const placeById = new Map(places.map((place) => [place.id, place]));
  // Removed stops stay excluded so "replace" or "add" in the same edit does not bring them back.
  const excluded = new Set(next.days.flatMap((entry) => entry.stopPlaceIds));
  const changes: TripPlanChange[] = [];

  const dayAt = (number: number) => {
    const found = next.days.find((entry) => entry.day === number);
    if (!found) throw new EditError(`Day ${number} does not exist; the plan has ${next.days.length} day(s).`);
    return found;
  };
  const find = async (center: { lat: number; lon: number }, kind: TripStopCategory | undefined, count: number) => {
    const found = await findStops({ center, categories: kind ? TRIP_STOP_CATEGORIES[kind] : SIGHTSEEING, count, excludeIds: excluded });
    const fresh = found.filter((place) => !excluded.has(place.id)).slice(0, count);
    for (const place of fresh) { excluded.add(place.id); placeById.set(place.id, place); }
    return fresh;
  };
  const appendDay = async (kind: TripStopCategory | undefined) => {
    if (next.days.length >= MAX_TRIP_DAYS) throw new EditError(`A plan can have at most ${MAX_TRIP_DAYS} days.`);
    const last = next.days.at(-1);
    const center = dayCenter(next, last?.day ?? 1, placeById);
    if (!center) throw new EditError("The plan has no located stops to search around.");
    const added = await find(center, kind, STOPS_PER_NEW_DAY);
    const number = next.days.length + 1;
    next.days.push({ day: number, area: "city", ...(last?.city ? { city: last.city } : {}), stopPlaceIds: added.map((place) => place.id), straightLineDistanceMetersFromAirport: {}, routeStatus: "pending" });
    return { number, added };
  };
  const names = (ids: string[]) => ids.map((id) => placeById.get(id)?.name ?? id);

  try {
    for (const operation of operations) {
      switch (operation.op) {
        case "add_stops": {
          if (operation.day === next.days.length + 1) {
            const { number, added } = await appendDay(operation.category);
            changes.push({ kind: "day_added", day: number, names: names(added.map((place) => place.id)) });
            break;
          }
          const target = dayAt(operation.day);
          const room = MAX_STOPS_PER_DAY - target.stopPlaceIds.length;
          if (room <= 0) throw new EditError(`Day ${operation.day} already has ${MAX_STOPS_PER_DAY} stops; remove some first.`);
          const center = dayCenter(next, operation.day, placeById);
          if (!center) throw new EditError("The plan has no located stops to search around.");
          const added = await find(center, operation.category, Math.min(room, operation.count ?? DEFAULT_ADDED_STOPS));
          if (!added.length) throw new EditError(`No new ${operation.category ?? "sightseeing"} places were found near day ${operation.day} in the local snapshot.`);
          target.stopPlaceIds.push(...added.map((place) => place.id));
          changes.push({ kind: "stops_added", day: operation.day, names: names(added.map((place) => place.id)) });
          break;
        }
        case "remove_stops": {
          const ids = operation.stops.map((reference) => resolveStop(next, reference, placeById));
          for (const entry of next.days) entry.stopPlaceIds = entry.stopPlaceIds.filter((id) => !ids.includes(id));
          changes.push({ kind: "stops_removed", names: names(ids) });
          break;
        }
        case "move_stop": {
          const id = resolveStop(next, operation.stop, placeById);
          const target = dayAt(operation.toDay);
          if (target.stopPlaceIds.includes(id)) throw new EditError(`${names([id])[0]} is already on day ${operation.toDay}.`);
          if (target.stopPlaceIds.length >= MAX_STOPS_PER_DAY) throw new EditError(`Day ${operation.toDay} already has ${MAX_STOPS_PER_DAY} stops.`);
          for (const entry of next.days) entry.stopPlaceIds = entry.stopPlaceIds.filter((stop) => stop !== id);
          target.stopPlaceIds.push(id);
          changes.push({ kind: "stop_moved", name: names([id])[0]!, toDay: operation.toDay });
          break;
        }
        case "add_day": {
          const { number, added } = await appendDay(operation.category);
          changes.push({ kind: "day_added", day: number, names: names(added.map((place) => place.id)) });
          break;
        }
        case "remove_day": {
          dayAt(operation.day);
          if (next.days.length === 1) throw new EditError("The plan has only one day; it cannot be removed.");
          const renumbered = operation.day < next.days.length;
          next.days = next.days.filter((entry) => entry.day !== operation.day);
          changes.push({ kind: "day_removed", day: operation.day, renumbered });
          break;
        }
        case "set_days": {
          while (next.days.length < operation.totalDays) await appendDay(undefined);
          next.days = next.days.slice(0, operation.totalDays);
          changes.push({ kind: "days_set", totalDays: operation.totalDays });
          break;
        }
        case "replace_day": {
          const target = dayAt(operation.day);
          const center = dayCenter(next, operation.day, placeById);
          if (!center) throw new EditError("The plan has no located stops to search around.");
          const added = await find(center, operation.category, Math.max(STOPS_PER_NEW_DAY, target.stopPlaceIds.length));
          if (!added.length) throw new EditError(`No new ${operation.category ?? "sightseeing"} places were found near day ${operation.day} in the local snapshot.`);
          target.stopPlaceIds = added.map((place) => place.id);
          changes.push({ kind: "day_replaced", day: operation.day, names: names(target.stopPlaceIds) });
          break;
        }
        case "set_route_mode": {
          next.travelMode = operation.mode;
          changes.push({ kind: "route_mode", mode: operation.mode });
          break;
        }
      }
      next.days.forEach((entry, index) => { entry.day = index + 1; });
    }
  } catch (error) {
    if (error instanceof EditError) return { ok: false, error: error.message };
    throw error;
  }

  const finalPlan = finalizeTripPlan(next, placeById);
  const planPlaces = [...new Set(finalPlan.days.flatMap((entry) => entry.stopPlaceIds))].flatMap((id) => placeById.get(id) ?? []);
  return { ok: true, plan: finalPlan, places: planPlaces, changes };
}

/** Recomputes the derived fields after a change: route status per day, counts, status, and sources. */
export function finalizeTripPlan(plan: TripPlan, placeById: Map<string, PlaceView>): TripPlan {
  for (const entry of plan.days) {
    const routePoints = entry.stopPlaceIds.length + Number(entry.area === "airport_radius" && Boolean(plan.airport));
    entry.routeStatus = plan.travelMode === "none" ? "not_requested" : routePoints >= 2 ? "pending" : "unavailable";
    entry.straightLineDistanceMetersFromAirport = Object.fromEntries(
      Object.entries(entry.straightLineDistanceMetersFromAirport).filter(([id]) => entry.stopPlaceIds.includes(id)),
    );
  }
  const supportedDays = plan.days.filter((entry) => entry.stopPlaceIds.length > 0).length;
  const sourceIds = [...new Set(plan.days.flatMap((entry) => entry.stopPlaceIds).flatMap((id) => placeById.get(id)?.sourceId ?? []))];
  return {
    ...plan,
    totalDays: plan.days.length,
    supportedDays,
    status: supportedDays === plan.days.length ? "ready" : "partial",
    sourceIds: sourceIds.length ? sourceIds : plan.sourceIds,
  };
}

/** A stop is named by its plan ID, its exact name, or a fragment that matches exactly one stop of the plan. */
export function resolveStop(plan: TripPlan, reference: string, placeById: Map<string, PlaceView>): string {
  const stops = [...new Set(plan.days.flatMap((entry) => entry.stopPlaceIds))];
  if (stops.includes(reference)) return reference;
  // "2.3": day 2, stop 3, as numbered in the plan the model sees.
  const position = /^(\d)\.(\d{1,2})$/.exec(reference.trim());
  if (position) {
    const id = plan.days.find((entry) => entry.day === Number(position[1]))?.stopPlaceIds[Number(position[2]) - 1];
    if (id) return id;
    throw new EditError(`There is no stop ${reference} in the current plan.`);
  }
  const wanted = normalize(reference);
  const named = stops.map((id) => ({ id, name: normalize(placeById.get(id)?.name ?? "") })).filter((stop) => stop.name);
  const exact = named.filter((stop) => stop.name === wanted);
  if (exact.length === 1) return exact[0]!.id;
  const partial = named.filter((stop) => wanted.length >= 3 && (stop.name.includes(wanted) || wanted.includes(stop.name)));
  if (partial.length === 1) return partial[0]!.id;
  throw new EditError(partial.length > 1
    ? `"${reference}" matches several stops: ${partial.map((stop) => placeById.get(stop.id)?.name).join(", ")}. Ask which one.`
    : `"${reference}" is not a stop of the current plan.`);
}

/** Search center for new stops of a day: its stops, else its city, else the whole plan. */
function dayCenter(plan: TripPlan, number: number, placeById: Map<string, PlaceView>): { lat: number; lon: number } | null {
  const entry = plan.days.find((candidate) => candidate.day === number);
  const own = centroid((entry?.stopPlaceIds ?? []).flatMap((id) => placeById.get(id) ?? []));
  if (own) return own;
  const city = plan.cities?.find((candidate) => candidate.name === entry?.city) ?? plan.cities?.[0];
  if (city) return { lat: city.lat, lon: city.lon };
  return centroid(plan.days.flatMap((candidate) => candidate.stopPlaceIds).flatMap((id) => placeById.get(id) ?? []))
    ?? (plan.airport ? { lat: plan.airport.lat, lon: plan.airport.lon } : null);
}

function centroid(points: Array<{ lat: number; lon: number }>): { lat: number; lon: number } | null {
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lon: points.reduce((sum, point) => sum + point.lon, 0) / points.length,
  };
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The plan as the model sees it: days and stops with short refs ("1.2") and names. */
export function describePlanForModel(plan: TripPlan, places: PlaceView[]): string {
  const placeById = new Map(places.map((place) => [place.id, place]));
  return JSON.stringify({
    city: plan.city,
    totalDays: plan.totalDays,
    totalStops: plan.days.reduce((sum, entry) => sum + entry.stopPlaceIds.length, 0),
    travelMode: plan.travelMode,
    days: plan.days.map((entry) => ({
      day: entry.day,
      ...(entry.city ? { city: entry.city } : {}),
      stopCount: entry.stopPlaceIds.length,
      stops: entry.stopPlaceIds.map((id, index) => ({ ref: `${entry.day}.${index + 1}`, name: placeById.get(id)?.name ?? null, category: placeById.get(id)?.category ?? null })),
    })),
  });
}
