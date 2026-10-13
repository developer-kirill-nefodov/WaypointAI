import type { ResolvedPlace } from "../data/settlement.repository.js";
import { parseTripDuration } from "./trip-clarification.js";

const MAX_CITY_CANDIDATES = 8;
export const MAX_TRIP_CITIES = 5;
const MAX_TRIP_DAYS = 7;
const DAY_COUNT_WINDOW = 28;

/**
 * Russian and German names of settlements in the imported regions; OSM rows carry only the local and
 * English names. Stems allow Russian case endings ("в Риме", "во Флоренции").
 */
const CITY_EXONYMS: Array<[RegExp, string]> = [
  [/(?<!\p{L})рим(?:а|е|у|ом)?(?!\p{L})|(?<!\p{L})rom(?!\p{L})/iu, "Roma"],
  [/(?<!\p{L})флоренц(?:ия|ии|ию|ией)(?!\p{L})|(?<!\p{L})florenz(?!\p{L})/iu, "Firenze"],
  [/(?<!\p{L})сиен(?:а|ы|е|у|ой)(?!\p{L})/iu, "Siena"],
  [/(?<!\p{L})пиз(?:а|ы|е|у|ой)(?!\p{L})/iu, "Pisa"],
  [/(?<!\p{L})перудж(?:а|и|е|у|ей)(?!\p{L})/iu, "Perugia"],
  [/(?<!\p{L})ассизи(?!\p{L})/iu, "Assisi"],
  [/(?<!\p{L})анкон(?:а|ы|е|у|ой)(?!\p{L})/iu, "Ancona"],
  [/(?<!\p{L})лукк(?:а|и|е|у|ой)(?!\p{L})/iu, "Lucca"],
  [/(?<!\p{L})ареццо(?!\p{L})/iu, "Arezzo"],
  [/(?<!\p{L})орвието(?!\p{L})/iu, "Orvieto"],
  [/(?<!\p{L})сполето(?!\p{L})/iu, "Spoleto"],
  [/(?<!\p{L})норч(?:а|и|е|у|ей)(?!\p{L})/iu, "Norcia"],
  [/(?<!\p{L})витербо(?!\p{L})/iu, "Viterbo"],
  [/(?<!\p{L})ливорно(?!\p{L})/iu, "Livorno"],
  [/(?<!\p{L})урбино(?!\p{L})/iu, "Urbino"],
  [/(?<!\p{L})брашов(?:а|е|у|ом)?(?!\p{L})|(?<!\p{L})kronstadt(?!\p{L})/iu, "Brașov"],
  [/(?<!\p{L})клуж(?:а|е|у|ем)?(?:-напок\p{L}*)?(?!\p{L})/iu, "Cluj-Napoca"],
  [/(?<!\p{L})сибиу(?!\p{L})|(?<!\p{L})hermannstadt(?!\p{L})/iu, "Sibiu"],
  [/(?<!\p{L})констанц(?:а|ы|е|у|ей)(?!\p{L})/iu, "Constanța"],
  [/(?<!\p{L})тимишоар(?:а|ы|е|у|ой)(?!\p{L})|(?<!\p{L})timisoara(?!\p{L})/iu, "Timișoara"],
  [/(?<!\p{L})ясс(?:ы|ах|ам)(?!\p{L})|(?<!\p{L})iasi(?!\p{L})/iu, "Iași"],
  [/(?<!\p{L})сина(?:я|и|е|ю|ей)(?!\p{L})/iu, "Sinaia"],
  [/(?<!\p{L})бухарест(?:а|е|у|ом)?(?!\p{L})|(?<!\p{L})bucuresti(?!\p{L})|(?<!\p{L})bukarest(?!\p{L})/iu, "București"],
  [/(?<!\p{L})версал(?:ь|я|е|ю|ем)(?!\p{L})/iu, "Versailles"],
  [/(?<!\p{L})фонтенбло(?!\p{L})/iu, "Fontainebleau"],
  [/(?<!\p{L})париж(?:а|е|у|ем)?(?!\p{L})/iu, "Paris"],
  [/(?<!\p{L})мадрид(?:а|е|у|ом)?(?!\p{L})/iu, "Madrid"],
  [/(?<!\p{L})аранхуэс(?:а|е)?(?!\p{L})/iu, "Aranjuez"],
  [/(?<!\p{L})берлин(?:а|е|у|ом)?(?!\p{L})/iu, "Berlin"],
  [/(?<!\p{L})варшав(?:а|ы|е|у|ой)(?!\p{L})|(?<!\p{L})warschau(?!\p{L})/iu, "Warszawa"],
  [/(?<!\p{L})радом(?:а|е|у)?(?!\p{L})/iu, "Radom"],
  [/(?<!\p{L})плоцк(?:а|е|у)?(?!\p{L})|(?<!\p{L})plock(?!\p{L})/iu, "Płock"],
];

// Capitalized words that start sentences or name the trip itself, never settlements.
const NOT_A_CITY = new Set([
  "plan", "show", "make", "build", "create", "trip", "day", "days", "i", "we", "my", "please", "hi", "hello", "yes", "no",
  "route", "visit", "travel", "museum", "museums", "and", "then", "with", "for", "in", "to", "the", "a", "an",
  "mache", "zeige", "erstelle", "reise", "tag", "tage", "ich", "wir", "und", "dann", "nach", "bitte", "ja", "nein",
  "italy", "italia", "germany", "france", "spain", "poland", "romania", "europe",
]);

// Latin capitalized names, including multi-word ("Ascoli Piceno", "Alcalá de Henares") and hyphenated ones.
const LATIN_NAME = /(?<![\p{L}\d])[A-ZÀ-ÖØ-ÞĂÂÎȘȚŁŚŻŹĆŃ][\p{L}'’.-]+(?:\s+(?:(?:de|di|del|della|la|le|sur|am|an|der)\s+)?[A-ZÀ-ÖØ-ÞĂÂÎȘȚŁŚŻŹĆŃ][\p{L}'’.-]+)*/gu;

export interface TripCity extends ResolvedPlace {
  /** Index of the first mention in the joined text, used for ordering and per-city day counts. */
  mentionIndex: number;
  mentionLength: number;
}

type Candidate = { name: string; index: number; length: number; viaExonym: boolean };

/** Candidate settlement names in order of appearance: exonyms first resolved to local names, then Latin names. */
export function extractCityCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [pattern, name] of CITY_EXONYMS) {
    const match = pattern.exec(text);
    if (match) candidates.push({ name, index: match.index, length: match[0].length, viaExonym: true });
  }
  for (const match of text.matchAll(LATIN_NAME)) {
    const phrase = match[0].replace(/[.'’-]+$/, "");
    const words = phrase.split(/\s+/);
    if (words.length === 1 && NOT_A_CITY.has(phrase.toLowerCase())) continue;
    candidates.push({ name: phrase, index: match.index ?? 0, length: phrase.length, viaExonym: false });
    // Also try single words of an unresolved phrase such as "Rome Florence".
    if (words.length > 1) {
      let offset = match.index ?? 0;
      for (const word of words) {
        const at = text.indexOf(word, offset);
        offset = at + word.length;
        if (!NOT_A_CITY.has(word.toLowerCase()) && /^\p{Lu}/u.test(word)) {
          candidates.push({ name: word, index: at, length: word.length, viaExonym: false });
        }
      }
    }
  }
  return candidates.sort((left, right) => left.index - right.index);
}

/**
 * Resolves the trip's cities to verified OSM settlements, in order of first mention.
 * Names found only as Latin words must resolve to a city or town; exonyms may resolve to any settlement.
 */
export async function resolveTripCities(
  text: string,
  resolveSettlement: (name: string) => Promise<ResolvedPlace | null>,
): Promise<TripCity[]> {
  const cities = new Map<string, TripCity>();
  const covered: Array<[number, number]> = [];
  // Every candidate is a database lookup, so their number is capped and they are resolved in parallel.
  const candidates = extractCityCandidates(text).slice(0, MAX_CITY_CANDIDATES);
  const places = await Promise.all(candidates.map((candidate) => resolveSettlement(candidate.name)));
  for (const [index, candidate] of candidates.entries()) {
    if (cities.size >= MAX_TRIP_CITIES) break;
    // Skip words inside a phrase that already resolved ("Ascoli" after "Ascoli Piceno").
    if (covered.some(([start, end]) => candidate.index >= start && candidate.index < end)) continue;
    const place = places[index];
    if (!place) continue;
    const settlementType = place.category === "place:city" || place.category === "place:town";
    if (!candidate.viaExonym && (!settlementType || place.match === "approximate")) continue;
    covered.push([candidate.index, candidate.index + candidate.length]);
    if (!cities.has(place.id)) cities.set(place.id, { ...place, mentionIndex: candidate.index, mentionLength: candidate.length });
  }
  return [...cities.values()].sort((left, right) => left.mentionIndex - right.mentionIndex);
}

/**
 * Days per city: explicit counts next to a city ("2 days in Roma", "в Риме 2 дня") are kept; remaining days are
 * shared evenly in mention order. Every city gets at least one day and the total is capped at seven.
 */
export function allocateTripDays(
  text: string,
  cities: Array<Pick<TripCity, "mentionIndex" | "mentionLength">>,
  requestedTotal: number | null,
): number[] {
  const found = cities.map((city) => explicitDaysNear(text, city));
  // "5 days in Rome and Florence" / "Rome and Florence for 5 days": a single count before the first city or after
  // the last city of a list is the trip total, not that city's share.
  const counted = found.flatMap((item, index) => (item ? [{ ...item, index }] : []));
  const single = counted.length === 1 && cities.length > 1 ? counted[0]! : null;
  const isTotal = Boolean(single && (
    (single.index === 0 && single.position === "before")
    || (single.index === cities.length - 1 && single.position === "after")
  ));
  if (isTotal) requestedTotal = single!.days;
  const explicit = found.map((item) => (isTotal ? null : item?.days ?? null));
  const explicitSum = explicit.reduce<number>((sum, days) => sum + (days ?? 0), 0);
  const open = explicit.filter((days) => days === null).length;
  const total = Math.min(MAX_TRIP_DAYS, Math.max(
    cities.length,
    open === 0 ? explicitSum : Math.max(requestedTotal ?? 0, explicitSum + open),
  ));
  let remaining = Math.max(open, total - explicitSum);
  const perOpen = open ? Math.floor(remaining / open) : 0;
  let extra = open ? remaining - perOpen * open : 0;
  const days = explicit.map((days) => {
    if (days !== null) return days;
    const share = perOpen + (extra > 0 ? 1 : 0);
    extra -= 1;
    remaining -= share;
    return Math.max(1, share);
  });
  // Trim from the end if explicit counts exceed the cap.
  for (let index = days.length - 1; index >= 0 && sum(days) > MAX_TRIP_DAYS; index -= 1) {
    days[index] = Math.max(1, days[index]! - (sum(days) - MAX_TRIP_DAYS));
  }
  return days;
}

type DayCount = { days: number; position: "before" | "after" };

function explicitDaysNear(text: string, city: Pick<TripCity, "mentionIndex" | "mentionLength">): DayCount | null {
  const before = text.slice(Math.max(0, city.mentionIndex - DAY_COUNT_WINDOW), city.mentionIndex);
  const after = text.slice(city.mentionIndex + city.mentionLength, city.mentionIndex + city.mentionLength + DAY_COUNT_WINDOW);
  // "2 days in Roma" / "2 дня в Риме": the count ends right before the city and its preposition.
  const beforeMatch = /(?<![\p{L}\d])((?:\d{1,2}|один|одна|два|двух|три|трёх|трех|четыре|пять|шесть|семь|one|two|three|four|five|six|seven|ein|zwei|drei|vier|fünf|sechs|sieben)\s*[- ]?\s*(?:день|дня|дней|days?|tage?n?)?)\s*(?:in|в|во|nach|at|to|im|для)?\s*$/iu.exec(before);
  if (beforeMatch) {
    const phrase = beforeMatch[1]!.trim();
    // A bare number ("и 3 во Флоренции") counts only when the message talks about days elsewhere.
    if (/^\d{1,2}$/.test(phrase) && /\d\s*[- ]?\s*(?:день|дня|дней|days?|tage?n?)/iu.test(text)) {
      return { days: Math.min(MAX_TRIP_DAYS, Number(phrase)), position: "before" };
    }
    const parsed = parseTripDuration(phrase) ?? cappedDayCount(phrase);
    if (parsed !== null) return { days: parsed, position: "before" };
  }
  // "Roma for 2 days" / "в Риме 2 дня": the count follows the city before the next separator.
  const afterClause = after.split(/[,;.]|\s(?:and|и|und|then|потом|затем|dann)\s/iu)[0] ?? "";
  const parsed = parseTripDuration(afterClause) ?? cappedDayCount(afterClause);
  return parsed === null ? null : { days: parsed, position: "after" };
}

/** "12 days": a count above the supported range is capped, not misread as its last digit. */
function cappedDayCount(phrase: string): number | null {
  const digits = /(?<!\d)(\d{1,2})\s*[- ]?\s*(?:день|дня|дней|days?|tage?n?)/iu.exec(phrase);
  return digits ? Math.max(1, Math.min(MAX_TRIP_DAYS, Number(digits[1]))) : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Cities of the current trip: the latest message that names cities starts it, so a new city list replaces
 * the cities of an earlier trip in the same conversation. Later messages (route mode, days) stay in the text.
 */
export async function resolveLatestTripCities(
  messages: string[],
  resolveSettlement: (name: string) => Promise<ResolvedPlace | null>,
): Promise<{ cities: TripCity[]; text: string }> {
  // One turn looks up the same names several times; resolve each name once.
  const cache = new Map<string, Promise<ResolvedPlace | null>>();
  const cached = (name: string) => {
    if (!cache.has(name)) cache.set(name, resolveSettlement(name));
    return cache.get(name)!;
  };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!(await resolveTripCities(messages[index]!, cached)).length) continue;
    const text = messages.slice(index).join("\n");
    return { cities: await resolveTripCities(text, cached), text };
  }
  return { cities: [], text: messages.join("\n") };
}
