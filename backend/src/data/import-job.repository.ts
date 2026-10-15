import { database } from "../database/client.js";
import type { ImportJob, ImportJobStore } from "../services/import-jobs.js";

type JobRow = {
  id: string;
  workspace_id: string;
  status: ImportJob["status"];
  params: ImportJob["params"];
  progress: number;
  sources: ImportJob["sources"];
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
};

function toJob(row: JobRow): ImportJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    // Jobs saved before import kinds existed were event imports without step counts.
    params: "kind" in row.params ? row.params : { ...(row.params as object), kind: "events" } as ImportJob["params"],
    progress: Number(row.progress),
    sources: row.sources.map((source) => ({ ...source, stepsDone: source.stepsDone ?? 0, stepsTotal: source.stepsTotal ?? 0 })),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export const sqlImportJobStore: ImportJobStore = {
  async save(job) {
    await database.query(
      `INSERT INTO import_jobs (id, workspace_id, status, params, progress, sources, created_at, updated_at, finished_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, progress = EXCLUDED.progress, sources = EXCLUDED.sources,
         updated_at = EXCLUDED.updated_at, finished_at = EXCLUDED.finished_at`,
      { bind: [job.id, job.workspaceId, job.status, JSON.stringify(job.params), job.progress, JSON.stringify(job.sources), job.createdAt, job.updatedAt, job.finishedAt] },
    );
  },

  async get(id, workspaceId) {
    const [rows] = await database.query("SELECT * FROM import_jobs WHERE id = $1 AND workspace_id = $2", { bind: [id, workspaceId] });
    const row = (rows as JobRow[])[0];
    return row ? toJob(row) : null;
  },

  async list(workspaceId, { active, limit }) {
    const [rows] = await database.query(
      `SELECT * FROM import_jobs WHERE workspace_id = $1 ${active ? "AND status = 'running'" : ""} ORDER BY created_at DESC LIMIT $2`,
      { bind: [workspaceId, Math.min(Math.max(limit, 1), 50)] },
    );
    return (rows as JobRow[]).map(toJob);
  },

  async clearFinished(workspaceId) {
    // Only the job history; imported data and the per-source sync runs stay.
    const [, result] = await database.query("DELETE FROM import_jobs WHERE workspace_id = $1 AND status <> 'running'", { bind: [workspaceId] });
    return (result as { rowCount?: number } | undefined)?.rowCount ?? 0;
  },

  async failInterrupted() {
    const [, result] = await database.query(
      `UPDATE import_jobs SET status = 'failed', finished_at = now(), updated_at = now(),
         sources = (SELECT COALESCE(jsonb_agg(CASE WHEN source->>'status' IN ('pending', 'running')
           THEN source || '{"status": "failed", "errorCode": "import_interrupted"}'::jsonb ELSE source END), '[]'::jsonb)
           FROM jsonb_array_elements(sources) AS source)
       WHERE status = 'running'`,
    );
    return (result as { rowCount?: number } | undefined)?.rowCount ?? 0;
  },
};
