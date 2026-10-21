import { parseRouterOutput, type RouterTool } from "../../assistant/router.js";
import type { TeacherCall, TeacherExample } from "./openai-teacher.js";
import type { TeacherLanguage, TeacherTopic } from "./topics.js";

/**
 * Checks of one example the teacher wrote, before anyone sees it. Rejected: the call fails the tool's own schema,
 * names a settlement that is not in the database, is off the topic, is in another language than stated, or repeats
 * a known or benchmark question. A city written in English or as an exonym is corrected to the local spelling
 * from the database. Disputed: the teacher's blind answer to the same question was a different call.
 */
export type ExampleStatus = "passed" | "disputed" | "rejected";
export type ReasonCode =
  | "invalid_call" | "question_length" | "language_mismatch" | "off_topic" | "not_earthquakes" | "city_unknown"
  | "duplicate" | "benchmark_leak" | "city_corrected" | "cross_check_mismatch";
export interface CheckReason { code: ReasonCode; detail?: string }
export interface CheckedExample { question: string; language: TeacherLanguage; call: TeacherCall; status: ExampleStatus; reasons: CheckReason[] }

export interface CheckContext {
  topic: TeacherTopic;
  /** The settlement's local name, or null when the database has no such settlement. */
  resolveSettlement(name: string): Promise<string | null>;
  /** Normalized questions of the benchmark: never used for training. */
  benchmark: Set<string>;
  /** Normalized questions already accepted or written earlier in this batch; passed questions are added. */
  seen: Set<string>;
}

/** Problems that keep an example out of the dataset; city_corrected is only a note. */
const BLOCKING: ReasonCode[] = ["invalid_call", "question_length", "language_mismatch", "off_topic", "not_earthquakes", "city_unknown", "duplicate", "benchmark_leak"];

/** search_events finds earthquakes only; "events near Vienna" in the sense of concerts is not one of its calls. */
const EARTHQUAKE_WORDS = /землетряс|толч|трясл|сейсм|магнитуд|earthquake|quake|tremor|seism|magnitud|shak|erdbeb|beben|erschütter/iu;

export const normalizeQuestion = (question: string) => question.toLocaleLowerCase().replace(/[\s"«»“”„]+/g, " ").replace(/[.!?…]+$/u, "").trim();

const GERMAN = new Set(["der", "die", "das", "und", "ich", "mir", "mich", "gibt", "es", "zeig", "zeige", "finde", "welche", "wo", "bitte", "eine", "einen", "ein", "nach", "im", "für", "tage", "tag", "gab", "erdbeben", "plane", "kannst", "du", "wie", "was", "ist", "sind", "nicht", "mit", "auf", "letzten", "woche", "danke", "hallo", "von"]);
const ENGLISH = new Set(["the", "and", "i", "me", "my", "show", "find", "which", "where", "please", "a", "an", "to", "for", "days", "day", "were", "there", "any", "earthquakes", "plan", "can", "you", "how", "what", "is", "are", "not", "with", "on", "last", "week", "thanks", "hello", "of", "near", "trip", "some"]);

/** Script and frequent words; null when the text is too short to tell. */
export function detectLanguage(text: string): TeacherLanguage | null {
  const cyrillic = text.match(/[а-яё]/giu)?.length ?? 0;
  const latin = text.match(/[a-zäöüß]/giu)?.length ?? 0;
  if (cyrillic > latin) return "ru";
  if (!latin) return null;
  const words = text.toLocaleLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const german = words.filter((word) => GERMAN.has(word)).length + (/[äöüß]/iu.test(text) ? 1 : 0);
  const english = words.filter((word) => ENGLISH.has(word)).length;
  return german > english ? "de" : english > german ? "en" : null;
}

/** The settlement names of a call, with a setter to correct each one. */
function settlementFields(call: TeacherCall): Array<{ value: string; set(name: string): void }> {
  const args = call.args as Record<string, unknown>;
  if (call.tool === "search_places" && typeof args.city === "string") return [{ value: args.city, set: (name) => { args.city = name; } }];
  if (call.tool === "search_events" && typeof args.place === "string") return [{ value: args.place, set: (name) => { args.place = name; } }];
  if (call.tool === "plan_trip" && Array.isArray(args.cities)) {
    return (args.cities as Array<{ name?: unknown }>).filter((city) => typeof city.name === "string").map((city) => ({ value: city.name as string, set: (name: string) => { city.name = name; } }));
  }
  return [];
}

export async function checkExample(raw: TeacherExample, context: CheckContext): Promise<CheckedExample> {
  const question = String(raw.question ?? "").replace(/\s+/g, " ").trim();
  const language = (["ru", "en", "de"] as const).includes(raw.language) ? raw.language : "en";
  const reasons: CheckReason[] = [];
  const parsed = parseRouterOutput(JSON.stringify({ tool: raw.tool, args: raw.args ?? {} }));
  const call: TeacherCall = parsed.ok ? { tool: parsed.tool, args: structuredClone(parsed.args) } : { tool: raw.tool, args: (raw.args ?? {}) as Record<string, unknown> };
  if (!parsed.ok) reasons.push({ code: "invalid_call", detail: parsed.error });
  if (question.length < 3 || question.length > 400) reasons.push({ code: "question_length" });
  if (parsed.ok && !context.topic.tools.includes(call.tool as RouterTool)) reasons.push({ code: "off_topic", detail: call.tool });
  if (parsed.ok && call.tool === "search_events" && !EARTHQUAKE_WORDS.test(question)) reasons.push({ code: "not_earthquakes" });
  // Hard requests may mix languages on purpose.
  const detected = context.topic.id === "mixed" ? null : detectLanguage(question);
  if (detected && detected !== language) reasons.push({ code: "language_mismatch", detail: detected });
  if (parsed.ok) {
    for (const field of settlementFields(call)) {
      const local = await context.resolveSettlement(field.value);
      if (!local) reasons.push({ code: "city_unknown", detail: field.value });
      else if (local !== field.value) { reasons.push({ code: "city_corrected", detail: `${field.value} → ${local}` }); field.set(local); }
    }
  }
  const key = normalizeQuestion(question);
  if (context.benchmark.has(key)) reasons.push({ code: "benchmark_leak" });
  else if (context.seen.has(key)) reasons.push({ code: "duplicate" });
  const rejected = reasons.some((reason) => BLOCKING.includes(reason.code));
  if (!rejected) context.seen.add(key);
  return { question, language, call, status: rejected ? "rejected" : "passed", reasons };
}

/** Comparable form of a call: lower-cased strings, sorted keys, and no free-text query. */
export function canonicalCall(call: TeacherCall): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "query").sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
    return typeof value === "string" ? value.toLocaleLowerCase().trim() : value;
  };
  return JSON.stringify({ tool: call.tool, args: canonical(call.args) });
}

/**
 * Marks a passed example as disputed when the blind answer differs. The answer's cities are corrected to local names
 * first, so "Rome" and "Roma" agree.
 */
export async function crossCheck(example: CheckedExample, answer: TeacherCall | null, resolveSettlement: CheckContext["resolveSettlement"]): Promise<CheckedExample> {
  if (example.status !== "passed") return example;
  const parsed = answer ? parseRouterOutput(JSON.stringify(answer)) : null;
  if (!parsed?.ok) return { ...example, status: "disputed", reasons: [...example.reasons, { code: "cross_check_mismatch", detail: "no valid answer" }] };
  const blind: TeacherCall = { tool: parsed.tool, args: structuredClone(parsed.args) };
  for (const field of settlementFields(blind)) {
    const local = await resolveSettlement(field.value);
    if (local) field.set(local);
  }
  if (canonicalCall(blind) === canonicalCall(example.call)) return example;
  return { ...example, status: "disputed", reasons: [...example.reasons, { code: "cross_check_mismatch", detail: JSON.stringify(blind) }] };
}
