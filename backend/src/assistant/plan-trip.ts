import type { PlaceView, TripPlan } from "@waypoint-ai/shared";
import type { ResolvedPlace } from "../data/settlement.repository.js";
import { MAX_TRIP_DAYS, parsePlanTripArgs, type PlanTripArgs } from "../tools/plan-trip.js";
import { buildCityTripPlan, prefetchCityTrip, type TripCity } from "./city-trip-plan.js";
import { finalizeTripPlan } from "./trip-plan-edit.js";

const AIRPORT_RADIUS_METERS = 5_000;
const AIRPORT_DAY_STOPS = 6;

export interface PlanTripDependencies {
  resolveSettlement: (name: string) => Promise<ResolvedPlace | null>;
  prefetchCityTrip?: typeof prefetchCityTrip;
  findAirport: (code: string) => Promise<PlaceView | null>;
  findNearAirport: (center: { lat: number; lon: number }, radiusMeters: number, count: number) => Promise<{ places: PlaceView[]; distancesMeters: Record<string, number> }>;
}

export type PlanTripOutcome =
  | { kind: "planned"; plan: TripPlan; places: PlaceView[] }
  /** The cities are valid but the user has not said whether to calculate a driving route; the backend asks. */
  | { kind: "ask_route_mode"; cities: string[] }
  /** Returned to the model, which explains it to the user in their language. */
  | { kind: "error"; error: string };

/**
 * Builds a plan from the model's structured request. The model supplies only city names, day counts, and the travel
 * mode; cities are resolved against verified settlements and every stop comes from the local database.
 */
export async function executePlanTrip(rawArgs: unknown, dependencies: PlanTripDependencies, sourceIds?: string[]): Promise<PlanTripOutcome> {
  const parsed = parsePlanTripArgs(rawArgs);
  if (!parsed.success) return { kind: "error", error: "Invalid plan_trip arguments. Pass cities as [{name, days?}], totalDays 1–7, routeMode driving or none." };
  const args = parsed.data;

  const resolved = await Promise.all(args.cities.map((city) => dependencies.resolveSettlement(city.name)));
  const missing = args.cities.filter((_, index) => !resolved[index]).map((city) => city.name);
  if (missing.length) {
    return { kind: "error", error: `Not found among settlements in the imported OpenStreetMap regions: ${missing.join(", ")}. Tell the user the local data does not cover it, or ask for the local spelling of the city. Do not plan other cities instead.` };
  }
  // The same settlement named twice ("Rome" and "Roma") is one stop of the trip.
  const cities: TripCity[] = [];
  const explicitDays: Array<number | null> = [];
  for (const [index, place] of resolved.entries()) {
    if (cities.some((city) => city.id === place!.id)) continue;
    const { match: _match, ...city } = place!;
    cities.push(city);
    explicitDays.push(args.cities[index]!.days ?? null);
  }
  if (!args.routeMode) return { kind: "ask_route_mode", cities: cities.map((city) => city.name) };

  let airport: PlaceView | null = null;
  if (args.airportCode) {
    airport = await dependencies.findAirport(args.airportCode);
    if (!airport) return { kind: "error", error: `Airport ${args.airportCode} is not in the imported snapshot. Ask the user whether to plan the trip without it.` };
  }
  // An airport day is the first day of the stay; the cities share the rest.
  const cityDays = allocateTripDays(explicitDays, args.totalDays === undefined ? undefined : Math.max(cities.length, args.totalDays - (airport ? 1 : 0)));
  const stops = await (dependencies.prefetchCityTrip ?? prefetchCityTrip)(cities, cityDays, sourceIds);
  const plan = buildCityTripPlan(stops, args.routeMode);
  const places = [...new Map(stops.flatMap((stop) => stop.places).map((place) => [place.id, place])).values()];
  if (!airport) return { kind: "planned", plan, places };

  const nearby = await dependencies.findNearAirport({ lat: airport.lat, lon: airport.lon }, AIRPORT_RADIUS_METERS, AIRPORT_DAY_STOPS);
  const airportStops = nearby.places.filter((place) => !places.some((existing) => existing.id === place.id));
  const airportDay: TripPlan["days"][number] = {
      day: 1,
      area: "airport_radius",
      stopPlaceIds: airportStops.map((place) => place.id),
      straightLineDistanceMetersFromAirport: Object.fromEntries(airportStops.flatMap((place) => nearby.distancesMeters[place.id] === undefined ? [] : [[place.id, nearby.distancesMeters[place.id]!]])),
      routeStatus: "pending",
  };
  const days = [airportDay, ...plan.days].slice(0, MAX_TRIP_DAYS).map((day, index) => ({ ...day, day: index + 1 }));
  const allPlaces = [airport, ...airportStops, ...places];
  const withAirport = finalizeTripPlan({
    ...plan,
    airport: { placeId: airport.id, code: args.airportCode!, name: airport.name, lat: airport.lat, lon: airport.lon },
    days,
  }, new Map(allPlaces.map((place) => [place.id, place])));
  return { kind: "planned", plan: withAirport, places: [...airportStops, ...places] };
}

/**
 * Days per city: counts the user gave for a city are kept and the rest of the total is shared evenly in visiting
 * order. Every city gets at least one day and the trip is capped at seven days.
 */
export function allocateTripDays(explicit: Array<number | null>, totalDays: number | undefined): number[] {
  const explicitSum = explicit.reduce<number>((sum, days) => sum + (days ?? 0), 0);
  const open = explicit.filter((days) => days === null).length;
  const total = Math.min(MAX_TRIP_DAYS, Math.max(explicit.length, open === 0 ? explicitSum : Math.max(totalDays ?? explicit.length, explicitSum + open)));
  const remaining = Math.max(open, total - explicitSum);
  const perOpen = open ? Math.floor(remaining / open) : 0;
  let extra = open ? remaining - perOpen * open : 0;
  const days = explicit.map((count) => {
    if (count !== null) return count;
    const share = perOpen + (extra > 0 ? 1 : 0);
    extra -= 1;
    return Math.max(1, share);
  });
  for (let index = days.length - 1; index >= 0 && sum(days) > MAX_TRIP_DAYS; index -= 1) {
    days[index] = Math.max(1, days[index]! - (sum(days) - MAX_TRIP_DAYS));
  }
  return days;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
