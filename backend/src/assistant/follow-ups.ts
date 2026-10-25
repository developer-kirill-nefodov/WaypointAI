import type { ServerFrame, SuggestedRequest } from "@waypoint-ai/shared";
import { z } from "zod";
import { env } from "../config/env.js";
import { releaseInference, tryAcquireBackgroundInference } from "../llm/inference-gate.js";
import { chat, type ChatMessage } from "../llm/ollama.provider.js";

/**
 * Model-written follow-up suggestions (FOLLOW_UPS_MODEL=true): after an answer, the local model writes three requests
 * the user is likely to send next, from the last exchange and what is on the map. They replace the server's
 * (follow-up-templates.ts), which come with the answer. The model runs one generation at a time, so this happens right
 * after the answer, as background work that gives way to the next chat turn. Without a usable result the client
 * keeps the server's suggestions.
 */

/** What the suggestions are written from; set by a completed turn. */
export interface FollowUpContext {
  requestId: string;
  language: "en" | "ru" | "de";
  question: string;
  previousQuestion: string | null;
  /** The answer's text without citation refs, shortened. */
  answer: string;
  /** What the turn put on the map, in a few words ("trip plan: Roma, 3 days, driving route"). */
  onMap: string | null;
  /** The kind of answer, which decides what a natural next request is. */
  topic: "events" | "places" | "trip" | "other";
}

/** What a natural next request looks like after each kind of answer. */
const TOPIC_HINTS: Record<FollowUpContext["topic"], string> = {
  events: "The answer was about earthquakes: suggest the same search with another period, radius, or minimum magnitude, the strongest event, or whether the catalogues agree.",
  places: "The answer listed places: suggest other kinds of places in the same city, one of the listed places, or a short trip there.",
  trip: "The answer was a trip plan: suggest changes to this plan (a museum or park on a day, one more day, removing or moving a stop, places only) by day number.",
  other: "Suggest requests about the cities, trips, or earthquakes this conversation mentions.",
};

/** The local model writes about ten tokens a second; three suggestions take 10–20 s on a laptop. */
const FOLLOW_UP_TIMEOUT_MS = 45_000;
const FOLLOW_UP_MAX_TOKENS = 200;
const LABEL_MAX = 48;
const PROMPT_MAX = 200;

const FORMAT = {
  type: "object",
  properties: {
    suggestions: {
      type: "array", minItems: 3, maxItems: 3,
      items: { type: "object", properties: { label: { type: "string" }, prompt: { type: "string" } }, required: ["label", "prompt"] },
    },
  },
  required: ["suggestions"],
};

const CAPABILITIES = "find places of a kind in a city (museums, parks, restaurants, cafés, attractions) or one named place; plan a trip of 1–7 days across up to five cities with a driving route per day and change it (add or remove stops or days, move a stop); search earthquakes by place, radius, period, and magnitude and say whether the INGV and USGS catalogues agree; list the data sources";

const languageName = (language: FollowUpContext["language"]) => (language === "ru" ? "Russian" : language === "de" ? "German" : "English");

export function followUpMessages(context: FollowUpContext): ChatMessage[] {
  return [
    {
      role: "system",
      content: `You write follow-up requests for Waypoint AI, a local map assistant. Write exactly 3 different requests the user is likely to send next, in ${languageName(context.language)}, worded as the user would type them. Each continues this conversation (the same city, trip plan, or earthquakes) and asks for something the app can do: ${CAPABILITIES}. "label" is 2–5 words for a button; "prompt" is the whole request in one natural sentence and is sent on its own, so it names the place, the plan, or the earthquakes it is about. Do not repeat the last request, do not ask about the assistant itself, and write no tool names, code, or links. ${TOPIC_HINTS[context.topic]} Answer with JSON only.`,
    },
    {
      role: "user",
      content: [
        context.previousQuestion ? `Previous request: ${context.previousQuestion}` : null,
        `Last request: ${context.question}`,
        `Answer: ${context.answer}`,
        context.onMap ? `On the map: ${context.onMap}` : null,
      ].filter(Boolean).join("\n"),
    },
  ];
}

const answerSchema = z.object({ suggestions: z.array(z.object({ label: z.string(), prompt: z.string() })) });
const FORBIDDEN = /[{}<>`\[\]]|https?:|www\.|\b(?:search_places|search_events|search_records|get_record_details|list_sources|plan_trip|edit_trip_plan|route_places|reply)\b/i;
const normalize = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The model's suggestions that are safe to show: plain text of bounded length, distinct, not the last request. */
export function cleanFollowUps(raw: string, lastQuestion: string): SuggestedRequest[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const result = answerSchema.safeParse(parsed);
  if (!result.success) return [];
  const seen = new Set([normalize(lastQuestion)]);
  const clean: SuggestedRequest[] = [];
  for (const item of result.data.suggestions) {
    const label = item.label.replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");
    const prompt = item.prompt.replace(/\s+/g, " ").trim();
    if (label.length < 2 || label.length > LABEL_MAX || prompt.length < 4 || prompt.length > PROMPT_MAX) continue;
    if (FORBIDDEN.test(label) || FORBIDDEN.test(prompt)) continue;
    const key = normalize(prompt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push({ label, prompt });
  }
  return clean.length >= 2 ? clean.slice(0, 3) : [];
}

/** Writes the suggestions and sends them as `turn.suggestions`; "none" when the model is busy, slow, or unusable. */
export async function writeFollowUps(context: FollowUpContext, send: (frame: ServerFrame) => void, signal: AbortSignal, deps = { chat }): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  const reply = (suggestions: SuggestedRequest[]) => {
    if (!signal.aborted) send({ protocolVersion: 1, type: "turn.suggestions", requestId: context.requestId, suggestions, source: suggestions.length ? "model" : "none" });
  };
  if (signal.aborted || !tryAcquireBackgroundInference(controller)) {
    signal.removeEventListener("abort", stop);
    reply([]);
    return;
  }
  const startedAt = performance.now();
  try {
    const response = await deps.chat(followUpMessages(context), [], AbortSignal.any([controller.signal, AbortSignal.timeout(FOLLOW_UP_TIMEOUT_MS)]), { format: FORMAT, maxTokens: FOLLOW_UP_MAX_TOKENS, model: env.OLLAMA_MODEL });
    const suggestions = cleanFollowUps(response.message.content, context.question);
    console.info("Assistant follow-ups", { requestId: context.requestId, count: suggestions.length, wallDurationMs: Math.round(performance.now() - startedAt) });
    reply(suggestions);
  } catch (error) {
    // Stopped for the next turn, timed out, or the model failed: the client keeps its own suggestions.
    if (!controller.signal.aborted) console.warn("Assistant follow-ups failed", { requestId: context.requestId, error: error instanceof Error ? error.message : error });
    reply([]);
  } finally {
    signal.removeEventListener("abort", stop);
    releaseInference();
  }
}
