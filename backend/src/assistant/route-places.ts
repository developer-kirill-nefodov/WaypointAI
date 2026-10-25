import type { PlaceView, TripPlan } from "@waypoint-ai/shared";
import { haversineDistanceMeters } from "../data/geo-sql.js";
import { formatTripPlanMessage } from "./trip-plan-message.js";

/** A day of a plan has at most this many stops; ten found places become two days of five. */
const ROUTE_DAY_STOPS = 8;

/**
 * A driving plan through the places a search found: each next stop is the nearest one not yet visited, starting
 * from the first listed place, and the stops are split into days of at most eight. Nothing is added or dropped.
 */
export function buildRoutePlan(found: PlaceView[], label: string | null): TripPlan {
  const remaining = [...new Map(found.map((place) => [place.id, place])).values()];
  const ordered: PlaceView[] = [];
  let current = remaining.shift();
  while (current) {
    ordered.push(current);
    const from = current;
    remaining.sort((left, right) => haversineDistanceMeters(from, left) - haversineDistanceMeters(from, right));
    current = remaining.shift();
  }
  const dayCount = Math.max(1, Math.ceil(ordered.length / ROUTE_DAY_STOPS));
  const perDay = Math.ceil(ordered.length / dayCount);
  const city = (label ?? mostCommon(ordered.map((place) => place.city)) ?? "").slice(0, 120);
  const days: TripPlan["days"] = Array.from({ length: dayCount }, (_, index) => {
    const stopPlaceIds = ordered.slice(index * perDay, (index + 1) * perDay).map((place) => place.id);
    return { day: index + 1, area: "city", city, stopPlaceIds, straightLineDistanceMetersFromAirport: {}, routeStatus: stopPlaceIds.length >= 2 ? "pending" : "unavailable" };
  });
  const supportedDays = days.filter((day) => day.stopPlaceIds.length > 0).length;
  return {
    status: supportedDays === days.length ? "ready" : "partial",
    countryCode: mostCommon(ordered.map((place) => place.countryCode)) ?? "XX",
    city,
    totalDays: days.length,
    supportedDays,
    travelMode: "driving",
    airport: null,
    days,
    sourceIds: [...new Set(ordered.map((place) => place.sourceId))],
  };
}

/** The reply to a route through found places: what was done, then the stops of each day from the plan rows. */
export function formatRoutePlacesMessage(plan: TripPlan, places: PlaceView[], language: "en" | "ru" | "de"): string {
  const stops = plan.days.reduce((sum, day) => sum + day.stopPlaceIds.length, 0);
  const where = plan.city ? ` (${plan.city})` : "";
  const header = language === "ru"
    ? `Маршрут на машине по найденным местам${where}: ${stops} ${stops % 10 === 1 && stops % 100 !== 11 ? "точка" : stops % 10 >= 2 && stops % 10 <= 4 && (stops % 100 < 12 || stops % 100 > 14) ? "точки" : "точек"}${plan.totalDays > 1 ? `, по дням: ${plan.totalDays}` : ""}. Каждая следующая точка — ближайшая из оставшихся.`
    : language === "de" ? `Autoroute durch die gefundenen Orte${where}: ${stops} Stopps${plan.totalDays > 1 ? ` an ${plan.totalDays} Tagen` : ""}. Jeder nächste Stopp ist der nächstgelegene der übrigen.`
      : `A driving route through the found places${where}: ${stops} stops${plan.totalDays > 1 ? ` over ${plan.totalDays} days` : ""}. Each next stop is the nearest of the remaining ones.`;
  const full = formatTripPlanMessage(plan, places, language);
  const firstBreak = full.indexOf("\n");
  return firstBreak < 0 ? header : header + full.slice(firstBreak);
}

function mostCommon(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}
