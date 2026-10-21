import { randomUUID } from "node:crypto";
import { database } from "../database/client.js";
import type { CheckedExample, CheckReason } from "../services/teacher/checks.js";

/** Teacher batches and their examples; all SQL is parameterized. */
export type BatchStatus = "generating" | "review" | "accepted" | "failed" | "cancelled";
export type TeacherExampleStatus = "passed" | "disputed" | "rejected" | "edited";

export interface TeacherBatch {
  id: string;
  topic: string;
  languages: string[];
  requested: number;
  model: string;
  crossCheck: boolean;
  status: BatchStatus;
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  counts: Record<TeacherExampleStatus, number>;
  createdAt: string;
  finishedAt: string | null;
}

export interface StoredTeacherExample {
  id: string;
  batchId: string;
  question: string;
  language: string;
  tool: string;
  args: Record<string, unknown>;
  status: TeacherExampleStatus;
  reasons: CheckReason[];
}

type BatchRow = {
  id: string; topic: string; languages: string[]; requested: number; model: string; cross_check: boolean; status: BatchStatus; error_code: string | null;
  prompt_tokens: number; completion_tokens: number; created_at: Date; finished_at: Date | null;
  passed: string | null; disputed: string | null; rejected: string | null; edited: string | null;
};
type ExampleRow = { id: string; batch_id: string; question: string; language: string; tool: string; args: Record<string, unknown>; status: TeacherExampleStatus; reasons: CheckReason[] };

async function rows<T>(sql: string, bind: unknown[] = []): Promise<T[]> {
  const [result] = await database.query(sql, { bind });
  return result as T[];
}

const BATCH_SELECT = `SELECT b.*,
  count(*) FILTER (WHERE e.status = 'passed') AS passed, count(*) FILTER (WHERE e.status = 'disputed') AS disputed,
  count(*) FILTER (WHERE e.status = 'rejected') AS rejected, count(*) FILTER (WHERE e.status = 'edited') AS edited
  FROM teacher_batches b LEFT JOIN teacher_examples e ON e.batch_id = b.id`;

function toBatch(row: BatchRow): TeacherBatch {
  return {
    id: row.id, topic: row.topic, languages: row.languages, requested: Number(row.requested), model: row.model, crossCheck: row.cross_check,
    status: row.status, errorCode: row.error_code, promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens),
    counts: { passed: Number(row.passed ?? 0), disputed: Number(row.disputed ?? 0), rejected: Number(row.rejected ?? 0), edited: Number(row.edited ?? 0) },
    createdAt: new Date(row.created_at).toISOString(), finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

const toExample = (row: ExampleRow): StoredTeacherExample => ({ id: row.id, batchId: row.batch_id, question: row.question, language: row.language, tool: row.tool, args: row.args, status: row.status, reasons: row.reasons });

export async function createBatch(input: { topic: string; languages: string[]; requested: number; model: string; crossCheck: boolean }): Promise<TeacherBatch> {
  const id = randomUUID();
  await rows("INSERT INTO teacher_batches (id, topic, languages, requested, generated, model, cross_check) VALUES ($1, $2, $3::jsonb, $4, $4, $5, $6)", [id, input.topic, JSON.stringify(input.languages), input.requested, input.model, input.crossCheck]);
  return (await getBatch(id))!;
}

export async function getBatch(id: string): Promise<TeacherBatch | null> {
  const [row] = await rows<BatchRow>(`${BATCH_SELECT} WHERE b.id = $1 AND b.status <> 'deleted' GROUP BY b.id`, [id]);
  return row ? toBatch(row) : null;
}

export async function listBatches(limit = 100): Promise<TeacherBatch[]> {
  return (await rows<BatchRow>(`${BATCH_SELECT} WHERE b.status <> 'deleted' GROUP BY b.id ORDER BY b.created_at DESC LIMIT $1`, [limit])).map(toBatch);
}

export async function updateBatch(id: string, patch: { status?: BatchStatus; errorCode?: string | null; generated?: number; usage?: { promptTokens: number; completionTokens: number }; finished?: boolean }): Promise<void> {
  await rows(
    `UPDATE teacher_batches SET status = COALESCE($2, status), error_code = CASE WHEN $3::boolean THEN $4 ELSE error_code END,
       generated = generated + COALESCE($5, 0), prompt_tokens = prompt_tokens + $6, completion_tokens = completion_tokens + $7,
       finished_at = CASE WHEN $8::boolean THEN now() WHEN $2 = 'generating' THEN NULL ELSE finished_at END, updated_at = now()
     WHERE id = $1`,
    [id, patch.status ?? null, patch.errorCode !== undefined, patch.errorCode ?? null, patch.generated ?? null, patch.usage?.promptTokens ?? 0, patch.usage?.completionTokens ?? 0, Boolean(patch.finished)],
  );
}

/** Removes the batch's examples but keeps its row (hidden), so what it cost still counts toward the daily limit. */
export async function deleteBatch(id: string): Promise<boolean> {
  const deleted = await rows<{ id: string }>("UPDATE teacher_batches SET status = 'deleted', updated_at = now() WHERE id = $1 AND status NOT IN ('generating', 'deleted') RETURNING id", [id]);
  if (!deleted.length) return false;
  await rows("DELETE FROM teacher_examples WHERE batch_id = $1", [id]);
  return true;
}

export async function insertExamples(batchId: string, examples: CheckedExample[]): Promise<void> {
  for (const example of examples) {
    await rows(
      "INSERT INTO teacher_examples (id, batch_id, question, language, tool, args, status, reasons) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)",
      [randomUUID(), batchId, example.question.slice(0, 500), example.language, example.call.tool, JSON.stringify(example.call.args), example.status, JSON.stringify(example.reasons)],
    );
  }
}

export async function listExamples(batchId: string): Promise<StoredTeacherExample[]> {
  return (await rows<ExampleRow>("SELECT * FROM teacher_examples WHERE batch_id = $1 ORDER BY created_at, id", [batchId])).map(toExample);
}

export async function getExample(id: string): Promise<StoredTeacherExample | null> {
  const [row] = await rows<ExampleRow>("SELECT * FROM teacher_examples WHERE id = $1", [id]);
  return row ? toExample(row) : null;
}

export async function updateExample(id: string, example: Omit<CheckedExample, "status"> & { status: TeacherExampleStatus }): Promise<StoredTeacherExample | null> {
  const [row] = await rows<ExampleRow>(
    "UPDATE teacher_examples SET question = $2, language = $3, tool = $4, args = $5::jsonb, status = $6, reasons = $7::jsonb, updated_at = now() WHERE id = $1 RETURNING *",
    [id, example.question.slice(0, 500), example.language, example.call.tool, JSON.stringify(example.call.args), example.status, JSON.stringify(example.reasons)],
  );
  return row ? toExample(row) : null;
}

export async function deleteExample(id: string): Promise<boolean> {
  return (await rows<{ id: string }>("DELETE FROM teacher_examples WHERE id = $1 RETURNING id", [id])).length > 0;
}

export async function deleteRejected(batchId: string): Promise<number> {
  return (await rows<{ id: string }>("DELETE FROM teacher_examples WHERE batch_id = $1 AND status = 'rejected' RETURNING id", [batchId])).length;
}

/** Examples asked of the teacher today (UTC), regenerations included: what the daily limit counts. */
export async function generatedToday(): Promise<number> {
  const [row] = await rows<{ total: string | null }>("SELECT sum(generated) AS total FROM teacher_batches WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'");
  return Number(row?.total ?? 0);
}

/** Questions the teacher already wrote and that were not rejected: new examples must differ from them. */
export async function knownQuestions(): Promise<string[]> {
  return (await rows<{ question: string }>("SELECT question FROM teacher_examples WHERE status <> 'rejected'")).map((row) => row.question);
}

/** Examples of accepted batches that passed the checks or were approved by a person: the dataset's teacher part. */
export async function acceptedExamples(): Promise<Array<StoredTeacherExample & { topic: string }>> {
  return (await rows<ExampleRow & { topic: string }>(
    `SELECT e.*, b.topic FROM teacher_examples e JOIN teacher_batches b ON b.id = e.batch_id
     WHERE b.status = 'accepted' AND e.status IN ('passed', 'edited') ORDER BY b.created_at, e.created_at, e.id`,
  )).map((row) => ({ ...toExample(row), topic: row.topic }));
}

/** Batches are generated in this process, so one still marked generating was stopped with the previous process. */
export async function failInterruptedBatches(): Promise<number> {
  return (await rows<{ id: string }>("UPDATE teacher_batches SET status = 'review', error_code = 'interrupted', finished_at = now() WHERE status = 'generating' RETURNING id")).length;
}
