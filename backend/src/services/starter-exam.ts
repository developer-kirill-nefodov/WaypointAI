import type { ExamCase } from "./eval-checks.js";

/**
 * A starter exam over what the assistant does: place search, event search, sources, plain replies, and trip plans,
 * in Russian, English, and German. Cities are from the bundled or commonly imported OSM areas. The questions are
 * synthetic and contain no personal data. Loading them again adds only the missing ones.
 */
export const STARTER_EXAM: ExamCase[] = [
  { id: "starter-places-krakow-museums-ru", question: "Найди музеи в Кракове", language: "ru", enabled: true, expect: { tool: "search_places", args: { kind: "museum", city: "Kraków" }, citations: true } },
  { id: "starter-places-warszawa-parks-en", question: "Find parks in Warsaw", language: "en", enabled: true, expect: { tool: "search_places", args: { kind: "park", city: "Warszawa" }, citations: true } },
  { id: "starter-places-roma-museums-de", question: "Zeig mir Museen in Rom", language: "de", enabled: true, expect: { tool: "search_places", args: { kind: "museum", city: "Roma" }, citations: true } },
  { id: "starter-places-krakow-cafes-ru", question: "Где выпить кофе в Кракове?", language: "ru", enabled: true, expect: { tool: "search_places", args: { kind: "cafe", city: "Kraków" } } },
  { id: "starter-events-norcia-3days-ru", question: "Какие землетрясения были у Норчи за последние 3 дня?", language: "ru", enabled: true, expect: { tool: "search_events", args: { place: "Norcia", hours: 72 }, citeEachEvent: true } },
  { id: "starter-events-norcia-m3-en", question: "Earthquakes above magnitude 3 within 50 km of Norcia this month", language: "en", enabled: true, expect: { tool: "search_events", args: { place: "Norcia", radiusKm: 50, minMagnitude: 3 }, citations: true } },
  { id: "starter-events-m4-month-ru", question: "Землетрясения сильнее 4 за последние 30 дней", language: "ru", enabled: true, expect: { tool: "search_events", args: { minMagnitude: 4, hours: 720 }, citations: true, citeEachEvent: true } },
  { id: "starter-events-confirmed-en", question: "Are this week's earthquakes near Norcia confirmed by another catalogue?", language: "en", enabled: true, expect: { tool: "search_events", args: { place: "Norcia", hours: 168 } } },
  { id: "starter-sources-en", question: "Which data sources are available?", language: "en", enabled: true, expect: { tool: "list_sources" } },
  { id: "starter-reply-hello-ru", question: "Привет! Что ты умеешь?", language: "ru", enabled: true, expect: { tool: "reply", maxSentences: 5 } },
  { id: "starter-reply-hello-de", question: "Hallo, was kannst du?", language: "de", enabled: true, expect: { tool: "reply", maxSentences: 5 } },
  { id: "starter-trip-roma-driving-en", question: "Plan 2 days in Rome with a driving route", language: "en", enabled: true, expect: { tool: "plan_trip", args: { routeMode: "driving" } } },
];
