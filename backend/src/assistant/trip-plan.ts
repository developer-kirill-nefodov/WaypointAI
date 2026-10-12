import type { TripPlan } from "@waypoint-ai/shared";
import type { TravelPlacePrefetch } from "./travel-place-prefetch.js";
import type { ResolvedTripPreferences } from "./trip-clarification.js";

export function buildTripPlan(prefetch: TravelPlacePrefetch | null, preferences: ResolvedTripPreferences): TripPlan | null {
  if (!prefetch || !preferences.routeMode) return null;
  if (prefetch.airportUnavailable && !preferences.cityOnly) return null;
  // An explicit route choice without a stated duration is treated as a one-day plan.
  const totalDays = preferences.totalDays ?? 1;
  const airport = preferences.cityOnly ? null : prefetch.airport ?? null;
  const airportPlaces = uniquePlaces(prefetch.searches.filter((search) => search.area === "airport_radius").flatMap((search) => search.places));
  const destinationArea = prefetch.searches.some((search) => search.area === "city") ? "city" : "country";
  const cityPlaces = uniquePlaces(prefetch.searches.filter((search) => search.area === destinationArea).flatMap((search) => search.places));
  const cityStartDay = airport ? 2 : 1;
  const cityDayCount = Math.max(1, totalDays - cityStartDay + 1);
  const cityGroups = splitEvenly(cityPlaces, cityDayCount);
  const days: TripPlan["days"] = [];
  let cappedStops = false;

  for (let day = 1; day <= totalDays; day += 1) {
    const airportDay = Boolean(airport) && day === 1;
    const availablePlaces = airportDay ? airportPlaces : cityGroups[day - cityStartDay] ?? [];
    const selectedPlaces = availablePlaces.slice(0, airportDay ? 7 : 8);
    cappedStops ||= selectedPlaces.length < availablePlaces.length;
    const routePointCount = selectedPlaces.length + Number(airportDay && Boolean(airport));
    const routeStatus: TripPlan["days"][number]["routeStatus"] = preferences.routeMode === "none"
      ? "not_requested"
      : routePointCount >= 2 ? "pending" : "unavailable";
    const distances = Object.fromEntries(selectedPlaces.flatMap((place) => {
      const distance = prefetch.searches.find((search) => search.area === "airport_radius")?.distancesMeters?.[place.id];
      return distance === undefined ? [] : [[place.id, distance]];
    }));
    days.push({
      day,
      area: airportDay ? "airport_radius" : "city",
      stopPlaceIds: selectedPlaces.map((place) => place.id),
      straightLineDistanceMetersFromAirport: distances,
      routeStatus,
    });
  }

  const supportedDays = days.filter((day) => day.stopPlaceIds.length > 0).length;
  const stopsAndOrigin = [...(airport ? [airport] : []), ...airportPlaces, ...cityPlaces];
  const sourceIds = [...new Set(stopsAndOrigin.map((place) => place.sourceId))];
  const hasTruncatedSearch = cappedStops || prefetch.searches.some((search) => search.partial);
  return {
    status: supportedDays === totalDays && !hasTruncatedSearch ? "ready" : "partial",
    countryCode: prefetch.countryCode,
    city: prefetch.city,
    totalDays,
    supportedDays,
    travelMode: preferences.routeMode,
    airport: airport && preferences.airportCode ? {
      placeId: airport.id,
      code: preferences.airportCode,
      name: airport.name,
      lat: airport.lat,
      lon: airport.lon,
    } : null,
    days,
    sourceIds,
  };
}

function uniquePlaces<T extends { id: string }>(places: T[]): T[] {
  return [...new Map(places.map((place) => [place.id, place])).values()];
}

function splitEvenly<T>(values: T[], groupCount: number): T[][] {
  const size = Math.ceil(values.length / groupCount);
  return Array.from({ length: groupCount }, (_, index) => values.slice(index * size, (index + 1) * size));
}
