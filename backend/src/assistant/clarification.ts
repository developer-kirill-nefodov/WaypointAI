import type { ClarificationAnswer, ClarificationField, ClarificationFieldKey, ClientFrame, SourceView } from "@waypoint-ai/shared";
import { z } from "zod";
import { normalizeToolArguments, searchEventsArgsSchema } from "../tools/search-events.js";
import { complementFromText } from "./event-search.js";

/**
 * Clarifications with one-time filters. When a request misses a detail that changes the answer (the period of an
 * earthquake search, the days and route of a trip), the server asks for it with fields whose options it builds
 * itself. The chosen values come back with the next message, are checked against the same options, and apply to that
 * turn only: sources go into its scope, the rest is added to its text in words the model and the rule parser read.
 */

type Language = "en" | "ru" | "de";
type SubmitFrame = Extract<ClientFrame, { type: "turn.submit" }>;

const PERIODS = [24, 24 * 7, 24 * 30, 24 * 90] as const;
const RADII = [10, 30, 50, 100] as const;
const MAGNITUDES = ["any", "2", "3", "4"] as const;
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const TRAVEL = ["driving", "none"] as const;
const MAX_SOURCES = 20;

const pick = (language: Language, ru: string, en: string, de: string) => (language === "ru" ? ru : language === "de" ? de : en);

function periodLabel(hours: number, language: Language): string {
  if (hours === 24) return pick(language, "24 часа", "24 hours", "24 Stunden");
  const days = hours / 24;
  return pick(language, `${days} дн.`, `${days} days`, `${days} Tage`);
}

function periodPhrase(hours: number, language: Language): string {
  if (hours === 24) return pick(language, "за последние 24 часа", "in the last 24 hours", "in den letzten 24 Stunden");
  const days = hours / 24;
  return pick(language, `за последние ${days} дней`, `in the last ${days} days`, `in den letzten ${days} Tagen`);
}

/** The fields of a clarification with their options; event sources come from the database. */
export function buildClarificationFields(keys: ClarificationFieldKey[], language: Language, eventSources: SourceView[] = []): ClarificationField[] {
  const fields: ClarificationField[] = [];
  for (const key of keys) {
    if (key === "period") fields.push({ key, label: pick(language, "Период", "Period", "Zeitraum"), multiple: false, options: PERIODS.map((hours) => ({ id: String(hours), label: periodLabel(hours, language) })) });
    if (key === "magnitude") fields.push({ key, label: pick(language, "Магнитуда", "Magnitude", "Magnitude"), multiple: false, options: MAGNITUDES.map((id) => ({ id, label: id === "any" ? pick(language, "любая", "any", "beliebig") : `M${id}+` })) });
    if (key === "radius") fields.push({ key, label: pick(language, "Радиус", "Radius", "Umkreis"), multiple: false, options: RADII.map((km) => ({ id: String(km), label: `${km} km` })) });
    if (key === "sources" && eventSources.length) fields.push({ key, label: pick(language, "Источники", "Sources", "Quellen"), multiple: true, options: eventSources.slice(0, MAX_SOURCES).map((source) => ({ id: source.id, label: source.label.replace(/\s*\(.*\)\s*$/, "") })) });
    if (key === "days") fields.push({ key, label: pick(language, "Дней", "Days", "Tage"), multiple: false, options: DAYS.map((days) => ({ id: String(days), label: String(days) })) });
    if (key === "travel") fields.push({ key, label: pick(language, "Маршрут", "Route", "Route"), multiple: false, options: TRAVEL.map((id) => ({ id, label: id === "driving" ? pick(language, "на машине", "by car", "mit dem Auto") : pick(language, "только места", "places only", "nur Orte") })) });
  }
  return fields;
}

const answersSchema = z.array(z.object({
  key: z.enum(["period", "sources", "radius", "magnitude", "days", "travel"]),
  values: z.array(z.string().regex(/^[\w.:-]{1,80}$/)).min(1).max(MAX_SOURCES),
})).max(6);

/** What the answers change in a turn, after checking every value against the options the server offers. */
export interface AppliedAnswers {
  /** The message with the chosen details added in words. */
  message: string;
  /** Event sources chosen for this turn only; undefined keeps the scope as sent. */
  sourceIds?: string[];
  /** Keys that were answered: the server does not ask for them again in this turn. */
  answered: Set<ClarificationFieldKey>;
}

export function applyClarificationAnswers(frame: SubmitFrame, language: Language, knownSourceIds: Set<string>): AppliedAnswers {
  const parsed = answersSchema.safeParse(frame.answers ?? []);
  const answered = new Set<ClarificationFieldKey>();
  if (!parsed.success || !parsed.data.length) return { message: frame.message, answered };
  const phrases: string[] = [];
  let sourceIds: string[] | undefined;
  for (const { key, values } of parsed.data as ClarificationAnswer[]) {
    const value = values[0]!;
    if (key === "period" && PERIODS.includes(Number(value) as (typeof PERIODS)[number])) phrases.push(periodPhrase(Number(value), language));
    else if (key === "magnitude" && MAGNITUDES.includes(value as (typeof MAGNITUDES)[number])) {
      if (value !== "any") phrases.push(pick(language, `магнитуда от ${value}`, `magnitude ${value} or more`, `Magnitude ab ${value}`));
    } else if (key === "radius" && RADII.includes(Number(value) as (typeof RADII)[number])) phrases.push(pick(language, `в радиусе ${value} км`, `within ${value} km`, `im Umkreis von ${value} km`));
    else if (key === "days" && DAYS.includes(Number(value) as (typeof DAYS)[number])) phrases.push(pick(language, `на ${value} дн.`, `for ${value} days`, `für ${value} Tage`));
    else if (key === "travel" && TRAVEL.includes(value as (typeof TRAVEL)[number])) phrases.push(value === "driving" ? pick(language, "автомобильный маршрут", "with a driving route", "mit Autoroute") : pick(language, "только места, без маршрута", "places only, no route", "nur Orte, ohne Route"));
    else if (key === "sources") {
      const known = values.filter((id) => knownSourceIds.has(id));
      if (!known.length) continue;
      sourceIds = known;
    } else continue;
    answered.add(key);
  }
  const details = phrases.length ? `\n${pick(language, "Уточнение", "Details", "Angaben")}: ${phrases.join(", ")}.` : "";
  return { message: `${frame.message}${details}`.slice(0, 4000), ...(sourceIds ? { sourceIds } : {}), answered };
}

/** The question asked when an earthquake search names no period. */
export function eventDetailsQuestion(language: Language): string {
  return pick(language, "Уточните, пожалуйста, детали поиска землетрясений:", "Please choose the details of the earthquake search:", "Bitte wählen Sie die Details der Erdbebensuche:");
}

/** The question asked when a trip plan misses its route mode (and, when unknown, its length). */
export function tripDetailsQuestion(cities: string[], askDays: boolean, language: Language): string {
  const list = cities.join(", ");
  return askDays
    ? pick(language, `Сколько дней и какой маршрут для поездки (${list})? Сейчас приложение строит только автомобильные маршруты.`, `How many days, and which route for the trip (${list})? The app calculates driving routes only.`, `Wie viele Tage und welche Route für die Reise (${list})? Die App berechnet nur Autorouten.`)
    : pick(language, `Сейчас приложение умеет строить только автомобильный маршрут. Построить его по дням (${list})?`, `The app can calculate driving routes only. Should I add a driving route for each day (${list})?`, `Die App kann nur Autorouten berechnen. Soll ich für jeden Tag eine Autoroute hinzufügen (${list})?`);
}

/**
 * The details an earthquake search should ask for: the period when the call and the user's text name none, the
 * magnitude and the radius when they are missing too. Null when the period is known (nothing to ask).
 */
export function eventDetailsToAsk(rawArgs: unknown, userText: string): ClarificationFieldKey[] | null {
  const parsed = searchEventsArgsSchema.safeParse(normalizeToolArguments(rawArgs));
  if (!parsed.success) return null;
  const args = complementFromText(parsed.data, userText);
  if (args.hours !== undefined) return null;
  return [
    "period",
    ...(args.minMagnitude === undefined && args.maxMagnitude === undefined ? ["magnitude" as const] : []),
    ...((args.place || args.nearSelection) && args.radiusKm === undefined ? ["radius" as const] : []),
  ];
}

/** Whether a plan_trip call already says how long the trip is (in total or per city). */
export function tripHasDays(rawArgs: unknown): boolean {
  const args = normalizeToolArguments(rawArgs) as { totalDays?: unknown; cities?: Array<{ days?: unknown }> } | null;
  return typeof args?.totalDays === "number" || Boolean(args?.cities?.some((city) => typeof city?.days === "number"));
}
