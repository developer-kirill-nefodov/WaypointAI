import type { ChatMessage, ChatResult } from "../llm/ollama.provider.js";

/** What the latest message wants when a trip plan is already on the map. */
export type PlanIntent = "change_plan" | "new_trip" | "other";
const INTENTS: PlanIntent[] = ["change_plan", "new_trip", "other"];

const INTENT_FORMAT = {
  type: "object",
  additionalProperties: false,
  required: ["intent"],
  properties: { intent: { type: "string", enum: INTENTS } },
};

const INTENT_PROMPT = `A trip plan is shown on the map. Classify the user's latest message, in any language, using the recent conversation for context.
- change_plan: it asks to change this plan in any way: add, remove, move, or replace stops; add one more day or remove a day; change the number of days; turn the driving route on or off; or a short answer confirming such a change. Extra days in the same city are change_plan.
- new_trip: it names other cities than the plan's, or explicitly asks to start a new plan from scratch.
- other: anything else, including questions about the plan, place or event searches, and small talk.
Examples: "one more day with museums" → change_plan; "noch einen Tag dazu" → change_plan; "togli il secondo giorno" → change_plan; "how many stops are there?" → other; "now plan Paris for 2 days" → new_trip.
Answer with JSON only.`;

/**
 * A short structured-output call that only classifies; the model, not keyword rules, decides. The following call
 * then gets only the tools that fit, which small models handle far more reliably than the full tool list.
 */
export async function classifyPlanIntent(
  planSummary: string,
  history: ChatMessage[],
  message: string,
  call: (messages: ChatMessage[], format: Record<string, unknown>) => Promise<ChatResult>,
): Promise<{ intent: PlanIntent; result: ChatResult }> {
  // Only the conversation text: tool calls and their results would leave empty or orphaned messages here.
  const recent = history.filter((entry) => (entry.role === "user" || entry.role === "assistant") && !entry.tool_calls?.length).slice(-4);
  const result = await call([
    { role: "system", content: `${INTENT_PROMPT}\nPlan: ${planSummary}` },
    ...recent,
    { role: "user", content: message },
  ], INTENT_FORMAT);
  return { intent: parseIntent(result.message.content), result };
}

export function parseIntent(content: string): PlanIntent {
  try {
    const value: unknown = JSON.parse(content);
    const intent = value && typeof value === "object" ? (value as { intent?: unknown }).intent : null;
    return INTENTS.includes(intent as PlanIntent) ? intent as PlanIntent : "other";
  } catch {
    return "other";
  }
}
