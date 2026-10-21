import type { Citation, PlaceView, RecordView, SearchArea, SourceView, TripPlan } from "@waypoint-ai/shared";

/** One line of the progress feed shown while a turn runs, kept on the answer it produced. */
/**
 * One line of a turn's progress feed. startedAt is the client's clock when the step began (for the live timer);
 * durationMs is the server's measure once it ended; progress is the model call running inside it.
 */
export type TurnStep = {
  id: string; label: string; state: "running" | "done" | "failed"; detail?: string;
  startedAt?: number; durationMs?: number;
  progress?: { phase: "reading" | "generating"; tokens: number; tokensPerSecond?: number };
};
/** How a turn ended: an answer, a clarifying question, an error, a stop, or a lost connection. */
export type MessageKind = "answer" | "clarification" | "error" | "cancelled" | "lost";
/** What the answer put on the map, for its "on the map" line. */
const MESSAGE_KINDS: MessageKind[] = ["answer", "clarification", "error", "cancelled", "lost"];
export type ResultSummary = { places: number; records: number; tripDays: number | null };
export type Message = {
  role: "assistant" | "user"; text: string; durationMs?: number; choices?: Array<{ id: string; label: string }>; steps?: TurnStep[];
  streaming?: boolean; citations?: Citation[]; citationsMode?: "cited" | "shown_to_model"; requestId?: string;
  /** When the message was sent or the answer arrived (epoch ms). */
  at?: number; kind?: MessageKind; models?: string[]; result?: ResultSummary;
  /** The request an error or a stop belongs to, for "Send again". */
  query?: string;
};

/** What the last completed turn of a chat put on the map, kept so the chat can be reopened with its results. */
export interface ChatResult {
  places: PlaceView[];
  records: RecordView[];
  tripPlan: TripPlan | null;
  searchArea: SearchArea | null;
  appliedFilters: Array<Record<string, unknown>>;
  sources: SourceView[];
}

export type SavedChat = { id: string; conversationId: string | null; messages: Message[]; savedAt: number; result: ChatResult | null };
export type SavedConversation = SavedChat & { recentChats: SavedChat[] };

export const HISTORY_STORAGE_KEY = "waypoint-ai:assistant-history:v1";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 100;
const MAX_RECENT_CHATS = 30;
const MAX_STORED_RECORDS = 50;
const MAX_STORED_PLACES = 100;
/** Results above this serialized size are not stored; the chat text is kept either way. */
const MAX_RESULT_CHARACTERS = 300_000;

/** Trims a turn result to what the map needs; returns null when it is empty or too large to store. */
export function compactResult(result: ChatResult): ChatResult | null {
  const compact: ChatResult = {
    places: result.places.slice(0, MAX_STORED_PLACES),
    records: result.records.slice(0, MAX_STORED_RECORDS),
    tripPlan: result.tripPlan,
    searchArea: result.searchArea,
    appliedFilters: result.appliedFilters,
    sources: result.sources,
  };
  const empty = !compact.places.length && !compact.records.length && !compact.tripPlan && !compact.searchArea;
  if (empty) return null;
  return JSON.stringify(compact).length > MAX_RESULT_CHARACTERS ? null : compact;
}

/**
 * Saves the conversation. When the browser quota is exceeded, stored results are dropped starting with the
 * oldest chat, then the current one; messages are never dropped. Returns false when nothing could be saved.
 */
export function writeSavedConversation(conversation: SavedConversation): boolean {
  const recentChats = conversation.recentChats.slice(0, MAX_RECENT_CHATS).map((chat) => ({ ...chat, messages: chat.messages.slice(-MAX_MESSAGES) }));
  let current: SavedConversation = { ...conversation, messages: conversation.messages.slice(-MAX_MESSAGES), recentChats };
  for (let dropped = 0; dropped <= recentChats.length + 1; dropped += 1) {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(current));
      return true;
    } catch {
      const withResult = [...current.recentChats].reverse().find((chat) => chat.result);
      if (withResult) {
        current = { ...current, recentChats: current.recentChats.map((chat) => chat.id === withResult.id ? { ...chat, result: null } : chat) };
      } else if (current.result) {
        current = { ...current, result: null };
      } else {
        return false;
      }
    }
  }
  return false;
}

export function readSavedConversation(welcome: Message): SavedConversation {
  const empty: SavedConversation = { id: crypto.randomUUID(), conversationId: null, messages: [welcome], savedAt: Date.now(), result: null, recentChats: [] };
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return empty;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return empty;
    const saved = value as Record<string, unknown>;
    if (typeof saved.savedAt !== "number" || Date.now() - saved.savedAt > RETENTION_MS) {
      window.localStorage.removeItem(HISTORY_STORAGE_KEY);
      return empty;
    }
    const recentChats = Array.isArray(saved.recentChats) ? saved.recentChats
      .filter((chat): chat is Record<string, unknown> => Boolean(chat && typeof chat === "object"))
      .filter((chat) => typeof chat.id === "string" && typeof chat.savedAt === "number" && Date.now() - chat.savedAt <= RETENTION_MS)
      .map((chat) => ({
        id: chat.id as string,
        conversationId: readConversationId(chat.conversationId),
        messages: readMessages(chat.messages),
        savedAt: chat.savedAt as number,
        result: readResult(chat.result),
      }))
      .filter((chat) => chat.messages.some((message) => message.role === "user"))
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, MAX_RECENT_CHATS) : [];
    const messages = readMessages(saved.messages);
    return {
      id: typeof saved.id === "string" && saved.id.length <= 120 ? saved.id : crypto.randomUUID(),
      conversationId: readConversationId(saved.conversationId),
      messages: messages.length ? messages : [welcome],
      savedAt: saved.savedAt,
      result: readResult(saved.result),
      recentChats,
    };
  } catch {
    return empty;
  }
}

export function lastUserMessage(messages: Message[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.text ?? "";
}

function readConversationId(value: unknown): string | null {
  return typeof value === "string" && value.length <= 120 ? value : null;
}

function readMessages(value: unknown): Message[] {
  return Array.isArray(value) ? value.filter((item): item is Message =>
    Boolean(item && typeof item === "object" && "role" in item && "text" in item)
    && ((item as Message).role === "user" || (item as Message).role === "assistant")
    && typeof (item as Message).text === "string",
  ).slice(-MAX_MESSAGES).map(({ streaming: _streaming, citations, citationsMode, requestId, kind, models, result, at, query, ...message }) => {
    if (typeof requestId === "string" && requestId.length <= 120) (message as Message).requestId = requestId;
    // Fields added later are kept only in the shape the chat writes them.
    if (typeof kind === "string" && MESSAGE_KINDS.includes(kind)) (message as Message).kind = kind;
    if (Array.isArray(models) && models.length <= 4 && models.every((model) => typeof model === "string" && model.length <= 120)) (message as Message).models = models;
    if (result && typeof result === "object" && [result.places, result.records].every((count) => Number.isInteger(count) && count >= 0) && (result.tripDays === null || Number.isInteger(result.tripDays))) {
      (message as Message).result = { places: result.places, records: result.records, tripDays: result.tripDays };
    }
    if (typeof at === "number" && Number.isFinite(at)) (message as Message).at = at;
    if (typeof query === "string" && query.length <= 4000) (message as Message).query = query;
    const valid = Array.isArray(citations) ? citations.filter(isCitation).slice(0, 20) : [];
    return valid.length ? { ...message, citations: valid, citationsMode: citationsMode === "shown_to_model" ? "shown_to_model" : "cited" } : message;
  }) : [];
}

/** A stored citation is shown as a link, so only refs, labels, and HTTPS URLs of the expected shape are kept. */
function isCitation(value: unknown): value is Citation {
  if (!value || typeof value !== "object") return false;
  const citation = value as Citation;
  return typeof citation.ref === "string" && /^[EP]\d{1,3}$/.test(citation.ref)
    && (citation.entityType === "record" || citation.entityType === "place")
    && typeof citation.id === "string" && typeof citation.sourceId === "string" && typeof citation.label === "string"
    && (citation.url === null || (typeof citation.url === "string" && citation.url.startsWith("https://")))
    && (citation.observedAt === undefined || typeof citation.observedAt === "string");
}

/** Browser storage can be edited or stale; anything that does not look like a stored result is ignored. */
function readResult(value: unknown): ChatResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  const places = Array.isArray(result.places) ? result.places.filter(isPoint) as PlaceView[] : [];
  const records = Array.isArray(result.records)
    ? result.records.filter((record) => isPoint(record) && Boolean((record as RecordView).attributes && typeof (record as RecordView).attributes === "object")) as RecordView[]
    : [];
  const tripPlan = isTripPlan(result.tripPlan) ? result.tripPlan : null;
  const searchArea = isSearchArea(result.searchArea) ? result.searchArea : null;
  const appliedFilters = Array.isArray(result.appliedFilters)
    ? result.appliedFilters.filter((filter): filter is Record<string, unknown> => Boolean(filter && typeof filter === "object"))
    : [];
  const sources = Array.isArray(result.sources)
    ? result.sources.filter((source): source is SourceView => Boolean(source && typeof source === "object" && typeof (source as SourceView).id === "string"))
    : [];
  return compactResult({ places, records, tripPlan, searchArea, appliedFilters, sources });
}

function isPoint(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.lat === "number" && typeof item.lon === "number";
}

function isTripPlan(value: unknown): value is TripPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return typeof plan.city === "string" && typeof plan.totalDays === "number" && Array.isArray(plan.days)
    && plan.days.every((day) => Boolean(day && typeof day === "object" && Array.isArray((day as Record<string, unknown>).stopPlaceIds)));
}

function isSearchArea(value: unknown): value is SearchArea {
  if (!value || typeof value !== "object") return false;
  const area = value as Record<string, unknown>;
  return typeof area.lat === "number" && typeof area.lon === "number" && typeof area.radiusKm === "number" && typeof area.label === "string";
}
