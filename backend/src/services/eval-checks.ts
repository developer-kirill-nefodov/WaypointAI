import { z } from "zod";
import { EXAMPLE_TOOLS } from "../assistant/lessons.js";

/** What an exam case expects. Every field is optional; each one present becomes one check. */
export const caseExpectationSchema = z.object({
  /** The tool the assistant must call (reply: answer without data). */
  tool: z.enum([...EXAMPLE_TOOLS, "search_records", "get_record_details", "edit_trip_plan"]).optional(),
  /**
   * Arguments the call must contain; strings compare case-insensitively, other values exactly, and a list accepts any
   * of its values (a city by its local or English name). A dotted key reaches into nested values ("cities.0.name").
   */
  args: z.record(z.string().regex(/^[A-Za-z][\w.]{0,39}$/), z.union([z.string().max(120), z.number(), z.boolean(), z.array(z.string().max(120)).min(1).max(5)])).optional()
    .refine((value) => !value || Object.keys(value).length <= 8, "too_many_args"),
  mustInclude: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
  mustNotInclude: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
  /** The answer must cite rows ([E1], [P1]). */
  citations: z.boolean().optional(),
  /** Every sentence that states a magnitude must cite the event it describes ([E1]). */
  citeEachEvent: z.boolean().optional(),
  maxSentences: z.number().int().min(1).max(20).optional(),
}).strict();
export type CaseExpectation = z.infer<typeof caseExpectationSchema>;

export interface ExamCase {
  id: string;
  question: string;
  language: "ru" | "en" | "de";
  expect: CaseExpectation;
  enabled: boolean;
  /** What the case tests: places, events, trips, sources, reply, or other. */
  skill?: string;
  /** starter, manual, generated, hard, or journal. */
  origin?: string;
}

/** What one assistant turn did, as seen by the exam. */
export interface TurnObservation {
  toolCalls: Array<{ tool: string; args: unknown }>;
  answer: string;
  citationsMode?: "cited" | "shown_to_model";
  /** Stable error code when the turn failed. */
  errorCode?: string;
}

export interface CheckResult {
  check: "completed" | "tool" | "args" | "language" | "mustInclude" | "mustNotInclude" | "citations" | "citeEachEvent" | "maxSentences";
  passed: boolean;
  /** What was expected and what happened, in plain values for the UI. */
  expected?: unknown;
  actual?: unknown;
}

/**
 * Runs every check the case defines; a failed turn fails one "completed" check and skips the rest. With firstStepOnly
 * the turn stopped at the model's first tool call, so only the tool and its arguments are checked.
 */
export function checkTurn(examCase: ExamCase, observation: TurnObservation, firstStepOnly = false): CheckResult[] {
  if (observation.errorCode) return [{ check: "completed", passed: false, expected: "answer", actual: observation.errorCode }];
  const { expect } = examCase;
  const answer = observation.answer;
  const lower = answer.toLocaleLowerCase();
  const results: CheckResult[] = [];
  const called = observation.toolCalls.map((call) => call.tool);
  if (expect.tool) {
    // An answer without data calls reply, or nothing at all when a place list or plan is assembled by the server.
    // At the first step the model must call a tool, reply included; a plain-text first answer is withheld by the turn.
    const passed = expect.tool === "reply"
      ? called.every((tool) => tool === "reply") && (!firstStepOnly || called.length > 0)
      : called.includes(expect.tool);
    results.push({ check: "tool", passed, expected: expect.tool, actual: called });
  }
  if (expect.args && Object.keys(expect.args).length) {
    const call = observation.toolCalls.find((item) => item.tool === (expect.tool ?? item.tool) && item.args && typeof item.args === "object");
    const actual = (call?.args ?? {}) as Record<string, unknown>;
    const mismatched = Object.entries(expect.args).filter(([key, value]) => !sameValue(valueAt(actual, key), value)).map(([key]) => key);
    results.push({ check: "args", passed: Boolean(call) && !mismatched.length, expected: expect.args, actual: call ? pick(actual, Object.keys(expect.args)) : null });
  }
  if (firstStepOnly) return results.length ? results : [{ check: "completed", passed: true }];
  results.push({ check: "language", passed: detectLanguage(answer) === examCase.language, expected: examCase.language, actual: detectLanguage(answer) });
  if (expect.mustInclude?.length) {
    const missing = expect.mustInclude.filter((value) => !lower.includes(value.toLocaleLowerCase()));
    results.push({ check: "mustInclude", passed: !missing.length, expected: expect.mustInclude, actual: missing.length ? { missing } : "all present" });
  }
  if (expect.mustNotInclude?.length) {
    const found = expect.mustNotInclude.filter((value) => lower.includes(value.toLocaleLowerCase()));
    results.push({ check: "mustNotInclude", passed: !found.length, expected: expect.mustNotInclude, actual: found.length ? { found } : "none present" });
  }
  if (expect.citations !== undefined) {
    const cited = observation.citationsMode === "cited";
    results.push({ check: "citations", passed: cited === expect.citations, expected: expect.citations, actual: observation.citationsMode ?? "none" });
  }
  if (expect.citeEachEvent) {
    const uncited = sentencesAboutEvents(answer).filter((sentence) => !/\[E\d{1,3}\]/.test(sentence));
    results.push({ check: "citeEachEvent", passed: !uncited.length, expected: true, actual: uncited.length ? { uncited: uncited.slice(0, 3).map((sentence) => sentence.slice(0, 120)) } : "all cited" });
  }
  if (expect.maxSentences !== undefined) {
    const sentences = countSentences(answer);
    results.push({ check: "maxSentences", passed: sentences <= expect.maxSentences, expected: expect.maxSentences, actual: sentences });
  }
  return results;
}

function sameValue(actual: unknown, expected: string | number | boolean | string[]): boolean {
  if (Array.isArray(expected)) return expected.some((value) => sameValue(actual, value));
  if (typeof expected === "string") return typeof actual === "string" && actual.trim().toLocaleLowerCase() === expected.trim().toLocaleLowerCase();
  return actual === expected;
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, valueAt(value, key) ?? null]));
}

/** A value by dotted path: "cities.0.name" reads value.cities[0].name. */
function valueAt(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
}

const GERMAN_WORDS = /\b(der|die|das|und|ist|nicht|ein|eine|im|mit|von|für|auf|sind|wurde|keine)\b/gi;
const ENGLISH_WORDS = /\b(the|and|is|are|of|in|with|for|were|was|no|not|this)\b/gi;

/** Language of an answer from its letters and common words; good enough to tell ru, en, and de apart. */
export function detectLanguage(answer: string): "ru" | "en" | "de" {
  // Citation refs carry no language, and list items are mostly place names in their local spelling.
  const withoutLists = answer.split("\n").filter((line) => !/^\s*(\d+[.)]|[-*•])\s/.test(line)).join("\n");
  const prose = (withoutLists.trim() ? withoutLists : answer).replace(/\[[EP]\d{1,3}\]/g, " ");
  const letters = prose.match(/\p{L}/gu) ?? [];
  const cyrillic = prose.match(/\p{Script=Cyrillic}/gu) ?? [];
  if (letters.length && cyrillic.length / letters.length > 0.4) return "ru";
  const german = (prose.match(GERMAN_WORDS) ?? []).length + (prose.match(/[äöüß]/gi) ?? []).length;
  const english = (prose.match(ENGLISH_WORDS) ?? []).length;
  return german > english ? "de" : "en";
}

/** A magnitude in the answer: "M3.1", "M 2", "magnitude 4,7", "магнитуда 3", "Magnitude 2.5". */
const MAGNITUDE = /\bM\s?\d(?:[.,]\d)?\b|(?:magnitude|магнитуд\p{L}*|stärke)\s*(?:of\s*|von\s*|—\s*|-\s*)?\d(?:[.,]\d)?/iu;

/** Sentences that state an event's magnitude; a sentence naming only a range of magnitudes is a summary. */
export function sentencesAboutEvents(answer: string): string[] {
  return answer
    // Decimal separators are protected so "3.3" does not end a sentence, and restored as written.
    .replace(/(\d)\.(\d)/g, "$1\u2024$2")
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.replace(/\u2024/g, "."))
    .filter((sentence) => MAGNITUDE.test(sentence) && !/(from|от|von)\s*\d(?:[.,]\d)?\s*(to|до|bis)\s*\d/i.test(sentence));
}

/** Sentences of prose; list items count as one each. */
export function countSentences(answer: string): number {
  const prose = answer.replace(/\[[EP]\d{1,3}\]/g, "").replace(/\d+[.,]\d+/g, "0").trim();
  if (!prose) return 0;
  return prose.split(/(?<=[.!?…])\s+|\n+/).filter((part) => /\p{L}/u.test(part)).length;
}
