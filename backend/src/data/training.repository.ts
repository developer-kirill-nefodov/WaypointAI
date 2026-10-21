import { randomUUID } from "node:crypto";
import { database } from "../database/client.js";
import type { Lesson, LessonInput } from "../assistant/lessons.js";
import type { CaseExpectation, CheckResult, ExamCase } from "../services/eval-checks.js";
import type { RunMetrics } from "../services/benchmark-metrics.js";

/** Lessons, exam cases, runs, and results; all SQL is parameterized. */

type LessonRow = {
  id: string; kind: Lesson["kind"]; topic: Lesson["topic"]; title: string; text: string; example_tool: Lesson["exampleTool"];
  example_args: Record<string, unknown> | null; example_answer: string | null; enabled: boolean; version: number;
  applied_count: number; last_applied_at: Date | null; created_at: Date; updated_at: Date;
};

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

function toLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    kind: row.kind,
    topic: row.topic,
    title: row.title,
    text: row.text,
    exampleTool: row.example_tool,
    exampleArgs: row.example_args,
    exampleAnswer: row.example_answer,
    enabled: row.enabled,
    version: Number(row.version),
    appliedCount: Number(row.applied_count),
    lastAppliedAt: iso(row.last_applied_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

async function rows<T>(sql: string, bind: unknown[] = []): Promise<T[]> {
  const [result] = await database.query(sql, { bind });
  return result as T[];
}

/** Enabled lessons are read on every chat turn; they are cached briefly and dropped on any change. */
let enabledCache: { at: number; lessons: Lesson[] } | null = null;
const ENABLED_CACHE_MS = 5_000;

export async function listLessons(): Promise<Lesson[]> {
  return (await rows<LessonRow>("SELECT * FROM lessons ORDER BY kind DESC, created_at")).map(toLesson);
}

export async function enabledLessons(): Promise<Lesson[]> {
  if (enabledCache && Date.now() - enabledCache.at < ENABLED_CACHE_MS) return enabledCache.lessons;
  const lessons = (await rows<LessonRow>("SELECT * FROM lessons WHERE enabled ORDER BY created_at")).map(toLesson);
  enabledCache = { at: Date.now(), lessons };
  return lessons;
}

export async function createLesson(input: LessonInput): Promise<Lesson> {
  enabledCache = null;
  const example = input.kind === "example" ? input : null;
  const [row] = await rows<LessonRow>(
    `INSERT INTO lessons (id, kind, topic, title, text, example_tool, example_args, example_answer, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING *`,
    [randomUUID(), input.kind, input.topic, input.title, input.text, example?.exampleTool ?? null,
      example?.exampleArgs ? JSON.stringify(example.exampleArgs) : null, example?.exampleAnswer ?? null, input.enabled ?? true],
  );
  return toLesson(row!);
}

/** Replaces a lesson's content (a new version) or only switches it on or off. */
export async function updateLesson(id: string, input: LessonInput | { enabled: boolean }): Promise<Lesson | null> {
  enabledCache = null;
  if (!("kind" in input)) {
    const [row] = await rows<LessonRow>("UPDATE lessons SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, input.enabled]);
    return row ? toLesson(row) : null;
  }
  const example = input.kind === "example" ? input : null;
  const [row] = await rows<LessonRow>(
    `UPDATE lessons SET kind = $2, topic = $3, title = $4, text = $5, example_tool = $6, example_args = $7::jsonb, example_answer = $8,
       enabled = coalesce($9, enabled), version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, input.kind, input.topic, input.title, input.text, example?.exampleTool ?? null,
      example?.exampleArgs ? JSON.stringify(example.exampleArgs) : null, example?.exampleAnswer ?? null, input.enabled ?? null],
  );
  return row ? toLesson(row) : null;
}

export async function deleteLesson(id: string): Promise<boolean> {
  enabledCache = null;
  return (await rows<{ id: string }>("DELETE FROM lessons WHERE id = $1 RETURNING id", [id])).length > 0;
}

/** Counts how often each lesson reached the model, for the lesson list. */
export async function markLessonsApplied(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await rows("UPDATE lessons SET applied_count = applied_count + 1, last_applied_at = now() WHERE id = ANY($1::uuid[])", [ids]);
}

type CaseRow = { id: string; question: string; language: ExamCase["language"]; expect: CaseExpectation; enabled: boolean; skill: string; origin: string };
const toCase = (row: CaseRow): ExamCase => ({ id: row.id, question: row.question, language: row.language, expect: row.expect, enabled: row.enabled, skill: row.skill, origin: row.origin });
const CASE_COLUMNS = "id, question, language, expect, enabled, skill, origin";

export async function listCases(): Promise<ExamCase[]> {
  return (await rows<CaseRow>(`SELECT ${CASE_COLUMNS} FROM eval_cases ORDER BY created_at, id`)).map(toCase);
}

/** Replaces the generated cases with a new set; hand-written and confirmed cases are kept. */
export async function replaceGeneratedCases(cases: ExamCase[]): Promise<number> {
  return database.transaction(async (transaction) => {
    await database.query("DELETE FROM eval_cases WHERE origin = 'generated'", { transaction });
    for (let offset = 0; offset < cases.length; offset += 200) {
      const batch = cases.slice(offset, offset + 200);
      await database.query(
        `INSERT INTO eval_cases (id, question, language, expect, enabled, skill, origin)
         SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::jsonb[], $5::boolean[], $6::varchar[], $7::varchar[])
         ON CONFLICT (id) DO NOTHING`,
        {
          bind: [batch.map((item) => item.id), batch.map((item) => item.question), batch.map((item) => item.language), batch.map((item) => JSON.stringify(item.expect)),
            batch.map((item) => item.enabled), batch.map((item) => item.skill ?? "other"), batch.map(() => "generated")],
          transaction,
        },
      );
    }
    return cases.length;
  });
}

export async function saveCase(examCase: ExamCase): Promise<ExamCase> {
  const [row] = await rows<CaseRow>(
    `INSERT INTO eval_cases (id, question, language, expect, enabled, skill, origin) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET question = EXCLUDED.question, language = EXCLUDED.language, expect = EXCLUDED.expect,
       enabled = EXCLUDED.enabled, skill = EXCLUDED.skill, updated_at = now()
     RETURNING ${CASE_COLUMNS}`,
    [examCase.id, examCase.question, examCase.language, JSON.stringify(examCase.expect), examCase.enabled, examCase.skill ?? "other", examCase.origin ?? "manual"],
  );
  return toCase(row!);
}

export async function deleteCase(id: string): Promise<boolean> {
  return (await rows<{ id: string }>("DELETE FROM eval_cases WHERE id = $1 RETURNING id", [id])).length > 0;
}

/** Adds the cases that are not there yet; existing ones, possibly edited, are kept. */
export async function addMissingCases(cases: ExamCase[]): Promise<number> {
  let added = 0;
  for (const examCase of cases) {
    const inserted = await rows<{ id: string }>(
      "INSERT INTO eval_cases (id, question, language, expect, enabled, skill, origin) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) ON CONFLICT (id) DO NOTHING RETURNING id",
      [examCase.id, examCase.question, examCase.language, JSON.stringify(examCase.expect), examCase.enabled, examCase.skill ?? "other", examCase.origin ?? "manual"],
    );
    added += inserted.length;
  }
  return added;
}

export type EvalRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface EvalRun {
  id: string;
  status: EvalRunStatus;
  mode: "full" | "first_step";
  caseOrigins: string[];
  metrics: RunMetrics | null;
  withLessons: boolean;
  lessonIds: string[];
  model: string;
  label: string | null;
  caseCount: number;
  casesDone: number;
  casesPassed: number;
  checksTotal: number;
  checksPassed: number;
  /** Share of passed checks, 0..1; null until a case finishes. */
  score: number | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface EvalResult {
  caseId: string;
  question: string;
  skill: string;
  language: string | null;
  passed: boolean;
  checks: CheckResult[];
  toolCalls: Array<{ tool: string; args: unknown }>;
  answer: string;
  appliedLessons: Array<{ id: string; title: string; kind: string; score: number }>;
  durationMs: number;
  errorCode: string | null;
}

type RunRow = {
  id: string; status: EvalRunStatus; mode: EvalRun["mode"]; case_origins: string[]; metrics: RunMetrics | null; with_lessons: boolean; lesson_ids: string[]; model: string; label: string | null; case_count: number;
  cases_done: number; cases_passed: number; checks_total: number; checks_passed: number; error_code: string | null; started_at: Date; finished_at: Date | null;
};

function toRun(row: RunRow): EvalRun {
  const checksTotal = Number(row.checks_total);
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    caseOrigins: row.case_origins,
    metrics: row.metrics,
    withLessons: row.with_lessons,
    lessonIds: row.lesson_ids,
    model: row.model,
    label: row.label,
    caseCount: Number(row.case_count),
    casesDone: Number(row.cases_done),
    casesPassed: Number(row.cases_passed),
    checksTotal,
    checksPassed: Number(row.checks_passed),
    score: checksTotal ? Math.round((Number(row.checks_passed) / checksTotal) * 1000) / 1000 : null,
    errorCode: row.error_code,
    startedAt: iso(row.started_at)!,
    finishedAt: iso(row.finished_at),
  };
}

export async function createRun(input: { withLessons: boolean; lessonIds: string[]; model: string; label: string | null; caseCount: number; mode: EvalRun["mode"]; caseOrigins: string[] }): Promise<EvalRun> {
  const [row] = await rows<RunRow>(
    `INSERT INTO eval_runs (id, status, with_lessons, lesson_ids, model, label, case_count, started_at, mode, case_origins)
     VALUES ($1, 'running', $2, $3::jsonb, $4, $5, $6, now(), $7, $8::jsonb) RETURNING *`,
    [randomUUID(), input.withLessons, JSON.stringify(input.lessonIds), input.model, input.label, input.caseCount, input.mode, JSON.stringify(input.caseOrigins)],
  );
  return toRun(row!);
}

/** Stores one case's result and adds it to the run's totals in the same transaction. */
export async function addResult(runId: string, result: EvalResult): Promise<EvalRun> {
  return database.transaction(async (transaction) => {
    await database.query(
      `INSERT INTO eval_results (run_id, case_id, question, passed, checks, tool_calls, answer, applied_lessons, duration_ms, error_code, skill, language)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12)`,
      {
        bind: [runId, result.caseId, result.question, result.passed, JSON.stringify(result.checks), JSON.stringify(result.toolCalls),
          result.answer.slice(0, 8000), JSON.stringify(result.appliedLessons), result.durationMs, result.errorCode, result.skill, result.language],
        transaction,
      },
    );
    const [updated] = await database.query(
      `UPDATE eval_runs SET cases_done = cases_done + 1, cases_passed = cases_passed + $2::integer,
         checks_total = checks_total + $3, checks_passed = checks_passed + $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      { bind: [runId, result.passed ? 1 : 0, result.checks.length, result.checks.filter((check) => check.passed).length], transaction },
    );
    return toRun((updated as RunRow[])[0]!);
  });
}

export async function finishRun(runId: string, status: Exclude<EvalRunStatus, "running">, errorCode: string | null = null, metrics: RunMetrics | null = null): Promise<void> {
  await rows("UPDATE eval_runs SET status = $2, error_code = $3, metrics = $4::jsonb, finished_at = now(), updated_at = now() WHERE id = $1", [runId, status, errorCode, metrics ? JSON.stringify(metrics) : null]);
}

export async function listRuns(limit = 50): Promise<EvalRun[]> {
  return (await rows<RunRow>("SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT $1", [limit])).map(toRun);
}

export async function getRun(id: string): Promise<{ run: EvalRun; results: EvalResult[] } | null> {
  const [row] = await rows<RunRow>("SELECT * FROM eval_runs WHERE id = $1", [id]);
  if (!row) return null;
  const results = await rows<{ case_id: string; question: string; skill: string; language: string | null; passed: boolean; checks: CheckResult[]; tool_calls: EvalResult["toolCalls"]; answer: string; applied_lessons: EvalResult["appliedLessons"]; duration_ms: number; error_code: string | null }>(
    "SELECT * FROM eval_results WHERE run_id = $1 ORDER BY created_at, case_id", [id],
  );
  return {
    run: toRun(row),
    results: results.map((result) => ({
      caseId: result.case_id,
      question: result.question,
      skill: result.skill,
      language: result.language,
      passed: result.passed,
      checks: result.checks,
      toolCalls: result.tool_calls,
      answer: result.answer,
      appliedLessons: result.applied_lessons,
      durationMs: Number(result.duration_ms),
      errorCode: result.error_code,
    })),
  };
}

/**
 * Settlements for generated benchmark cases: every city with its English name, and the towns of the area where
 * events are imported (Central Italy), whose questions find real events.
 */
export async function benchmarkSettlements(): Promise<{ cities: Array<{ name: string; nameEn: string | null; countryCode: string | null }>; eventTowns: Array<{ name: string; nameEn: string | null; countryCode: string | null }> }> {
  const settlements = (sql: string) => rows<{ name: string; name_en: string | null; country_code: string | null }>(sql)
    .then((list) => list.filter((row) => /^\p{L}[\p{L} '’.-]{1,40}$/u.test(row.name)).map((row) => ({ name: row.name, nameEn: row.name_en, countryCode: row.country_code })));
  const [cities, eventTowns] = await Promise.all([
    settlements("SELECT DISTINCT ON (name) name, tags->>'name:en' AS name_en, country_code FROM places WHERE category = 'place:city' ORDER BY name, id"),
    settlements(`SELECT DISTINCT ON (name) name, tags->>'name:en' AS name_en, country_code FROM places
      WHERE category IN ('place:city', 'place:town') AND country_code = 'IT' AND lat BETWEEN 42.0 AND 43.8 AND lon BETWEEN 12.0 AND 13.8 ORDER BY name, id`),
  ]);
  return { cities, eventTowns };
}

/** Runs execute in this process, so a run still marked running was stopped with the previous process. */
export async function failInterruptedRuns(): Promise<number> {
  return (await rows<{ id: string }>("UPDATE eval_runs SET status = 'failed', error_code = 'interrupted', finished_at = now() WHERE status = 'running' RETURNING id")).length;
}
