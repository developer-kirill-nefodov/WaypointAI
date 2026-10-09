import type { PlaceView } from "@waypoint-ai/shared";
import { searchNearbyPlaces, searchPlaces } from "../data/record.repository.js";
import { isAirportOptOut, resolveAirportCode } from "./trip-clarification.js";

type CategorySearch = { label: string; category: string; area: "airport_origin" | "airport_radius" | "city" | "country"; total: number; partial?: boolean; distancesMeters?: Record<string, number>; places: PlaceView[] };
export type TravelPlacePrefetch = { countryCode: string; city: string; airport?: PlaceView; airportCode?: string; airportUnavailable?: boolean; airportRadiusMeters?: number; searches: CategorySearch[]; places: PlaceView[] };

const COUNTRY_MATCHERS: Array<[string, RegExp]> = [
  ["DE", /герман|german|deutsch|deutschland|берлин|berlin/i],
  ["PL", /польш|poland|polska|polen|варшав|warsaw|warszaw|warschau/i],
  ["RO", /румын|romania|românia|rumän|бухарест|bucharest|bucurești|bukarest/i],
  ["FR", /франц|france|frankreich|paris|париж/i],
  ["IT", /итал|italy|italia|italien|рим|rome|roma/i],
  ["ES", /испан|spain|españa|spanien|мадрид|madrid/i],
];
const CAPITAL_CITIES: Record<string, string> = { DE: "Berlin", PL: "Warszawa", RO: "București", FR: "Paris", IT: "Roma", ES: "Madrid" };
const CITY_MATCHERS: Array<[string, RegExp]> = [
  ["Berlin", /\bberlin\b|берлин/i],
  ["Warszawa", /\bwarsaw\b|\bwarszawa\b|\bwarschau\b|варшав/i],
  ["București", /\bbucharest\b|\bbucurești\b|\bbukarest\b|бухарест/i],
  ["Paris", /\bparis\b|париж/i],
  ["Roma", /\brome\b|\broma\b|\brom\b|рим/i],
  ["Madrid", /\bmadrid\b|мадрид/i],
];

const FRESH_TRIP_PATTERN = /с\s+сам(?:ого|ой)\s+начала|нач(?:н[её]м|инаю|ать)\s+сначала|друг[а-яё]*\s+стран|нов[а-яё]*\s+(?:план|маршрут)|сбросить\s+(?:план|маршрут)|start\s+(?:over|from\s+scratch)|from\s+scratch|new\s+(?:trip|plan|itinerary)|different\s+country|neue\s+(?:reise|route|plan)|reise\s+neu\s+planen/i;

export function isFreshTravelRequest(message: string): boolean {
  return FRESH_TRIP_PATTERN.test(message);
}

export function explicitTravelCountry(message: string): string | undefined {
  const matches = COUNTRY_MATCHERS.filter(([, matcher]) => matcher.test(message)).map(([code]) => code);
  return matches.length === 1 ? matches[0] : undefined;
}

export function explicitTravelCity(message: string): string | undefined {
  const matches = CITY_MATCHERS.filter(([, matcher]) => matcher.test(message)).map(([city]) => city);
  return matches.length === 1 ? matches[0] : undefined;
}

export function inferRecentTravelCountry(userMessages: string[]): string | undefined {
  for (const message of userMessages.slice(-4).reverse()) {
    const matches = COUNTRY_MATCHERS.filter(([, matcher]) => matcher.test(message)).map(([code]) => code);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

export function inferRecentTravelCity(userMessages: string[]): string | undefined {
  for (const message of userMessages.slice(-8).reverse()) {
    const city = explicitTravelCity(message);
    if (city) return city;
  }
  return undefined;
}

export function recentTravelContextMessages(userMessages: string[]): string[] {
  let start = 0;
  let country: string | undefined;
  let city: string | undefined;
  for (const [index, message] of userMessages.entries()) {
    const nextCountry = explicitTravelCountry(message);
    const nextCity = explicitTravelCity(message);
    if (isFreshTravelRequest(message)
      || Boolean(nextCountry && country && nextCountry !== country)
      || Boolean(nextCity && city && nextCity !== city)) {
      start = index;
    }
    if (nextCountry) country = nextCountry;
    if (nextCity) city = nextCity;
  }
  return userMessages.slice(start);
}

export function isFreshTravelContext(message: string, recentUserMessages: string[]): boolean {
  if (isFreshTravelRequest(message)) return true;
  const currentCountry = explicitTravelCountry(message);
  const previousCountry = inferRecentTravelCountry(recentUserMessages);
  if (currentCountry && previousCountry && currentCountry !== previousCountry) return true;
  const currentCity = explicitTravelCity(message);
  const previousCity = inferRecentTravelCity(recentUserMessages);
  return Boolean(currentCity && previousCity && currentCity !== previousCity);
}

const CITY_WORD = /город|города|городу|cities|city|towns?|stadt|städte/i;
const RESTAURANT_WORD = /ресторан|кафе|поесть|кухн|restaurant|cafe|dining|food/i;
const TRAVEL_WORD = /путешеств|поезд|поеду|поехать|посет|рекоменд|посовет|куда|интересн|достопримеч|sehenswürdig|музе|museum|attraction|sightseeing|маршрут|план|дней|день|itinerary|route|travel|reisen?|besuchen|empfehl|trip|days?|tage?/i;
const MUSEUM_WORD = /музе|museum/i;
const ATTRACTION_WORD = /достопримеч|что посет|что посмотреть|sehenswürdig|attraction|sight|sightseeing/i;
const ITINERARY_WORD = /маршрут|план|дней|день|itinerary|route|days?|reiseplan|tage?/i;
const MAX_EXAMPLES_PER_CATEGORY = 4;
const DEFAULT_AIRPORT_RADIUS_METERS = 5_000;

/**
 * Small local models can skip or overconstrain a tool call for broad travel questions.
 * Preload matching OSM examples on the server so the response is grounded in actual rows.
 */
export async function prefetchTravelPlaces(message: string, sourceIds?: string[], language: "en" | "ru" | "de" = "en", inheritedCountryCode?: string, recentUserMessages: string[] = []): Promise<TravelPlacePrefetch | null> {
  const freshTrip = isFreshTravelContext(message, recentUserMessages);
  const contextMessage = freshTrip ? message : [...recentUserMessages.slice(-8), message].join("\n");
  if (!TRAVEL_WORD.test(contextMessage) && !CITY_WORD.test(contextMessage) && !RESTAURANT_WORD.test(contextMessage) && !freshTrip) return null;

  const currentCountry = explicitTravelCountry(message);
  const countryCodes = currentCountry ? [currentCountry] : COUNTRY_MATCHERS.filter(([, matcher]) => matcher.test(contextMessage)).map(([code]) => code);
  if (countryCodes.length === 0 && inheritedCountryCode && !freshTrip) countryCodes.push(inheritedCountryCode);
  if (countryCodes.length !== 1) return null;
  const countryCode = countryCodes[0]!;

  const cityRequested = CITY_WORD.test(contextMessage);
  const currentCity = explicitTravelCity(message);
  const namedCity = currentCity ? [currentCity] : CITY_MATCHERS.filter(([, matcher]) => matcher.test(contextMessage)).map(([city]) => city);
  const cityFilter = namedCity.length === 1 ? namedCity[0] : undefined;
  const foodRequested = RESTAURANT_WORD.test(contextMessage);
  const museumRequested = MUSEUM_WORD.test(contextMessage);
  const attractionRequested = ATTRACTION_WORD.test(contextMessage);
  const broadTravelRequest = (TRAVEL_WORD.test(contextMessage) || freshTrip) && !cityRequested && !foodRequested && !museumRequested && !attractionRequested;
  const itineraryRequested = ITINERARY_WORD.test(contextMessage) || freshTrip;
  let airportPreference: boolean | null = null;
  for (const userMessage of [...(freshTrip ? [] : recentUserMessages), message].reverse()) {
    if (isAirportOptOut(userMessage)) { airportPreference = false; break; }
    if (/аэропорт|airport|flughafen|lotnisko/i.test(userMessage)) { airportPreference = true; break; }
  }
  const airportRequested = airportPreference !== false && /аэропорт|airport|flughafen|lotnisko/i.test(contextMessage);
  const airportCode = airportRequested ? resolveAirportCode(message) ?? (freshTrip ? null : [...recentUserMessages].reverse().map(resolveAirportCode).find(Boolean) ?? null) : null;
  const airportRadiusMeters = parseAirportRadiusMeters(contextMessage);
  const categories: Array<{ label: string; category: string }> = [];
  if (cityRequested || (broadTravelRequest && !itineraryRequested && !cityFilter)) categories.push({ label: language === "ru" ? "города" : language === "de" ? "Städte" : "cities", category: "place:city" });
  if (foodRequested) categories.push({ label: language === "ru" ? "рестораны" : language === "de" ? "Restaurants" : "restaurants", category: "amenity:restaurant" });
  if (attractionRequested || broadTravelRequest || itineraryRequested) categories.push({ label: language === "ru" ? "достопримечательности" : language === "de" ? "Sehenswürdigkeiten" : "attractions", category: "tourism:attraction" });
  if (museumRequested || broadTravelRequest || itineraryRequested) categories.push({ label: language === "ru" ? "музеи" : language === "de" ? "Museen" : "museums", category: "tourism:museum" });
  if (/историч|historic/i.test(contextMessage)) categories.push({ label: language === "ru" ? "исторические места" : language === "de" ? "historische Orte" : "historic places", category: "historic:" });

  const searches: CategorySearch[] = [];
  let airport: PlaceView | undefined;
  let airportUnavailable = false;
  if (airportRequested && airportCode) {
    const airportResult = await searchPlaces({ countryCode, airportCode, sourceIds, limit: 1 });
    airport = airportResult.places[0];
    if (airport) searches.push({ label: `${language === "ru" ? "аэропорт" : language === "de" ? "Flughafen" : "airport"} ${airportCode}`, category: "aeroway:aerodrome", area: "airport_origin", total: 1, places: [airport] });
    else airportUnavailable = true;
  }
  for (const { label, category } of categories) {
    const nearAirport = airportRequested && Boolean(airport) && !foodRequested && /(?:^|:)(?:attraction|museum)(?:$|:)/i.test(category);
    const nearbyResult = nearAirport
      ? await searchNearbyPlaces({ countryCode, category, sourceIds, center: { lat: airport!.lat, lon: airport!.lon }, radiusMeters: airportRadiusMeters, limit: MAX_EXAMPLES_PER_CATEGORY })
      : null;
    let result = nearbyResult ?? await searchPlaces({ countryCode, category, sourceIds, city: category === "amenity:restaurant" ? CAPITAL_CITIES[countryCode] : cityFilter, limit: 60, preferCity: category === "amenity:restaurant" });
    if (category === "amenity:restaurant" && result.total === 0 && !cityFilter) {
      result = await searchPlaces({ countryCode, category, sourceIds, limit: 60, preferCity: true });
    }
    const examples = result.places
      .filter((place) => /\p{L}/u.test(place.name))
      .sort((a, b) => placeExampleScore(b) - placeExampleScore(a))
      .slice(0, MAX_EXAMPLES_PER_CATEGORY);
    searches.push({
      label: nearAirport
        ? `${label} ${language === "ru" ? "в радиусе" : language === "de" ? "im Umkreis von" : "within"} ${airportRadiusMeters / 1000} km ${language === "ru" ? "от аэропорта" : language === "de" ? "vom Flughafen" : "of the airport"}`
        : category === "amenity:restaurant" && result.places[0]?.city
          ? `${language === "ru" ? "рестораны в" : language === "de" ? "Restaurants in" : "restaurants in"} ${result.places[0].city}`
          : label,
      category,
      area: nearbyResult ? "airport_radius" : cityFilter ? "city" : "country",
      total: result.total,
      ...(nearbyResult ? { partial: nearbyResult.partial, distancesMeters: nearbyResult.distancesMeters } : {}),
      places: examples,
    });
    if (nearbyResult && cityFilter) {
      const cityResult = await searchPlaces({ countryCode, category, sourceIds, city: cityFilter, limit: 60 });
      const cityExamples = cityResult.places
        .filter((place) => /\p{L}/u.test(place.name))
        .sort((a, b) => placeExampleScore(b) - placeExampleScore(a))
        .slice(0, MAX_EXAMPLES_PER_CATEGORY);
      searches.push({
        label: `${label} ${language === "ru" ? "в городе" : "in"} ${cityFilter}`,
        category,
        area: "city",
        total: cityResult.total,
        places: cityExamples,
      });
    }
  }
  return {
    countryCode,
    city: cityFilter ?? CAPITAL_CITIES[countryCode] ?? countryCode,
    searches,
    ...(airport ? { airport, airportRadiusMeters } : {}),
    ...(airportCode ? { airportCode } : {}),
    ...(airportUnavailable ? { airportUnavailable: true } : {}),
    places: [...new Map([...searches.flatMap((search) => search.places), ...(airport ? [airport] : [])].map((place) => [place.id, place])).values()],
  };
}

function parseAirportRadiusMeters(message: string): number {
  const match = message.match(/(?:within|radius|радиус(?:е)?|в\s+пределах)\s*(\d{1,2})\s*(km|км|m|м)?/i);
  if (!match) return DEFAULT_AIRPORT_RADIUS_METERS;
  const value = Number(match[1]);
  const meters = match[2] && /^(?:m|м)$/i.test(match[2]) ? value : value * 1000;
  return Math.min(20_000, Math.max(100, meters));
}

function placeExampleScore(place: PlaceView): number {
  const name = place.name.trim();
  return Number(Boolean(place.city)) * 2
    + Number(/^\p{L}/u.test(name))
    - Number(/^\d/u.test(name));
}

export function formatTravelPlacePrefetch(prefetch: TravelPlacePrefetch): string {
  const lookup = prefetch.searches.map((search) => ({
    requestedType: search.label,
    geographicScope: search.area,
    totalMatchesInCurrentExtract: search.total,
    ...(search.partial ? { resultIsPartial: true } : {}),
    examples: search.places.map((place) => ({
      name: place.name,
      category: place.category,
      countryCode: place.countryCode,
      city: place.city,
      address: [place.street, place.houseNumber, place.postcode].filter(Boolean).join(" ") || null,
      details: place.details ?? {},
      sourceId: place.sourceId,
      coordinates: [place.lon, place.lat],
      ...(search.distancesMeters?.[place.id] !== undefined ? { straightLineDistanceFromAirportMeters: search.distancesMeters[place.id] } : {}),
    })),
  }));
  return JSON.stringify({ countryCode: prefetch.countryCode, localOpenStreetMapSnapshot: true, airportSelection: { code: prefetch.airportCode ?? null, status: prefetch.airportUnavailable ? "airport not present in the imported snapshot" : prefetch.airport ? "verified" : "not requested" }, airport: prefetch.airport ? { id: prefetch.airport.id, name: prefetch.airport.name, code: prefetch.airport.details?.iata, coordinates: [prefetch.airport.lon, prefetch.airport.lat], straightLineRadiusMeters: prefetch.airportRadiusMeters } : null, lookup });
}
