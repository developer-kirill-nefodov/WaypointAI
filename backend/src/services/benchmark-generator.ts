import type { ExamCase } from "./eval-checks.js";

/**
 * Generates benchmark cases from the local database, so the right tool call of every case is known: a template in one
 * language, a real settlement from the imported OSM data, and the arguments the assistant must pass. A city may be
 * named by its local or its English name; both resolve to the same settlement, so both are accepted.
 */
export type Skill = "places" | "events" | "trips" | "sources" | "reply" | "other";
export type BenchmarkCase = ExamCase & {
  skill: Skill;
  origin: "generated" | "hard";
  /** The exact right call (local city names), used as the target of a training example. */
  target?: { tool: string; args: Record<string, unknown> };
};
export interface Settlement { name: string; nameEn: string | null; countryCode: string | null }

type Language = "ru" | "en" | "de";

/** Kinds of places the assistant knows (tools/assistant-tools.ts PLACE_KINDS), in each language. */
export const KINDS: Record<string, Record<Language, string>> = {
  museum: { ru: "музеи", en: "museums", de: "Museen" },
  park: { ru: "парки", en: "parks", de: "Parks" },
  restaurant: { ru: "рестораны", en: "restaurants", de: "Restaurants" },
  cafe: { ru: "кафе", en: "cafés", de: "Cafés" },
  castle: { ru: "замки", en: "castles", de: "Burgen" },
  church: { ru: "церкви", en: "churches", de: "Kirchen" },
  viewpoint: { ru: "смотровые площадки", en: "viewpoints", de: "Aussichtspunkte" },
  hotel: { ru: "отели", en: "hotels", de: "Hotels" },
  gallery: { ru: "галереи", en: "art galleries", de: "Galerien" },
  theatre: { ru: "театры", en: "theatres", de: "Theater" },
  bar: { ru: "бары", en: "bars", de: "Bars" },
  monument: { ru: "памятники", en: "monuments", de: "Denkmäler" },
};

const PLACE_TEMPLATES: Record<Language, string[]> = {
  ru: ["Найди {kind} в {city}", "Покажи {kind} в городе {city}", "Какие есть {kind} в {city}?", "Хочу посмотреть {kind} в {city}"],
  en: ["Find {kind} in {city}", "Show me {kind} in {city}", "Are there any {kind} in {city}?", "What {kind} are there in {city}?"],
  de: ["Finde {kind} in {city}", "Zeig mir {kind} in {city}", "Gibt es {kind} in {city}?", "Welche {kind} gibt es in {city}?"],
};

const PERIODS: Array<{ hours: number; text: Record<Language, string> }> = [
  { hours: 24, text: { ru: "за последние сутки", en: "in the last 24 hours", de: "in den letzten 24 Stunden" } },
  { hours: 72, text: { ru: "за последние 3 дня", en: "in the last 3 days", de: "in den letzten 3 Tagen" } },
  { hours: 168, text: { ru: "за последнюю неделю", en: "in the last week", de: "in der letzten Woche" } },
  { hours: 720, text: { ru: "за последние 30 дней", en: "in the last 30 days", de: "in den letzten 30 Tagen" } },
];

const EVENT_TEMPLATES: Record<Language, string[]> = {
  ru: ["Землетрясения{magnitude} в радиусе {radius} км от {town} {period}", "Были ли землетрясения{magnitude} возле {town} {period}? Радиус {radius} км"],
  en: ["Earthquakes{magnitude} within {radius} km of {town} {period}", "Were there any earthquakes{magnitude} near {town} {period}? Use a {radius} km radius"],
  de: ["Erdbeben{magnitude} im Umkreis von {radius} km um {town} {period}", "Gab es Erdbeben{magnitude} bei {town} {period}? Radius {radius} km"],
};
const MAGNITUDE_TEXT: Record<Language, (value: number) => string> = {
  ru: (value) => ` сильнее ${value}`,
  en: (value) => ` above magnitude ${value}`,
  de: (value) => ` über Magnitude ${value}`,
};

const TRIP_TEMPLATES: Record<Language, Record<"driving" | "none", string>> = {
  ru: { driving: "Составь план поездки в {city} на {days} с маршрутом на машине", none: "Составь план на {days} в {city}, только места, без маршрута" },
  en: { driving: "Plan {days} in {city} with a driving route", none: "Plan {days} in {city}, places only, no route" },
  de: { driving: "Plane {days} in {city} mit einer Autoroute", none: "Plane {days} in {city}, nur Orte, ohne Route" },
};
const DAYS: Record<Language, (days: number) => string> = {
  ru: (days) => (days === 1 ? "1 день" : `${days} дня`),
  en: (days) => (days === 1 ? "1 day" : `${days} days`),
  de: (days) => (days === 1 ? "1 Tag" : `${days} Tage`),
};

const SOURCE_QUESTIONS: Record<Language, string[]> = {
  ru: ["Какие источники данных доступны?", "Откуда берутся данные о землетрясениях?", "Какие у данных лицензии?"],
  en: ["Which data sources are available?", "Where does the earthquake data come from?", "What licences do the data sources have?"],
  de: ["Welche Datenquellen gibt es?", "Woher stammen die Erdbebendaten?", "Welche Lizenzen haben die Datenquellen?"],
};

const REPLY_QUESTIONS: Record<Language, string[]> = {
  ru: ["Привет!", "Что ты умеешь?", "Спасибо, это всё", "Кто ты?"],
  en: ["Hello!", "What can you do?", "Thanks, that's all", "Who are you?"],
  de: ["Hallo!", "Was kannst du?", "Danke, das war's", "Wer bist du?"],
};

/** Deterministic pseudo-random numbers, so the same seed and data give the same benchmark. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Names the assistant may pass for a settlement: the local name, and the English one when it differs. */
function cityNames(settlement: Settlement): string[] {
  return [...new Set([settlement.name, settlement.nameEn].filter((name): name is string => Boolean(name)))];
}

/** How a person names the city in the question: in English with the English name, otherwise mostly the local one. */
function cityInQuestion(settlement: Settlement, language: Language, next: () => number): string {
  return language === "en" && settlement.nameEn && next() < 0.7 ? settlement.nameEn : settlement.name;
}

const slug = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);

export interface GeneratorInput {
  /** Cities for place and trip questions. */
  cities: Settlement[];
  /** Towns in the area with imported events, for event questions. */
  eventTowns: Settlement[];
  seed: number;
  /** Cases per skill; places get twice as many, since they are most of the traffic. */
  perSkill: number;
}

export function generateBenchmark(input: GeneratorInput): BenchmarkCase[] {
  // A question names a city as a traveller would: in Latin script (a few border towns carry a Cyrillic local name).
  const latin = (settlement: Settlement) => !/\p{Script=Cyrillic}/u.test(settlement.name);
  input = { ...input, cities: input.cities.filter(latin), eventTowns: input.eventTowns.filter(latin) };
  const next = random(input.seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const languages: Language[] = ["ru", "en", "de"];
  const cases: BenchmarkCase[] = [];
  const add = (skill: Skill, language: Language, question: string, expect: ExamCase["expect"], targetArgs: Record<string, unknown> = {}) => {
    const id = `gen-${skill}-${language}-${slug(question)}-${cases.length}`.slice(0, 80);
    cases.push({ id, question, language, skill, origin: "generated", enabled: true, expect, target: { tool: expect.tool!, args: targetArgs } });
  };

  if (input.cities.length) {
    for (let index = 0; index < input.perSkill * 2; index += 1) {
      const language = languages[index % 3]!;
      const city = pick(input.cities);
      const kind = pick(Object.keys(KINDS));
      const question = pick(PLACE_TEMPLATES[language]).replace("{kind}", KINDS[kind]![language]).replace("{city}", cityInQuestion(city, language, next));
      add("places", language, question, { tool: "search_places", args: { kind, city: cityNames(city) } }, { kind, city: city.name });
    }
    for (let index = 0; index < input.perSkill; index += 1) {
      const language = languages[index % 3]!;
      const city = pick(input.cities);
      const mode = next() < 0.5 ? "driving" : "none";
      const days = 1 + Math.floor(next() * 3);
      const question = TRIP_TEMPLATES[language][mode].replace("{city}", cityInQuestion(city, language, next)).replace("{days}", DAYS[language](days));
      add("trips", language, question, { tool: "plan_trip", args: { routeMode: mode, "cities.0.name": cityNames(city) } }, { cities: [{ name: city.name, days }], routeMode: mode });
    }
  }
  if (input.eventTowns.length) {
    for (let index = 0; index < input.perSkill; index += 1) {
      const language = languages[index % 3]!;
      const town = pick(input.eventTowns);
      const period = pick(PERIODS);
      const radius = pick([10, 20, 30, 50, 100]);
      const magnitude = next() < 0.4 ? pick([2, 3, 4]) : null;
      const question = pick(EVENT_TEMPLATES[language])
        .replace("{town}", town.name)
        .replace("{radius}", String(radius))
        .replace("{period}", period.text[language])
        .replace("{magnitude}", magnitude === null ? "" : MAGNITUDE_TEXT[language](magnitude));
      const eventArgs = { radiusKm: radius, hours: period.hours, ...(magnitude === null ? {} : { minMagnitude: magnitude }) };
      add("events", language, question, { tool: "search_events", args: { place: cityNames(town), ...eventArgs } }, { place: town.name, ...eventArgs });
    }
  }
  for (const language of languages) {
    for (const question of SOURCE_QUESTIONS[language]) add("sources", language, question, { tool: "list_sources" });
    for (const question of REPLY_QUESTIONS[language]) add("reply", language, question, { tool: "reply" });
  }
  return cases;
}
