import { randomUUID } from "node:crypto";
import { database } from "../database/client.js";

/** One chat turn as the journal keeps it; parameterized SQL only. */
export interface JournalSignals {
  /** A data tool answered with no rows. */
  emptyResult?: boolean;
  /** search_events or search_places named a settlement that is not in the imported regions. */
  placeNotFound?: string | null;
  /** A tool refused its arguments. */
  invalidArgs?: boolean;
  /** The first answer had no tool call and was retried. */
  retriedWithoutTool?: boolean;
  /** The next message in the conversation came soon after a failed turn: probably the same request reworded. */
  rephrased?: boolean;
}

export interface JournalEntry {
  id: string;
  requestId: string;
  conversationId: string;
  language: string | null;
  message: string;
  model: string;
  toolCalls: Array<{ tool: string; args: unknown; error?: string | null; resultCount?: number | null }>;
  firstTool: string | null;
  outcome: "completed" | "clarification" | "error" | "cancelled";
  errorCode: string | null;
  signals: JournalSignals;
  feedback: -1 | 1 | null;
  durationMs: number;
  reviewStatus: "new" | "confirmed" | "dismissed";
  corrected: { tool: string; args: Record<string, unknown> } | null;
  createdAt: string;
}

export type NewJournalEntry = Omit<JournalEntry, "id" | "feedback" | "reviewStatus" | "corrected" | "createdAt"> & { workspaceId: string };

type Row = {
  id: string; request_id: string; conversation_id: string; language: string | null; message: string; model: string; tool_calls: JournalEntry["toolCalls"];
  first_tool: string | null; outcome: JournalEntry["outcome"]; error_code: string | null; signals: JournalSignals; feedback: number | null; duration_ms: number;
  review_status: JournalEntry["reviewStatus"]; corrected: JournalEntry["corrected"]; created_at: Date;
};

function toEntry(row: Row): JournalEntry {
  return {
    id: row.id,
    requestId: row.request_id,
    conversationId: row.conversation_id,
    language: row.language,
    message: row.message,
    model: row.model,
    toolCalls: row.tool_calls,
    firstTool: row.first_tool,
    outcome: row.outcome,
    errorCode: row.error_code,
    signals: row.signals,
    feedback: row.feedback === 1 || row.feedback === -1 ? row.feedback : null,
    durationMs: Number(row.duration_ms),
    reviewStatus: row.review_status,
    corrected: row.corrected,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function rows<T>(sql: string, bind: unknown[] = []): Promise<T[]> {
  const [result] = await database.query(sql, { bind });
  return result as T[];
}

/** A failed turn followed this soon by another message in the same conversation counts as rephrased. */
const REPHRASE_WINDOW_MS = 3 * 60_000;

/** A turn "went wrong" when any of these signals is set; such entries are review candidates. */
export const FAILURE_SIGNALS_SQL = `(signals->>'emptyResult' = 'true' OR signals->>'placeNotFound' IS NOT NULL OR signals->>'invalidArgs' = 'true'
  OR signals->>'retriedWithoutTool' = 'true' OR signals->>'rephrased' = 'true' OR outcome = 'error' OR feedback = -1)`;

export async function recordTurn(entry: NewJournalEntry): Promise<void> {
  await database.transaction(async (transaction) => {
    // The previous turn of this conversation was probably reworded if it failed and this one followed quickly.
    await database.query(
      `UPDATE turn_journal SET signals = signals || '{"rephrased": true}'::jsonb, updated_at = now()
       WHERE id = (SELECT id FROM turn_journal WHERE conversation_id = $1 AND created_at > now() - ($2 || ' milliseconds')::interval
                   ORDER BY created_at DESC LIMIT 1)
         AND (signals->>'emptyResult' = 'true' OR signals->>'placeNotFound' IS NOT NULL OR signals->>'invalidArgs' = 'true' OR outcome = 'error')`,
      { bind: [entry.conversationId, String(REPHRASE_WINDOW_MS)], transaction },
    );
    await database.query(
      `INSERT INTO turn_journal (id, request_id, conversation_id, workspace_id, language, message, model, tool_calls, first_tool, outcome, error_code, signals, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13)
       ON CONFLICT (request_id) DO NOTHING`,
      {
        bind: [randomUUID(), entry.requestId, entry.conversationId, entry.workspaceId, entry.language, entry.message.slice(0, 2000), entry.model,
          JSON.stringify(entry.toolCalls.slice(0, 8)), entry.firstTool, entry.outcome, entry.errorCode, JSON.stringify(entry.signals), entry.durationMs],
        transaction,
      },
    );
  });
}

/** 1 or -1 from the chat's thumbs; returns false when the turn is not in the journal. */
export async function setFeedback(requestId: string, rating: 1 | -1 | null): Promise<boolean> {
  return (await rows<{ id: string }>("UPDATE turn_journal SET feedback = $2, updated_at = now() WHERE request_id = $1 RETURNING id", [requestId, rating])).length > 0;
}

export async function listJournal(input: { filter: "candidates" | "all" | "confirmed"; limit: number; offset: number }): Promise<{ total: number; entries: JournalEntry[] }> {
  const where = input.filter === "candidates" ? `review_status = 'new' AND ${FAILURE_SIGNALS_SQL}` : input.filter === "confirmed" ? "review_status = 'confirmed'" : "TRUE";
  const [list, [count]] = await Promise.all([
    rows<Row>(`SELECT * FROM turn_journal WHERE ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [input.limit, input.offset]),
    rows<{ total: string }>(`SELECT count(*) AS total FROM turn_journal WHERE ${where}`),
  ]);
  return { total: Number(count?.total ?? 0), entries: list.map(toEntry) };
}

export async function getJournalEntry(id: string): Promise<JournalEntry | null> {
  const [row] = await rows<Row>("SELECT * FROM turn_journal WHERE id = $1", [id]);
  return row ? toEntry(row) : null;
}

export async function reviewJournalEntry(id: string, review: { status: "confirmed"; corrected: { tool: string; args: Record<string, unknown> } } | { status: "dismissed" }): Promise<JournalEntry | null> {
  const [row] = await rows<Row>(
    "UPDATE turn_journal SET review_status = $2, corrected = $3::jsonb, reviewed_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
    [id, review.status, review.status === "confirmed" ? JSON.stringify(review.corrected) : null],
  );
  return row ? toEntry(row) : null;
}

export interface JournalStats {
  total: number;
  candidates: number;
  confirmed: number;
  thumbsUp: number;
  thumbsDown: number;
  /** Share of turns with any failure signal over the last 7 days. */
  failureShareWeek: number | null;
}

export async function journalStats(): Promise<JournalStats> {
  const [row] = await rows<{ total: string; candidates: string; confirmed: string; up: string; down: string; week: string; week_failed: string }>(
    `SELECT count(*) AS total,
       count(*) FILTER (WHERE review_status = 'new' AND ${FAILURE_SIGNALS_SQL}) AS candidates,
       count(*) FILTER (WHERE review_status = 'confirmed') AS confirmed,
       count(*) FILTER (WHERE feedback = 1) AS up, count(*) FILTER (WHERE feedback = -1) AS down,
       count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week,
       count(*) FILTER (WHERE created_at > now() - interval '7 days' AND ${FAILURE_SIGNALS_SQL}) AS week_failed
     FROM turn_journal`,
  );
  const week = Number(row?.week ?? 0);
  return {
    total: Number(row?.total ?? 0),
    candidates: Number(row?.candidates ?? 0),
    confirmed: Number(row?.confirmed ?? 0),
    thumbsUp: Number(row?.up ?? 0),
    thumbsDown: Number(row?.down ?? 0),
    failureShareWeek: week ? Math.round((Number(row?.week_failed ?? 0) / week) * 1000) / 1000 : null,
  };
}

/** What users asked for that the data does not have: settlements outside the imported regions and empty place searches. */
export async function dataGaps(): Promise<{ missingPlaces: Array<{ name: string; count: number; lastAt: string }>; emptySearches: Array<{ city: string; kind: string | null; count: number }> }> {
  const [missing, empty] = await Promise.all([
    rows<{ name: string; count: string; last_at: Date }>(
      `SELECT signals->>'placeNotFound' AS name, count(*) AS count, max(created_at) AS last_at FROM turn_journal
       WHERE signals->>'placeNotFound' IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC, max(created_at) DESC LIMIT 20`,
    ),
    rows<{ city: string; kind: string | null; count: string }>(
      `SELECT call->'args'->>'city' AS city, call->'args'->>'kind' AS kind, count(*) AS count
       FROM turn_journal, jsonb_array_elements(tool_calls) AS call
       WHERE call->>'tool' = 'search_places' AND (call->>'resultCount')::integer = 0 AND call->'args'->>'city' IS NOT NULL
       GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 20`,
    ),
  ]);
  return {
    missingPlaces: missing.map((row) => ({ name: row.name, count: Number(row.count), lastAt: new Date(row.last_at).toISOString() })),
    emptySearches: empty.map((row) => ({ city: row.city, kind: row.kind, count: Number(row.count) })),
  };
}

/** Journal entries older than the retention period are removed; the journal is local working data, not an archive. */
export async function purgeJournal(retentionDays: number): Promise<number> {
  return (await rows<{ id: string }>("DELETE FROM turn_journal WHERE created_at < now() - ($1 || ' days')::interval RETURNING id", [String(retentionDays)])).length;
}

export interface SettlementAlias { alias: string; placeId: string; name: string; countryCode: string | null; origin: string; createdAt: string }

export async function listAliases(): Promise<SettlementAlias[]> {
  const list = await rows<{ alias: string; place_id: string; name: string; country_code: string | null; origin: string; created_at: Date }>(
    "SELECT a.alias, a.place_id, p.name, p.country_code, a.origin, a.created_at FROM settlement_aliases a JOIN places p ON p.id = a.place_id ORDER BY a.created_at DESC",
  );
  return list.map((row) => ({ alias: row.alias, placeId: row.place_id, name: row.name, countryCode: row.country_code, origin: row.origin, createdAt: new Date(row.created_at).toISOString() }));
}

export async function saveAlias(alias: string, placeId: string, origin: "manual" | "journal"): Promise<void> {
  await rows(
    `INSERT INTO settlement_aliases (alias, place_id, origin) VALUES ($1, $2, $3)
     ON CONFLICT (alias) DO UPDATE SET place_id = EXCLUDED.place_id, origin = EXCLUDED.origin, updated_at = now()`,
    [alias.trim().toLocaleLowerCase(), placeId, origin],
  );
}

export async function deleteAlias(alias: string): Promise<boolean> {
  return (await rows<{ alias: string }>("DELETE FROM settlement_aliases WHERE alias = $1 RETURNING alias", [alias.trim().toLocaleLowerCase()])).length > 0;
}
