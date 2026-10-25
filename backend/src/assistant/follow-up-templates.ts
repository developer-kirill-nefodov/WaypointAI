import type { SuggestedRequest } from "@waypoint-ai/shared";
import { KIND_LABELS } from "./place-results-message.js";

type Language = "en" | "ru" | "de";

/**
 * What a completed turn did, in the terms its follow-ups are written from. Every value comes from the turn's
 * validated tool calls and results, not from the model's text.
 */
export type FollowUpFacts =
  | { topic: "places"; city: string | null; kind: string | null; shown: number; total: number; offset: number }
  | { topic: "trip"; days: number; travelMode: "driving" | "none" }
  | { topic: "events"; place: string | null; radiusKm: number | null; hours: number | null; minMagnitude: number | null }
  | { topic: "other" };

/** The kind offered after a search of another kind: something a visitor of the same city looks for next. */
const NEXT_KIND: Record<string, string> = {
  attraction: "museum", museum: "park", gallery: "museum", viewpoint: "park", monument: "museum", castle: "museum",
  church: "museum", theatre: "restaurant", park: "cafe", restaurant: "cafe", cafe: "park", bar: "restaurant",
  hotel: "restaurant", any: "attraction",
};

const pick = (language: Language, ru: string, en: string, de: string) => (language === "ru" ? ru : language === "de" ? de : en);
const kindLabel = (kind: string, language: Language) => {
  const [ru, en, de] = KIND_LABELS[kind] ?? KIND_LABELS.any!;
  return pick(language, ru, en, de);
};
const capitalized = (value: string) => value.charAt(0).toLocaleUpperCase() + value.slice(1);

/**
 * Follow-up requests built on the server right after a turn, so they arrive with the answer. Each one is a request
 * the app can carry out with the same tools (the next page of a search, a route through its places, a plan edit, the
 * same earthquake search with another magnitude or period), and its prompt names the city or place it is about, so
 * it works on its own.
 */
export function templateFollowUps(facts: FollowUpFacts, language: Language): SuggestedRequest[] {
  if (facts.topic === "places") return placeFollowUps(facts, language).slice(0, 3);
  if (facts.topic === "trip") return tripFollowUps(facts, language).slice(0, 3);
  if (facts.topic === "events") return eventFollowUps(facts, language).slice(0, 3);
  return [];
}

function placeFollowUps(facts: Extract<FollowUpFacts, { topic: "places" }>, language: Language): SuggestedRequest[] {
  const kind = facts.kind && KIND_LABELS[facts.kind] ? facts.kind : "any";
  const what = kindLabel(kind === "any" ? "attraction" : kind, language);
  const city = facts.city;
  const items: SuggestedRequest[] = [];
  if (city && facts.shown > 0 && facts.offset + facts.shown < facts.total) {
    items.push({
      label: pick(language, `Ещё ${what}`, `More ${what}`, `Weitere ${what}`),
      prompt: pick(language, `Покажи ещё ${what} в ${city}, кроме уже показанных`, `Show more ${what} in ${city} besides those already listed`, `Zeig weitere ${what} in ${city} außer den schon gezeigten`),
    });
  }
  if (facts.shown >= 2) {
    items.push({
      label: pick(language, "Маршрут по этим местам", "Route through these places", "Route durch diese Orte"),
      prompt: pick(language, "Построй маршрут на машине по найденным местам", "Build a driving route through the found places", "Plane eine Autoroute durch die gefundenen Orte"),
    });
  }
  if (city) {
    const next = kindLabel(NEXT_KIND[kind] ?? "attraction", language);
    items.push({
      label: pick(language, `${capitalized(next)} в ${city}`, `${capitalized(next)} in ${city}`, `${capitalized(next)} in ${city}`),
      prompt: pick(language, `Найди ${next} в ${city}`, `Find ${next} in ${city}`, `Finde ${next} in ${city}`),
    });
    items.push({
      label: pick(language, "План на 2 дня", "2-day plan", "Plan für 2 Tage"),
      prompt: pick(language, `Составь план по ${city} на 2 дня на машине`, `Plan 2 days in ${city} by car`, `Plane 2 Tage in ${city} mit dem Auto`),
    });
  }
  return items;
}

function tripFollowUps(facts: Extract<FollowUpFacts, { topic: "trip" }>, language: Language): SuggestedRequest[] {
  const items: SuggestedRequest[] = [{
    label: pick(language, "Музей в день 1", "A museum on day 1", "Ein Museum an Tag 1"),
    prompt: pick(language, "Добавь музей в первый день", "Add a museum to day 1", "Füge an Tag 1 ein Museum hinzu"),
  }];
  if (facts.days < 7) {
    items.push({
      label: pick(language, "Ещё один день", "One more day", "Noch ein Tag"),
      prompt: pick(language, "Добавь ещё один день с парками", "Add one more day with parks", "Füge noch einen Tag mit Parks hinzu"),
    });
  }
  items.push(facts.travelMode === "driving"
    ? { label: pick(language, "Только места", "Places only", "Nur Orte"), prompt: pick(language, "Убери маршрут, оставь только места", "Remove the route, keep the places only", "Entferne die Route, nur die Orte") }
    : { label: pick(language, "С маршрутом", "With a route", "Mit Route"), prompt: pick(language, "Построй маршрут на машине для каждого дня", "Add a driving route for each day", "Plane für jeden Tag eine Autoroute") });
  return items;
}

function eventFollowUps(facts: Extract<FollowUpFacts, { topic: "events" }>, language: Language): SuggestedRequest[] {
  const hours = facts.hours ?? 168;
  const period = periodText(hours, language);
  const where = facts.place
    ? facts.radiusKm ? pick(language, ` в радиусе ${facts.radiusKm} км от ${facts.place}`, ` within ${facts.radiusKm} km of ${facts.place}`, ` im Umkreis von ${facts.radiusKm} km um ${facts.place}`)
      : pick(language, ` возле ${facts.place}`, ` near ${facts.place}`, ` bei ${facts.place}`)
    : "";
  const quakes = pick(language, "Землетрясения", "Earthquakes", "Erdbeben");
  const items: SuggestedRequest[] = [];
  if ((facts.minMagnitude ?? 0) < 3) {
    items.push({
      label: pick(language, "Только M3+", "M3+ only", "Nur ab M3"),
      prompt: pick(language, `${quakes} магнитудой от 3${where} ${period}`, `${quakes} of magnitude 3 or more${where} ${period}`, `${quakes} ab Magnitude 3${where} ${period}`),
    });
  }
  const longer = hours < 720 ? 720 : hours < 2160 ? 2160 : null;
  if (longer) {
    items.push({
      label: pick(language, longer === 720 ? "За 30 дней" : "За 90 дней", longer === 720 ? "Last 30 days" : "Last 90 days", longer === 720 ? "Letzte 30 Tage" : "Letzte 90 Tage"),
      prompt: `${quakes}${where} ${periodText(longer, language)}`,
    });
  }
  items.push({
    label: pick(language, "Самое сильное", "The strongest", "Das stärkste"),
    prompt: pick(language, `Самое сильное землетрясение${where} ${period}`, `The strongest earthquake${where} ${period}`, `Das stärkste Erdbeben${where} ${period}`),
  });
  items.push({
    label: pick(language, "Сверка INGV и USGS", "INGV vs USGS", "INGV und USGS"),
    prompt: pick(language, `Подтверждают ли INGV и USGS землетрясения${where} ${period}?`, `Do INGV and USGS agree on the earthquakes${where} ${period}?`, `Stimmen INGV und USGS bei den Erdbeben${where} ${period} überein?`),
  });
  return items;
}

/** "за последние 7 дней" for a period in hours; whole days above a day. */
function periodText(hours: number, language: Language): string {
  if (hours <= 24) return pick(language, "за последние 24 часа", "in the last 24 hours", "in den letzten 24 Stunden");
  const days = Math.round(hours / 24);
  return pick(language, `за последние ${days} ${days % 10 === 1 && days % 100 !== 11 ? "день" : days % 10 >= 2 && days % 10 <= 4 && (days % 100 < 12 || days % 100 > 14) ? "дня" : "дней"}`, `in the last ${days} days`, `in den letzten ${days} Tagen`);
}
