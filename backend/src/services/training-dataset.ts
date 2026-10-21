import { generateBenchmark, KINDS, type Settlement } from "./benchmark-generator.js";
import { EXONYMS, EXTRA_REPLIES, EXTRA_SOURCES } from "./training-extras.js";
import { routerMessages } from "../assistant/router.js";

/**
 * Training examples for the router: the router prompt, the user's message, and the right call as the JSON answer.
 * Sources are synthetic questions from the database (a different seed and more of them than the benchmark), examples
 * the teacher wrote in accepted batches, and turns a person confirmed in the journal. Every example whose question is also a benchmark question is left out,
 * so the benchmark keeps measuring questions the model was not trained on.
 */
export interface TrainingExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  /** Kept beside the messages for statistics and filtering; trainers ignore them. */
  meta: { skill: string; language: string; source: "generated" | "teacher" | "journal"; topic?: string };
}

export interface DatasetInput {
  cities: Settlement[];
  eventTowns: Settlement[];
  /** Questions of the benchmark; never used for training. */
  benchmarkQuestions: string[];
  /** Confirmed journal turns. */
  confirmed: Array<{ message: string; language: string | null; corrected: { tool: string; args: Record<string, unknown> } }>;
  /** Checked examples of accepted teacher batches. */
  teacher?: Array<{ question: string; language: string; tool: string; args: Record<string, unknown>; topic: string }>;
  perSkill: number;
  seed: number;
}

const SKILL_OF_TOOL: Record<string, string> = { search_places: "places", search_events: "events", plan_trip: "trips", list_sources: "sources", reply: "reply" };
const normalize = (question: string) => question.toLocaleLowerCase().replace(/\s+/g, " ").trim();

export function buildDataset(input: DatasetInput): { examples: TrainingExample[]; excludedAsBenchmark: number } {
  const benchmark = new Set(input.benchmarkQuestions.map(normalize));
  const seen = new Set<string>();
  let excludedAsBenchmark = 0;
  const examples: TrainingExample[] = [];
  const add = (question: string, language: string, call: { tool: string; args: Record<string, unknown> }, source: TrainingExample["meta"]["source"], topic?: string) => {
    const key = normalize(question);
    if (benchmark.has(key)) { excludedAsBenchmark += 1; return; }
    if (seen.has(key)) return;
    seen.add(key);
    examples.push({
      messages: [...routerMessages(question), { role: "assistant", content: JSON.stringify({ tool: call.tool, args: call.args }) }],
      meta: { skill: SKILL_OF_TOOL[call.tool] ?? "other", language, source, ...(topic ? { topic } : {}) },
    });
  };
  for (const item of generateBenchmark({ cities: input.cities, eventTowns: input.eventTowns, perSkill: input.perSkill, seed: input.seed })) {
    if (item.target) add(item.question, item.language, item.target, "generated");
  }
  for (const [language, questions] of Object.entries(EXTRA_SOURCES)) for (const question of questions) add(question, language, { tool: "list_sources", args: {} }, "generated");
  for (const [language, questions] of Object.entries(EXTRA_REPLIES)) for (const question of questions) add(question, language, { tool: "reply", args: {} }, "generated");
  // Cities named in Russian and German: the router must answer with the local spelling.
  const kinds = Object.keys(KINDS);
  EXONYMS.forEach((city, index) => {
    for (let offset = 0; offset < 3; offset += 1) {
      const kind = kinds[(index * 3 + offset) % kinds.length]!;
      add(`${["Найди", "Покажи", "Какие есть"][offset]} ${KINDS[kind]!.ru} в ${city.ruIn}`, "ru", { tool: "search_places", args: { kind, city: city.local } }, "generated");
      add(`${["Finde", "Zeig mir", "Gibt es"][offset]} ${KINDS[kind]!.de} in ${city.de}${offset === 2 ? "?" : ""}`, "de", { tool: "search_places", args: { kind, city: city.local } }, "generated");
    }
    const days = 1 + (index % 3);
    add(`Составь план на ${days === 1 ? "1 день" : `${days} дня`} в ${city.ruIn}`, "ru", { tool: "plan_trip", args: { cities: [{ name: city.local, days }] } }, "generated");
    add(`Plane ${days === 1 ? "einen Tag" : `${days} Tage`} in ${city.de}`, "de", { tool: "plan_trip", args: { cities: [{ name: city.local, days }] } }, "generated");
    if (city.events) {
      add(`Землетрясения у ${city.ruNear} за неделю`, "ru", { tool: "search_events", args: { place: city.local, hours: 168 } }, "generated");
      add(`Были ли толчки возле ${city.ruNear} за последние сутки?`, "ru", { tool: "search_events", args: { place: city.local, hours: 24 } }, "generated");
      add(`Erdbeben bei ${city.de} in den letzten 3 Tagen`, "de", { tool: "search_events", args: { place: city.local, hours: 72 } }, "generated");
    }
  });
  for (const example of input.teacher ?? []) add(example.question, example.language, { tool: example.tool, args: example.args }, "teacher", example.topic);
  for (const turn of input.confirmed) add(turn.message, turn.language ?? "en", turn.corrected, "journal");
  return { examples, excludedAsBenchmark };
}

/** Counts per skill, language, source, and teacher topic, shown before training so an unbalanced dataset is visible. */
export function datasetSummary(examples: TrainingExample[]) {
  const count = (key: keyof TrainingExample["meta"]) => examples.reduce<Record<string, number>>((counts, example) => {
    const value = example.meta[key];
    if (value) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
  return { total: examples.length, bySkill: count("skill"), byLanguage: count("language"), bySource: count("source"), byTopic: count("topic") };
}

/** JSON Lines in the chat format that common fine-tuning tools read. */
export function toJsonl(examples: TrainingExample[]): string {
  return examples.map((example) => JSON.stringify({ messages: example.messages })).join("\n") + "\n";
}
