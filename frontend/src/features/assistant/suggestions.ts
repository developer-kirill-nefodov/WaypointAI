import type { PlaceView, RecordView, SearchArea, TripPlan } from "@waypoint-ai/shared";
import type { Language } from "../../shared/i18n";

export type SuggestedReply = { label: string; prompt: string };

/** What the last turn returned; suggestions are built from it, never from model text. */
export interface SuggestionContext {
  query: string;
  places: PlaceView[];
  records: RecordView[];
  tripPlan: TripPlan | null;
  searchArea: SearchArea | null;
}

type Text = [ru: string, en: string, de: string];

function pick(language: Language, [ru, en, de]: Text): string {
  return language === "ru" ? ru : language === "de" ? de : en;
}

function reply(language: Language, label: Text, prompt: Text): SuggestedReply {
  return { label: pick(language, label), prompt: pick(language, prompt) };
}

// Starter prompts cover every kind of request the app answers from verified data.
const STARTERS: Array<[label: Text, prompt: Text]> = [
  [["Рим и Флоренция на 3 дня", "Rome and Florence for 3 days", "Rom und Florenz für 3 Tage"],
    ["Рим и Флоренция на 3 дня на машине", "Plan 3 days in Rome and Florence by car", "Plane 3 Tage in Rom und Florenz mit dem Auto"]],
  [["Неделя по Румынии", "A week in Romania", "Eine Woche in Rumänien"],
    ["Бухарест, Брашов и Клуж на неделю на машине", "Bucharest, Brașov and Cluj for a week by car", "Bukarest, Brașov und Cluj für eine Woche mit dem Auto"]],
  [["Париж на 2 дня", "Paris for 2 days", "Paris für 2 Tage"],
    ["Париж на 2 дня на машине", "Plan 2 days in Paris by car", "Plane 2 Tage in Paris mit dem Auto"]],
  [["Землетрясения рядом с Норчей", "Earthquakes near Norcia", "Erdbeben bei Norcia"],
    ["Покажи землетрясения в радиусе 50 км от Норчи за последние 30 дней", "Show earthquakes within 50 km of Norcia in the last 30 days", "Zeige Erdbeben im Umkreis von 50 km um Norcia in den letzten 30 Tagen"]],
  [["Сильные события за неделю", "Strong events this week", "Starke Ereignisse dieser Woche"],
    ["Покажи землетрясения M2+ за последние 7 дней", "Show M2+ earthquakes in the last 7 days", "Zeige Erdbeben ab M2 in den letzten 7 Tagen"]],
  [["Музеи Берлина", "Museums in Berlin", "Museen in Berlin"],
    ["Найди музеи в Берлине", "Find museums in Berlin", "Finde Museen in Berlin"]],
  [["Кафе в Варшаве", "Cafés in Warsaw", "Cafés in Warschau"],
    ["Найди кафе в Варшаве", "Find cafés in Warsaw", "Finde Cafés in Warschau"]],
  [["Библиотеки Мадрида", "Libraries in Madrid", "Bibliotheken in Madrid"],
    ["Найди библиотеки в Мадриде", "Find libraries in Madrid", "Finde Bibliotheken in Madrid"]],
  [["Какие данные доступны?", "What data is available?", "Welche Daten gibt es?"],
    ["Какие источники данных доступны и какой период они покрывают?", "Which data sources are available, and what period do they cover?", "Welche Datenquellen sind verfügbar und welchen Zeitraum decken sie ab?"]],
  [["Что можно спросить?", "What can I ask?", "Was kann ich fragen?"],
    ["Какие вопросы можно задать по доступным данным?", "What can I ask about the available data?", "Welche Fragen kann ich zu den verfügbaren Daten stellen?"]],
];

/** Six starter prompts, shuffled per chat: stable within one chat, different between chats. */
export function starterSuggestions(language: Language, seed: string): SuggestedReply[] {
  let state = [...seed].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 7);
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 2 ** 32;
  };
  const order = STARTERS.map((starter) => ({ starter, key: random() })).sort((left, right) => left.key - right.key);
  return order.slice(0, 6).map(({ starter: [label, prompt] }) => reply(language, label, prompt));
}

/** Follow-ups for the last result, specific to its kind: a trip plan, an event search, places, or records. */
export function contextSuggestions(context: SuggestionContext, language: Language): SuggestedReply[] {
  const suggestions = context.tripPlan
    ? tripSuggestions(context.tripPlan, language)
    : context.searchArea
      ? eventSuggestions(context.searchArea, context.records, language)
      : context.places.length
        ? placeSuggestions(context.places, language)
        : context.records.length
          ? recordSuggestions(context.records, language)
          : emptySuggestions(context.query, language);
  return [...new Map(suggestions.map((suggestion) => [suggestion.prompt, suggestion])).values()].slice(0, 6);
}

function tripSuggestions(plan: TripPlan, language: Language): SuggestedReply[] {
  const cities = plan.cities?.length ? plan.cities.map((city) => city.name) : [plan.city];
  const list = joinNames(cities, language);
  const longer = Math.min(7, plan.totalDays + 1);
  const shorter = Math.max(cities.length, plan.totalDays - 1);
  const suggestions: SuggestedReply[] = [];
  if (longer > plan.totalDays) {
    suggestions.push(reply(language,
      [`На ${longer} ${dayWordRu(longer)}`, `Make it ${longer} ${days(longer)}`, `Auf ${longer} ${tage(longer)}`],
      [`${list} на ${longer} ${dayWordRu(longer)} на машине`, `Plan ${longer} ${days(longer)} in ${list} by car`, `Plane ${longer} ${tage(longer)} in ${list} mit dem Auto`]));
  }
  if (shorter < plan.totalDays) {
    suggestions.push(reply(language,
      [`Сократить до ${shorter} ${dayWordGenitiveRu(shorter)}`, `Shorten to ${shorter} ${days(shorter)}`, `Auf ${shorter} ${tage(shorter)} kürzen`],
      [`${list} на ${shorter} ${dayWordRu(shorter)} на машине`, `Plan ${shorter} ${days(shorter)} in ${list} by car`, `Plane ${shorter} ${tage(shorter)} in ${list} mit dem Auto`]));
  }
  if (cities.length > 1) {
    const only = Math.min(3, plan.totalDays);
    suggestions.push(reply(language,
      [`Только ${cities[0]}`, `Only ${cities[0]}`, `Nur ${cities[0]}`],
      [`${cities[0]} на ${only} ${dayWordRu(only)} на машине`, `Plan ${only} ${days(only)} in ${cities[0]} by car`, `Plane ${only} ${tage(only)} in ${cities[0]} mit dem Auto`]));
  }
  suggestions.push(reply(language,
    ["Только места, без маршрута", "Places only, no route", "Nur Orte, ohne Route"],
    [`${list} на ${plan.totalDays} ${dayWordRu(plan.totalDays)}, только список мест без маршрута`, `${list} for ${plan.totalDays} ${days(plan.totalDays)}, places without a route`, `${list} für ${plan.totalDays} ${tage(plan.totalDays)}, ohne Route`]));
  suggestions.push(reply(language,
    [`Музеи: ${cities[0]}`, `Museums in ${cities[0]}`, `Museen in ${cities[0]}`],
    [`Найди музеи в ${cities[0]}`, `Find museums in ${cities[0]}`, `Finde Museen in ${cities[0]}`]));
  return suggestions;
}

function eventSuggestions(area: SearchArea, records: RecordView[], language: Language): SuggestedReply[] {
  const suggestions: SuggestedReply[] = [];
  const radius = Math.round(area.radiusKm);
  const wider = Math.min(300, radius * 2);
  if (area.label) {
    const place = area.label;
    if (wider > radius) {
      suggestions.push(reply(language,
        [`Расширить до ${wider} км`, `Widen to ${wider} km`, `Auf ${wider} km erweitern`],
        [`Покажи землетрясения в радиусе ${wider} км от ${place} за последние 30 дней`, `Show earthquakes within ${wider} km of ${place} in the last 30 days`, `Zeige Erdbeben im Umkreis von ${wider} km um ${place} in den letzten 30 Tagen`]));
    }
    suggestions.push(reply(language,
      ["Только M2+", "Only M2+", "Nur ab M2"],
      [`Покажи землетрясения M2+ в радиусе ${radius} км от ${place} за последние 30 дней`, `Show M2+ earthquakes within ${radius} km of ${place} in the last 30 days`, `Zeige Erdbeben ab M2 im Umkreis von ${radius} km um ${place} in den letzten 30 Tagen`]));
    suggestions.push(reply(language,
      ["За последние 7 дней", "Last 7 days", "Letzte 7 Tage"],
      [`Покажи землетрясения в радиусе ${radius} км от ${place} за последние 7 дней`, `Show earthquakes within ${radius} km of ${place} in the last 7 days`, `Zeige Erdbeben im Umkreis von ${radius} km um ${place} in den letzten 7 Tagen`]));
    suggestions.push(reply(language,
      [`Места рядом: ${place}`, `Places in ${place}`, `Orte in ${place}`],
      [`Найди достопримечательности в ${place}`, `Find attractions in ${place}`, `Finde Sehenswürdigkeiten in ${place}`]));
  }
  const strongest = strongestEvent(records);
  if (strongest) {
    const magnitude = strongest.magnitude.toFixed(1);
    suggestions.push(reply(language,
      [`Самое сильное: M${magnitude}`, `Strongest: M${magnitude}`, `Stärkstes: M${magnitude}`],
      [`Покажи подробности записи с ID ${strongest.id}`, `Show details for record ID ${strongest.id}`, `Zeige Details zum Eintrag mit der ID ${strongest.id}`]));
  }
  return suggestions;
}

function placeSuggestions(places: PlaceView[], language: Language): SuggestedReply[] {
  const first = places[0]!;
  const city = places.find((place) => place.city)?.city ?? null;
  const category = shortCategory(first.category);
  const suggestions: SuggestedReply[] = [
    reply(language,
      [`Подробнее: ${first.name}`, `Details: ${first.name}`, `Details: ${first.name}`],
      [`Покажи адрес и подробности места «${first.name}»`, `Show the address and details for “${first.name}”`, `Zeige Adresse und Details zu „${first.name}“`]),
  ];
  if (city) {
    suggestions.push(reply(language,
      [`Маршрут на день: ${city}`, `One-day route in ${city}`, `Tagesroute in ${city}`],
      [`${city} на 1 день на машине`, `Plan 1 day in ${city} by car`, `Plane 1 Tag in ${city} mit dem Auto`]));
    if (category) {
      suggestions.push(reply(language,
        [`Ещё ${category}: ${city}`, `More ${category} in ${city}`, `Mehr ${category} in ${city}`],
        [`Найди другие места категории «${category}» в ${city}`, `Find more ${category} places in ${city}`, `Finde weitere Orte der Kategorie „${category}“ in ${city}`]));
    }
    suggestions.push(reply(language,
      [`Землетрясения рядом: ${city}`, `Earthquakes near ${city}`, `Erdbeben bei ${city}`],
      [`Покажи землетрясения в радиусе 50 км от ${city} за последние 30 дней`, `Show earthquakes within 50 km of ${city} in the last 30 days`, `Zeige Erdbeben im Umkreis von 50 km um ${city} in den letzten 30 Tagen`]));
  }
  return suggestions;
}

function recordSuggestions(records: RecordView[], language: Language): SuggestedReply[] {
  const strongest = strongestEvent(records);
  const first = strongest ? records.find((record) => record.id === strongest.id)! : records[0]!;
  const category = typeof first.attributes.category === "string" ? first.attributes.category : null;
  const suggestions: SuggestedReply[] = [
    reply(language,
      ["Подробнее о записи", "Record details", "Eintragsdetails"],
      [`Покажи подробности записи с ID ${first.id}`, `Show details for record ID ${first.id}`, `Zeige Details zum Eintrag mit der ID ${first.id}`]),
    reply(language,
      ["Только M2+ за неделю", "M2+ this week", "Ab M2 diese Woche"],
      ["Покажи землетрясения M2+ за последние 7 дней", "Show M2+ earthquakes in the last 7 days", "Zeige Erdbeben ab M2 in den letzten 7 Tagen"]),
  ];
  if (category) {
    suggestions.push(reply(language,
      [`Ещё записи: ${category}`, `More: ${category}`, `Mehr: ${category}`],
      [`Найди другие записи категории «${category}»`, `Find more records in category “${category}”`, `Finde weitere Einträge der Kategorie „${category}“`]));
  }
  return suggestions;
}

function emptySuggestions(query: string, language: Language): SuggestedReply[] {
  const shortQuery = query.replace(/\s+/g, " ").trim().slice(0, 100);
  return [
    reply(language,
      ["Какие регионы покрыты?", "Which regions are covered?", "Welche Regionen sind abgedeckt?"],
      ["Какие регионы и источники данных доступны?", "Which regions and data sources are available?", "Welche Regionen und Datenquellen sind verfügbar?"]),
    reply(language,
      ["События за неделю", "Events this week", "Ereignisse dieser Woche"],
      ["Покажи землетрясения за последние 7 дней", "Show earthquakes in the last 7 days", "Zeige Erdbeben in den letzten 7 Tagen"]),
    ...(shortQuery ? [reply(language,
      ["Почему нет результатов?", "Why no results?", "Warum keine Treffer?"],
      [`Объясни, какие данные доступны для запроса «${shortQuery}» и почему совпадений могло не быть.`, `Explain which data is available for “${shortQuery}” and why it might have no matches.`, `Erkläre, welche Daten zu „${shortQuery}“ verfügbar sind und warum es keine Treffer geben könnte.`])] : []),
    reply(language,
      ["Маршрут по Риму", "A day in Rome", "Ein Tag in Rom"],
      ["Рим на 1 день на машине", "Plan 1 day in Rome by car", "Plane 1 Tag in Rom mit dem Auto"]),
  ];
}

export function rotateSuggestions(suggestions: SuggestedReply[], offset: number): SuggestedReply[] {
  if (suggestions.length <= 2) return suggestions;
  const start = offset % suggestions.length;
  return [suggestions[start]!, suggestions[(start + 1) % suggestions.length]!];
}

function strongestEvent(records: RecordView[]): { id: string; magnitude: number } | null {
  let best: { id: string; magnitude: number } | null = null;
  for (const record of records) {
    const magnitude = record.attributes.magnitude;
    if (typeof magnitude === "number" && (!best || magnitude > best.magnitude)) best = { id: record.id, magnitude };
  }
  return best;
}

/** "tourism:museum" → "museum"; categories are OSM tags, shown without the key. */
function shortCategory(category: string | null): string | null {
  if (!category) return null;
  const value = category.split(":").at(-1)?.replace(/_/g, " ").trim();
  return value || null;
}

function joinNames(names: string[], language: Language): string {
  if (names.length <= 1) return names[0] ?? "";
  const and = language === "ru" ? "и" : language === "de" ? "und" : "and";
  return `${names.slice(0, -1).join(", ")} ${and} ${names.at(-1)}`;
}

function dayWordRu(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "дней";
  if (last === 1) return "день";
  if (last >= 2 && last <= 4) return "дня";
  return "дней";
}

/** "до 1 дня", "до 2 дней": the count after «до» takes the genitive. */
function dayWordGenitiveRu(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? "дня" : "дней";
}

function days(count: number): string {
  return count === 1 ? "day" : "days";
}

function tage(count: number): string {
  return count === 1 ? "Tag" : "Tage";
}
