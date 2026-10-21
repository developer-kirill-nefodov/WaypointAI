import type { RouterTool } from "../../assistant/router.js";

/**
 * Topics the teacher writes examples for: each one aims at a skill of the router, with instructions for the teacher
 * and the tools an example of the topic may call. Settlements are taken from the database, so every city an example
 * names can be checked against the import.
 */
export type TeacherLanguage = "ru" | "en" | "de";
export const TEACHER_LANGUAGES: TeacherLanguage[] = ["ru", "en", "de"];

export interface TeacherTopic {
  id: string;
  title: Record<TeacherLanguage, string>;
  description: Record<TeacherLanguage, string>;
  tools: RouterTool[];
  /** Which settlements the prompt lists: any city, or towns in the region the earthquake data covers. */
  settlements: "cities" | "eventTowns" | "both" | "none";
  brief: string;
}

export const TEACHER_TOPICS: TeacherTopic[] = [
  {
    id: "exonyms",
    title: { ru: "Названия городов", en: "City names", de: "Städtenamen" },
    description: {
      ru: "Города по-русски и по-немецки, в падежах (в Кракове, у Вены) — ответ всегда с местным написанием.",
      en: "Cities named in Russian and German, inflected (в Кракове, in Wien) — the answer always uses the local spelling.",
      de: "Städte auf Russisch und Deutsch, dekliniert — die Antwort nutzt immer die lokale Schreibweise.",
    },
    tools: ["search_places", "plan_trip", "search_events"],
    settlements: "both",
    brief: `Teach the router to map a city written in the user's language (Russian or German exonyms, inflected forms such as "в Кракове", "из Вены", "nach Rom", "in Mailand", or an English name) to its LOCAL spelling exactly as listed (Kraków, Wien, Roma, Milano). Prefer cities whose name differs between languages. Mix search_places and plan_trip, and search_events only for towns from the earthquake list.`,
  },
  {
    id: "places",
    title: { ru: "Места", en: "Places", de: "Orte" },
    description: {
      ru: "Поиск мест: разные виды, разговорный стиль, опечатки, одно конкретное место по названию.",
      en: "Finding places: different kinds, casual wording, typos, one named place.",
      de: "Ortssuche: verschiedene Arten, Umgangssprache, Tippfehler, ein benannter Ort.",
    },
    tools: ["search_places"],
    settlements: "cities",
    brief: `search_places only. Vary the wording: casual, polite, short, with small typos, questions and commands. Use many different kinds; use kind "any" with the place's name in query when the user names one specific place (a cathedral, a square). Omit city when the user names none.`,
  },
  {
    id: "events",
    title: { ru: "Землетрясения", en: "Earthquakes", de: "Erdbeben" },
    description: {
      ru: "Периоды («за сутки», «на этой неделе»), радиусы, магнитуды, «здесь» на карте.",
      en: "Periods (\"last day\", \"this week\"), radii, magnitudes, \"here\" on the map.",
      de: "Zeiträume, Radien, Magnituden, „hier“ auf der Karte.",
    },
    tools: ["search_events"],
    settlements: "eventTowns",
    brief: `search_events only. Convert periods to hours (a day 24, 2 days 48, 3 days 72, a week 168, two weeks 336, a month 720). Add radiusKm, minMagnitude or maxMagnitude only when stated. For "here", "this point", "around the selected spot" use nearSelection true and no place. For a country or region (Italy, Umbria) omit place.`,
  },
  {
    id: "trips",
    title: { ru: "Поездки", en: "Trips", de: "Reisen" },
    description: {
      ru: "Планы на несколько городов, дни на каждый город и всего, маршрут на машине.",
      en: "Plans across several cities, days per city and in total, driving routes.",
      de: "Pläne über mehrere Städte, Tage pro Stadt und insgesamt, Autorouten.",
    },
    tools: ["plan_trip"],
    settlements: "cities",
    brief: `plan_trip only. One to four cities in the order the user gives them. days per city only when stated for that city; totalDays when the user gives only a total. routeMode "driving" when the user mentions a car or driving, "none" when the user asks for places without a route; otherwise omit it.`,
  },
  {
    id: "chat",
    title: { ru: "Источники и разговор", en: "Sources and chat", de: "Quellen und Gespräch" },
    description: {
      ru: "Отличить вопрос про данные и лицензии от приветствия, благодарности и посторонних тем.",
      en: "Tell questions about data and licences from greetings, thanks, and unrelated topics.",
      de: "Fragen zu Daten und Lizenzen von Grüßen, Dank und anderen Themen unterscheiden.",
    },
    tools: ["list_sources", "reply"],
    settlements: "none",
    brief: `list_sources for questions about where the data comes from, which sources, licences, attribution, how fresh the data is. reply for greetings, thanks, small talk, what the assistant can do, and requests no tool serves (weather, translations, jokes). Both take empty args {}. About half of each.`,
  },
  {
    id: "mixed",
    title: { ru: "Сложные запросы", en: "Hard requests", de: "Schwierige Anfragen" },
    description: {
      ru: "Длинные сообщения, смесь языков, лишние детали, похожие на другой инструмент.",
      en: "Long messages, mixed languages, extra details, requests that look like another tool.",
      de: "Lange Nachrichten, gemischte Sprachen, Nebendetails, verwechselbare Anfragen.",
    },
    tools: ["search_places", "search_events", "plan_trip", "list_sources", "reply"],
    settlements: "both",
    brief: `Hard cases for every tool: long messages with irrelevant context, a sentence that mixes languages, a trip request that mentions museums (still plan_trip), a museum question that mentions a trip (still search_places), earthquakes mentioned in passing in small talk (reply). The answer is the one call that serves the main request.`,
  },
];

export const TOPIC_IDS = TEACHER_TOPICS.map((topic) => topic.id) as [string, ...string[]];
export const findTopic = (id: string) => TEACHER_TOPICS.find((topic) => topic.id === id) ?? null;
