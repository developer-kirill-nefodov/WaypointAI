import { TrainingRequestError } from "./training-api";

const apiBase = import.meta.env.VITE_API_BASE ?? "";
const base = `${apiBase}/api/v1/training`;

export interface JournalEntry {
  id: string;
  requestId: string;
  language: string | null;
  message: string;
  model: string;
  toolCalls: Array<{ tool: string; args: unknown; error?: string | null; resultCount?: number | null }>;
  firstTool: string | null;
  outcome: "completed" | "clarification" | "error" | "cancelled";
  errorCode: string | null;
  signals: { emptyResult?: boolean; placeNotFound?: string | null; invalidArgs?: boolean; retriedWithoutTool?: boolean; rephrased?: boolean };
  feedback: 1 | -1 | null;
  durationMs: number;
  reviewStatus: "new" | "confirmed" | "dismissed";
  corrected: { tool: string; args: Record<string, unknown> } | null;
  createdAt: string;
}

export interface JournalStats { total: number; candidates: number; confirmed: number; thumbsUp: number; thumbsDown: number; failureShareWeek: number | null }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined });
  } catch {
    throw new TrainingRequestError("network_error", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new TrainingRequestError(body.error ?? "request_failed", response.status);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const journalApi = {
  list: (filter: "candidates" | "all" | "confirmed", limit: number, offset: number) =>
    request<{ total: number; entries: JournalEntry[]; stats: JournalStats }>(`/journal?filter=${filter}&limit=${limit}&offset=${offset}`),
  review: (id: string, review: { status: "confirmed"; tool: string; args: Record<string, unknown> } | { status: "dismissed" }) =>
    request<{ entry: JournalEntry }>(`/journal/${id}/review`, { method: "POST", body: JSON.stringify(review) }),
  feedback: (requestId: string, rating: 1 | -1 | null) => request<void>("/journal/feedback", { method: "POST", body: JSON.stringify({ requestId, rating }) }),
  gaps: () => request<{ missingPlaces: Array<{ name: string; count: number; lastAt: string }>; emptySearches: Array<{ city: string; kind: string | null; count: number }> }>("/gaps"),
  aliases: async () => (await request<{ aliases: Array<{ alias: string; placeId: string; name: string; countryCode: string | null; origin: string; createdAt: string }> }>("/aliases")).aliases,
  addAlias: (alias: string, settlement: string) => request<unknown>("/aliases", { method: "POST", body: JSON.stringify({ alias, settlement }) }),
  deleteAlias: (alias: string) => request<void>(`/aliases/${encodeURIComponent(alias)}`, { method: "DELETE" }),
};
