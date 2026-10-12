import { explicitTravelCountry, inferRecentTravelCountry } from "./travel-place-prefetch.js";

type Language = "en" | "ru" | "de";

export interface TripClarification {
  message: string;
  choices: Array<{ id: string; label: string }>;
}

export interface ResolvedTripPreferences {
  airportCode: "WAW" | "WMI" | null;
  totalDays: number | null;
  routeMode: "driving" | "none" | null;
  cityOnly: boolean;
}

const ITINERARY_WORD = /маршрут|план|программа|дней|день|itinerary|route|days?|schedule|reiseplan|tage?/i;
const AIRPORT_WORD = /аэропорт|airport|flughafen|lotnisko/i;
const ROUTE_WORD = /маршрут|route|дорог|поездк|(?<!\p{L})пут(?:ь|и|ём|ем)(?!\p{L})|проложи|directions|trip|reise|fahrt/iu;
const MAX_TRIP_DAYS = 7;
const DAY_WORD = String.raw`(?:день|дня|дней|дне|днями|днях|days?|tage?n?)`;
const DAY_COUNT_WORDS: Array<[number, string]> = [
  [1, "1|один|одна|одного|one|ein|eine|einen"],
  [2, "2|два|двух|two|zwei"],
  [3, "3|три|тр[её]х|three|drei"],
  [4, "4|четыре|четыр[её]х|four|vier"],
  [5, "5|пять|пяти|five|fünf"],
  [6, "6|шесть|шести|six|sechs"],
  [7, "7|семь|семи|seven|sieben"],
];
const DAY_COUNT_PATTERN = new RegExp(String.raw`(?<![\p{L}\d])(${DAY_COUNT_WORDS.map(([, words]) => words).join("|")})(?:-?[хx])?\s*[- ]?\s*${DAY_WORD}(?![\p{L}])`, "iu");
const WEEK_PATTERN = /на\s+(?:одну\s+)?неделю|for\s+(?:a|one)\s+week\b|(?:a|one)[- ]week\b|eine\s+woche/i;
const WARSAW_WORD = /warsaw|warszaw|warschau|варшав|mazovia|польск|poland|polska|polen/i;

export function getTripClarification(currentMessage: string, recentUserMessages: string[], language: Language): TripClarification | null {
  const context = [...recentUserMessages.slice(-8), currentMessage].join("\n");
  const warsawAirportTrip = ITINERARY_WORD.test(context) && AIRPORT_WORD.test(context) && WARSAW_WORD.test(context);
  const destinationKnown = Boolean(explicitTravelCountry(currentMessage) ?? inferRecentTravelCountry(recentUserMessages));
  const dayPlanRequested = ROUTE_WORD.test(currentMessage) || hasTripDuration(currentMessage);
  if (!warsawAirportTrip && !(destinationKnown && dayPlanRequested)) return null;
  const cityOnly = isCityOnlyTrip([...recentUserMessages, currentMessage]);

  const airportCode = resolveAirportCode(context);
  if (warsawAirportTrip && !airportCode && !cityOnly) {
    return language === "ru" ? {
      message: "Какой аэропорт Варшавы использовать как начальную точку?",
      choices: [
        { id: "airport-waw", label: "Аэропорт имени Шопена (WAW)" },
        { id: "airport-wmi", label: "Аэропорт Варшава-Модлин (WMI)" },
      ],
    } : language === "de" ? {
      message: "Welchen Warschauer Flughafen soll ich als Startpunkt verwenden?",
      choices: [
        { id: "airport-waw", label: "Flughafen Warschau-Chopin (WAW)" },
        { id: "airport-wmi", label: "Flughafen Warschau-Modlin (WMI)" },
      ],
    } : {
      message: "Which Warsaw airport should I use as the starting point?",
      choices: [
        { id: "airport-waw", label: "Warsaw Chopin Airport (WAW)" },
        { id: "airport-wmi", label: "Warsaw Modlin Airport (WMI)" },
      ],
    };
  }

  if (warsawAirportTrip && hasContradictoryTripLength(context) && !hasResolvedTripLength(currentMessage) && !recentUserMessages.some(hasResolvedTripLength)) {
    return language === "ru" ? {
      message: "Уточните общую длительность: два дня всего или день у аэропорта плюс ещё два дня в Варшаве?",
      choices: [
        { id: "days-two", label: "2 дня всего" },
        { id: "days-three", label: "3 дня всего: день у аэропорта и ещё 2 дня в Варшаве" },
      ],
    } : language === "de" ? {
      message: "Wie lange dauert der gesamte Aufenthalt: zwei Tage insgesamt oder ein Tag am Flughafen plus zwei weitere Tage in Warschau?",
      choices: [
        { id: "days-two", label: "Insgesamt 2 Tage" },
        { id: "days-three", label: "3 Tage: ein Tag am Flughafen und 2 weitere in Warschau" },
      ],
    } : {
      message: "How long is the whole stay: two days total, or an airport day plus two more days in Warsaw?",
      choices: [
        { id: "days-two", label: "2 days total" },
        { id: "days-three", label: "3 days total: airport day plus 2 more in Warsaw" },
      ],
    };
  }

  if ((warsawAirportTrip ? ROUTE_WORD.test(context) : dayPlanRequested) && !hasResolvedRouteMode(context)) {
    return language === "ru" ? {
      message: "Сейчас приложение умеет строить только автомобильный маршрут. Подойдёт такой вариант?",
      choices: [
        { id: "route-driving", label: "Да, автомобильный маршрут" },
        { id: "route-none", label: "Нет, покажи только список мест" },
      ],
    } : language === "de" ? {
      message: "Die App kann derzeit nur Autofahrten berechnen. Passt diese Option?",
      choices: [
        { id: "route-driving", label: "Ja, eine Autofahrt" },
        { id: "route-none", label: "Nein, nur Orte anzeigen" },
      ],
    } : {
      message: "The current app can calculate driving routes only. Is that suitable?",
      choices: [
        { id: "route-driving", label: "Yes, use a driving route" },
        { id: "route-none", label: "No, show places without a route" },
      ],
    };
  }

  return null;
}

export function resolveAirportCode(value: string): "WAW" | "WMI" | null {
  if (/\bWAW\b|chopin|шопен/i.test(value)) return "WAW";
  if (/\bWMI\b|modlin|модлин/i.test(value)) return "WMI";
  return null;
}

export function resolveTripPreferences(userMessages: string[]): ResolvedTripPreferences {
  const airportCode = [...userMessages].reverse().map(resolveAirportCode).find(Boolean) ?? null;
  const totalDaysMessage = [...userMessages].reverse().find(hasTripDuration);
  const totalDays = totalDaysMessage ? parseTripDuration(totalDaysMessage) : null;
  let routeMode: ResolvedTripPreferences["routeMode"] = null;
  for (const message of userMessages) {
    if (/(?:автомоб\w*|на\s+машин\w*|driving|by\s+car|auto(?:fahrt)?|mit\s+dem\s+auto)/i.test(message)) routeMode = "driving";
    else if (/(?:только\s+список\s+мест|без\s+маршрут\w*|no\s+route|without\s+a\s+route|nur\s+orte|ohne\s+route)/i.test(message)) routeMode = "none";
  }
  const cityOnly = isCityOnlyTrip(userMessages);
  return { airportCode, totalDays, routeMode, cityOnly };
}

export function isAirportOptOut(value: string): boolean {
  return /без\s+аэропорта|только\s+(?:по\s+)?мест(?:а|ам)\s+в\s+варшаве|without\s+(?:the\s+)?airport|city[- ]only|ohne\s+flughafen|nur\s+orte\s+in\s+warschau/i.test(value);
}

function isCityOnlyTrip(userMessages: string[]): boolean {
  for (const message of [...userMessages].reverse()) {
    if (isAirportOptOut(message)) return true;
    if (/аэропорт|airport|flughafen|lotnisko/i.test(message)) return false;
  }
  return false;
}

function hasContradictoryTripLength(value: string): boolean {
  const arrivalDay = /(?:перв(?:ый|ого)\s+день|день\s+прил[её]та|first\s+day|arrival\s+day)/i.test(value);
  const remainingDays = /(?:оставш[а-яё]*|remaining)\s+(?:(?:ещ[её]|another)\s+)?(?:дв(?:а|ух)|2|two)\s+(?:дн[яеий]*|days?)/i.test(value);
  const claimedTwoDayStay = /(?:пробыть|побыть|останов(?:иться|люсь)|stay|spend)\s+(?:там\s+|there\s+)?(?:дв(?:а|ух)|2|two)\s+(?:дн[яеий]*|days?)/i.test(value)
    || /(?:на|for)\s+(?:дв(?:а|ух)|2|two)\s+(?:дн[яеий]*|days?)/i.test(value);
  return arrivalDay && remainingDays && claimedTwoDayStay;
}

function hasResolvedTripLength(value: string): boolean {
  return /(?:(?:^|\s)[123]\s*(?:день|дня|дней|days?)\s*(?:всего|total)(?:\s|[:.,]|$)|(?:всего|total)\s*(?:[123]|один|одна|два|три|one|two|three)\s*(?:день|дня|дней|days?)(?:\s|$)|(?:оставить|оставь|keep|leave)\s+(?:только\s+)?(?:1|один|одна|one)\s*(?:день|day))/i.test(value) || removesSecondDay(value);
}

export function hasTripDuration(value: string): boolean {
  return parseTripDuration(value) !== null;
}

/** Returns the first stated trip length of 1–7 days; longer trips are not planned deterministically. */
function parseTripDuration(value: string): number | null {
  if (removesSecondDay(value)) return 1;
  const match = DAY_COUNT_PATTERN.exec(value);
  if (match) {
    const word = match[1]!.toLowerCase();
    return DAY_COUNT_WORDS.find(([, words]) => new RegExp(`^(?:${words})$`, "iu").test(word))?.[0] ?? null;
  }
  return WEEK_PATTERN.test(value) ? MAX_TRIP_DAYS : null;
}

function removesSecondDay(value: string): boolean {
  return /(?:убери|удали|remove)\s+(?:(?:день|day)\s*)?(?:2(?:-й|й|ой)?|втор(?:ой|ого)|second)\s+(?:день|day)|remove\s+day\s+2/i.test(value);
}

function hasResolvedRouteMode(value: string): boolean {
  return /(?:автомоб\w*|на\s+машин\w*|driving|by\s+car|auto(?:fahrt)?|mit\s+dem\s+auto|без\s+маршрут\w*|no\s+route|without\s+a\s+route|ohne\s+route|только\s+список\s+мест|places\s+without\s+a\s+route)/i.test(value);
}

/**
 * True when the current message is about the itinerary itself (duration, route, airport, or a clarification answer).
 * Other follow-ups in a trip conversation, such as "which sources are available?", must not rebuild the plan.
 */
export function isTripPlanningMessage(message: string): boolean {
  return ROUTE_WORD.test(message)
    || ITINERARY_WORD.test(message)
    || hasTripDuration(message)
    || hasResolvedRouteMode(message)
    || resolveAirportCode(message) !== null
    || isAirportOptOut(message)
    || removesSecondDay(message);
}
