import { ROUTER_SYSTEM_PROMPT, ROUTER_TOOLS, type RouterTool } from "../../assistant/router.js";
import { PLACE_KINDS } from "../../tools/assistant-tools.js";
import type { TeacherLanguage, TeacherTopic } from "./topics.js";

/**
 * The teacher: OpenAI Chat Completions with Structured Outputs (a strict JSON schema), so every answer is a list of
 * {question, language, tool, args} in the router's own argument shapes. Nothing it writes is trusted: every example
 * goes through the same checks as a router answer (checks.ts). The key is sent only to api.openai.com.
 */
const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 120_000;

export interface TeacherCall { tool: RouterTool; args: Record<string, unknown> }
export interface TeacherExample extends TeacherCall { question: string; language: TeacherLanguage }
export interface TeacherUsage { promptTokens: number; completionTokens: number }
export interface SettlementName { name: string; nameEn: string | null }

export class TeacherError extends Error {
  constructor(readonly code: "teacher_unavailable" | "teacher_unauthorized" | "teacher_rate_limited" | "teacher_refused" | "teacher_invalid_answer" | "teacher_failed") { super(code); }
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

/** Strict mode wants every property required, so optional arguments are nullable; nulls are dropped afterwards. */
const ARGS_SCHEMA = {
  anyOf: [
    object({ kind: { type: "string", enum: Object.keys(PLACE_KINDS) }, city: nullable({ type: "string" }), query: nullable({ type: "string" }) }),
    object({
      place: nullable({ type: "string" }), nearSelection: nullable({ type: "boolean" }), radiusKm: nullable({ type: "number" }),
      hours: nullable({ type: "integer" }), minMagnitude: nullable({ type: "number" }), maxMagnitude: nullable({ type: "number" }),
    }),
    object({
      cities: { type: "array", items: object({ name: { type: "string" }, days: nullable({ type: "integer" }) }) },
      totalDays: nullable({ type: "integer" }), routeMode: nullable({ type: "string", enum: ["driving", "none"] }),
    }),
    object({}),
  ],
};
const CALL_PROPERTIES = { tool: { type: "string", enum: [...ROUTER_TOOLS] }, args: ARGS_SCHEMA };
const EXAMPLES_SCHEMA = object({
  examples: { type: "array", items: object({ question: { type: "string" }, language: { type: "string", enum: ["ru", "en", "de"] }, ...CALL_PROPERTIES }) },
});
const ANSWERS_SCHEMA = object({ answers: { type: "array", items: object({ index: { type: "integer" }, ...CALL_PROPERTIES }) } });

/** Drops nulls at any depth: strict mode's stand-in for an omitted optional argument. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, withoutNulls(item)]));
  return value;
}

const LANGUAGE_NAMES: Record<TeacherLanguage, string> = { ru: "Russian", en: "English", de: "German" };

export function generationPrompt(input: { topic: TeacherTopic; languages: TeacherLanguage[]; count: number; settlements: SettlementName[]; eventTowns?: SettlementName[]; avoid: string[] }): string {
  const names = (list: SettlementName[]) => list.map((item) => (item.nameEn && item.nameEn !== item.name ? `${item.name} (${item.nameEn})` : item.name)).join(", ");
  const list = names(input.settlements);
  return [
    "You write training data for a small router model of a travel assistant. The router reads the system prompt below and one user message, and answers with one tool call.",
    "--- Router system prompt ---", ROUTER_SYSTEM_PROMPT, "--- End ---",
    `Topic: ${input.topic.brief}`,
    `Allowed tools for this topic: ${input.topic.tools.join(", ")}.`,
    `Write ${input.count} different user messages, spread evenly over these languages: ${input.languages.map((language) => LANGUAGE_NAMES[language]).join(", ")}. Set language to the message's language code.`,
    list ? `Use only these settlements (local name, then English name). In args always write the local name exactly as listed; in the message write the name as a speaker of that language would: ${list}.` : "Name no settlements.",
    input.eventTowns?.length ? `For search_events use only these towns, which the earthquake data covers: ${names(input.eventTowns)}.` : "",
    "search_events is only about earthquakes and tremors; concerts, festivals, or other events are not served by any tool (reply).",
    "Every message must sound like a real person: different lengths, word order, and politeness. No numbering, no quotes around the message, no two messages alike.",
    "Args: only what the message states, following the router prompt. Unused optional arguments are null.",
    input.avoid.length ? `Do not repeat or closely paraphrase these existing messages:\n${input.avoid.map((question) => `- ${question}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAiTeacher {
  constructor(private readonly options: { apiKey: string | undefined; model: string; fetch?: FetchLike }) {}

  get available(): boolean { return Boolean(this.options.apiKey); }
  get model(): string { return this.options.model; }

  async generate(input: Parameters<typeof generationPrompt>[0], signal?: AbortSignal): Promise<{ examples: TeacherExample[]; usage: TeacherUsage }> {
    const { value, usage } = await this.#complete([{ role: "system", content: generationPrompt(input) }, { role: "user", content: `Write the ${input.count} examples.` }], "router_examples", EXAMPLES_SCHEMA, 0.9, signal);
    const examples = (value as { examples?: unknown }).examples;
    if (!Array.isArray(examples)) throw new TeacherError("teacher_invalid_answer");
    return { examples: examples.map((item) => withoutNulls(item) as TeacherExample), usage };
  }

  /** Answers the questions blind, as the router would, to cross-check the calls the teacher wrote. */
  async answer(questions: string[], signal?: AbortSignal): Promise<{ answers: Array<TeacherCall | null>; usage: TeacherUsage }> {
    const numbered = questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
    const { value, usage } = await this.#complete([
      { role: "system", content: `${ROUTER_SYSTEM_PROMPT}\n\nYou get several numbered user messages. Answer each one separately with its tool call; index is the message's number. Unused optional arguments are null.` },
      { role: "user", content: numbered },
    ], "router_answers", ANSWERS_SCHEMA, 0, signal);
    const answers = (value as { answers?: unknown }).answers;
    if (!Array.isArray(answers)) throw new TeacherError("teacher_invalid_answer");
    const byIndex = new Map<number, TeacherCall>();
    for (const item of answers as Array<{ index: number } & TeacherCall>) byIndex.set(item.index, { tool: item.tool, args: withoutNulls(item.args) as Record<string, unknown> });
    return { answers: questions.map((_question, index) => byIndex.get(index + 1) ?? null), usage };
  }

  async #complete(messages: Array<{ role: string; content: string }>, name: string, schema: unknown, temperature: number, signal?: AbortSignal): Promise<{ value: unknown; usage: TeacherUsage }> {
    if (!this.options.apiKey) throw new TeacherError("teacher_unavailable");
    // Reasoning models accept only their default temperature.
    const fixedTemperature = /^(o\d|gpt-5)/.test(this.options.model);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.options.model, messages, ...(fixedTemperature ? {} : { temperature }),
          response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TeacherError("teacher_failed");
    }
    if (response.status === 401 || response.status === 403) throw new TeacherError("teacher_unauthorized");
    if (response.status === 429) throw new TeacherError("teacher_rate_limited");
    if (!response.ok) throw new TeacherError("teacher_failed");
    const body = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    const message = body?.choices?.[0]?.message;
    if (message?.refusal) throw new TeacherError("teacher_refused");
    let value: unknown;
    try { value = JSON.parse(message?.content ?? ""); } catch { throw new TeacherError("teacher_invalid_answer"); }
    return { value, usage: { promptTokens: body?.usage?.prompt_tokens ?? 0, completionTokens: body?.usage?.completion_tokens ?? 0 } };
  }
}
