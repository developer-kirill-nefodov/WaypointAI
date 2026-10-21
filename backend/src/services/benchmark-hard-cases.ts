import type { BenchmarkCase } from "./benchmark-generator.js";

/**
 * Hand-written hard cases the generator cannot produce: exonyms in Russian and German with case endings (Рим →
 * Roma, Krakau → Kraków), spellings without diacritics, mixed languages, and requests no tool serves. Every expected
 * settlement exists in the bundled OSM data. Synthetic questions, no personal data.
 */
const hard = (id: string, language: BenchmarkCase["language"], skill: BenchmarkCase["skill"], question: string, expect: BenchmarkCase["expect"]): BenchmarkCase =>
  ({ id: `hard-${id}`, language, skill, question, expect, enabled: true, origin: "hard" });

const ROMA = ["Roma", "Rome"];
const WARSZAWA = ["Warszawa", "Warsaw"];
const KRAKOW = ["Kraków", "Krakow"];
const FIRENZE = ["Firenze", "Florence"];
const BUCURESTI = ["București", "Bucharest"];
const WIEN = ["Wien", "Vienna"];

export const HARD_CASES: BenchmarkCase[] = [
  hard("ru-roma-museums", "ru", "places", "Музеи в Риме", { tool: "search_places", args: { kind: "museum", city: ROMA } }),
  hard("ru-warszawa-parks", "ru", "places", "Где погулять в парке в Варшаве?", { tool: "search_places", args: { kind: "park", city: WARSZAWA } }),
  hard("ru-krakow-cafes", "ru", "places", "Посоветуй кафе в Кракове", { tool: "search_places", args: { kind: "cafe", city: KRAKOW } }),
  hard("ru-firenze-restaurants", "ru", "places", "Рестораны во Флоренции", { tool: "search_places", args: { kind: "restaurant", city: FIRENZE } }),
  hard("ru-bucuresti-sights", "ru", "places", "Что посмотреть в Бухаресте?", { tool: "search_places", args: { city: BUCURESTI } }),
  hard("ru-wien-churches", "ru", "places", "Красивые церкви Вены", { tool: "search_places", args: { kind: "church", city: WIEN } }),
  hard("ru-paris-museums", "ru", "places", "покажи музеи парижа", { tool: "search_places", args: { kind: "museum", city: "Paris" } }),
  hard("de-roma-museums", "de", "places", "Museen in Rom", { tool: "search_places", args: { kind: "museum", city: ROMA } }),
  hard("de-warszawa-parks", "de", "places", "Parks in Warschau", { tool: "search_places", args: { kind: "park", city: WARSZAWA } }),
  hard("de-krakow-cafes", "de", "places", "Cafés in Krakau", { tool: "search_places", args: { kind: "cafe", city: KRAKOW } }),
  hard("de-firenze-sights", "de", "places", "Sehenswürdigkeiten in Florenz", { tool: "search_places", args: { city: FIRENZE } }),
  hard("de-bucuresti-hotels", "de", "places", "Hotels in Bukarest", { tool: "search_places", args: { kind: "hotel", city: BUCURESTI } }),
  hard("en-krakow-no-diacritics", "en", "places", "museums in krakow", { tool: "search_places", args: { kind: "museum", city: KRAKOW } }),
  hard("en-bucuresti-typo", "en", "places", "parks in Bucharets", { tool: "search_places", args: { kind: "park" } }),
  hard("en-mixed-language", "en", "places", "Show me музеи in Rome", { tool: "search_places", args: { kind: "museum", city: ROMA } }),
  hard("en-named-place", "en", "places", "Find the Colosseum", { tool: "search_places", args: { kind: "any" } }),
  hard("ru-norcia-week", "ru", "events", "Что трясло у Норчи на этой неделе?", { tool: "search_events", args: { place: "Norcia", hours: 168 } }),
  hard("ru-assisi-m3", "ru", "events", "Землетрясения сильнее 3 возле Ассизи за месяц", { tool: "search_events", args: { place: "Assisi", minMagnitude: 3, hours: 720 } }),
  hard("ru-perugia-day", "ru", "events", "Были толчки у Перуджи за сутки?", { tool: "search_events", args: { place: "Perugia", hours: 24 } }),
  hard("ru-spoleto-radius", "ru", "events", "Землетрясения в 20 км от Сполето", { tool: "search_events", args: { place: "Spoleto", radiusKm: 20 } }),
  hard("de-foligno", "de", "events", "Gab es Beben bei Foligno in den letzten drei Tagen?", { tool: "search_events", args: { place: "Foligno", hours: 72 } }),
  hard("en-region-only", "en", "events", "Earthquakes in Umbria this week", { tool: "search_events", args: { hours: 168 } }),
  hard("ru-whole-area-m4", "ru", "events", "Самые сильные землетрясения за месяц, магнитуда от 4", { tool: "search_events", args: { minMagnitude: 4, hours: 720 } }),
  hard("ru-trip-two-cities", "ru", "trips", "Рим на 2 дня, потом Флоренция на 1 день, на машине", { tool: "plan_trip", args: { routeMode: "driving", "cities.0.name": ROMA, "cities.1.name": FIRENZE } }),
  hard("de-trip-krakow", "de", "trips", "Ein Tag in Krakau, nur Orte, ohne Route", { tool: "plan_trip", args: { routeMode: "none", "cities.0.name": KRAKOW } }),
  hard("ru-weather", "ru", "reply", "Какая погода в Риме?", { tool: "reply" }),
  hard("en-tickets", "en", "reply", "Buy me a train ticket to Florence", { tool: "reply" }),
  hard("de-thanks", "de", "reply", "Super, danke dir!", { tool: "reply" }),
  hard("ru-licence", "ru", "sources", "Под какой лицензией данные INGV?", { tool: "list_sources" }),
];
