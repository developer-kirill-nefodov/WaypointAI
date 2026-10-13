import type { PlaceView, TripPlan } from "@waypoint-ai/shared";
import { searchNearbyPlaces } from "../data/record.repository.js";
import { CAPITAL_TRIP_CITIES } from "./travel-place-prefetch.js";
import type { TripCity } from "./trip-cities.js";

const STOPS_PER_DAY = 4;
const MAX_STOPS_PER_DAY = 8;
const MIN_PER_CATEGORY = 4;
const MAX_PER_CATEGORY = 14;
const SEARCH_RADIUS_METERS: Record<string, number> = { "place:city": 8_000, "place:town": 4_000 };
const DEFAULT_SEARCH_RADIUS_METERS = 2_500;
const SIGHTSEEING_CATEGORIES = ["tourism:attraction", "tourism:museum"];

export interface CityStops {
  city: TripCity;
  days: number;
  places: PlaceView[];
  partial: boolean;
}

/** City trips cover several cities, or one city that the single-city flow does not know (for example Firenze). */
export function isCityTrip(cities: TripCity[]): boolean {
  return cities.length > 1 || (cities.length === 1 && !CAPITAL_TRIP_CITIES.has(cities[0]!.name));
}

/** Sightseeing places around each city's verified center, about four per planned day. */
export async function prefetchCityTrip(
  cities: TripCity[],
  daysPerCity: number[],
  sourceIds?: string[],
  search: typeof searchNearbyPlaces = searchNearbyPlaces,
): Promise<CityStops[]> {
  return Promise.all(cities.map(async (city, index) => {
    const days = daysPerCity[index] ?? 1;
    const limit = Math.min(MAX_PER_CATEGORY, Math.max(MIN_PER_CATEGORY, Math.ceil((days * STOPS_PER_DAY) / SIGHTSEEING_CATEGORIES.length)));
    const radiusMeters = SEARCH_RADIUS_METERS[city.category] ?? DEFAULT_SEARCH_RADIUS_METERS;
    const results = await Promise.all(SIGHTSEEING_CATEGORIES.map((category) => search({
      category,
      sourceIds,
      center: { lat: city.lat, lon: city.lon },
      radiusMeters,
      limit,
    })));
    // Interleave categories so each day mixes attractions and museums; keep only named rows.
    const merged: PlaceView[] = [];
    for (let position = 0; position < limit; position += 1) {
      for (const result of results) {
        const place = result.places[position];
        if (place && /\p{L}/u.test(place.name)) merged.push(place as PlaceView);
      }
    }
    return {
      city,
      days,
      places: [...new Map(merged.map((place) => [place.id, place])).values()],
      partial: results.some((result) => result.partial),
    };
  }));
}

/** One plan across cities: each city gets its consecutive days and its own stops; routes stay within a day. */
export function buildCityTripPlan(stops: CityStops[], travelMode: "driving" | "none"): TripPlan {
  const days: TripPlan["days"] = [];
  let cappedStops = false;
  for (const { city, days: cityDays, places } of stops) {
    const groups = splitEvenly(places, cityDays);
    for (const group of groups) {
      const selected = group.slice(0, MAX_STOPS_PER_DAY);
      cappedStops ||= selected.length < group.length;
      days.push({
        day: days.length + 1,
        area: "city",
        city: city.name,
        stopPlaceIds: selected.map((place) => place.id),
        straightLineDistanceMetersFromAirport: {},
        routeStatus: travelMode === "none" ? "not_requested" : selected.length >= 2 ? "pending" : "unavailable",
      });
    }
  }
  const supportedDays = days.filter((day) => day.stopPlaceIds.length > 0).length;
  const partial = cappedStops || stops.some((stop) => stop.partial) || supportedDays < days.length;
  return {
    status: partial ? "partial" : "ready",
    countryCode: stops.find((stop) => stop.city.countryCode)?.city.countryCode ?? "XX",
    city: stops.map((stop) => stop.city.name).join(", ").slice(0, 120),
    totalDays: days.length,
    supportedDays,
    travelMode,
    cities: stops.map(({ city }) => ({
      name: city.name,
      placeId: city.id,
      lat: city.lat,
      lon: city.lon,
      countryCode: city.countryCode,
    })),
    airport: null,
    days,
    sourceIds: [...new Set(stops.flatMap((stop) => stop.places.map((place) => place.sourceId)))],
  };
}

function splitEvenly<T>(values: T[], groupCount: number): T[][] {
  const size = Math.ceil(values.length / Math.max(1, groupCount));
  return Array.from({ length: groupCount }, (_, index) => values.slice(index * size, (index + 1) * size));
}
