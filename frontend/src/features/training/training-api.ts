import type { AppliedLesson, EvalResult, EvalRun, ExamCase, ExamCaseInput, Lesson, LessonInput, ModelCard } from "@waypoint-ai/shared";

const apiBase = import.meta.env.VITE_API_BASE ?? "";
const base = `${apiBase}/api/v1/training`;

/** The server's stable error code, and the field it refers to when a lesson or case was refused. */
export class TrainingRequestError extends Error {
  constructor(readonly code: string, readonly status: number, readonly field?: string) {
    super(code);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new TrainingRequestError("network_error", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; field?: string };
    throw new TrainingRequestError(body.error ?? "request_failed", response.status, body.field);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export type TrainingStatus = { editEnabled: boolean; model: string; routerModel: string | null; installedModels: string[]; activeRunId: string | null };

export const trainingApi = {
  status: (signal?: AbortSignal) => request<TrainingStatus>("/status", { signal }),
  model: async (signal?: AbortSignal) => (await request<{ model: ModelCard }>("/model", { signal })).model,
  lessons: async (signal?: AbortSignal) => (await request<{ lessons: Lesson[] }>("/lessons", { signal })).lessons,
  createLesson: async (input: LessonInput) => (await request<{ lesson: Lesson }>("/lessons", send("POST", input))).lesson,
  updateLesson: async (id: string, input: LessonInput | { enabled: boolean }) => (await request<{ lesson: Lesson }>(`/lessons/${id}`, send("PATCH", input))).lesson,
  deleteLesson: (id: string) => request<void>(`/lessons/${id}`, send("DELETE")),
  preview: (message: string) => request<{ applied: AppliedLesson[]; prompt: string | null }>("/lessons/preview", send("POST", { message })),
  cases: async (signal?: AbortSignal) => (await request<{ cases: ExamCase[] }>("/cases", { signal })).cases,
  createCase: async (input: ExamCaseInput) => (await request<{ case: ExamCase }>("/cases", send("POST", input))).case,
  updateCase: async (id: string, input: ExamCaseInput | { enabled: boolean }) => (await request<{ case: ExamCase }>(`/cases/${id}`, send("PATCH", input))).case,
  deleteCase: (id: string) => request<void>(`/cases/${id}`, send("DELETE")),
  addStarterCases: async () => (await request<{ added: number }>("/cases/starter", send("POST", {}))).added,
  runs: (signal?: AbortSignal) => request<{ runs: EvalRun[]; activeRunId: string | null }>("/runs", { signal }),
  run: (id: string, signal?: AbortSignal) => request<{ run: EvalRun; results: EvalResult[] }>(`/runs/${id}`, { signal }),
  startRun: async (input: { withLessons: boolean; label?: string; mode: "full" | "first_step" | "router"; origins: string[]; model?: string }) => (await request<{ run: EvalRun }>("/runs", send("POST", { withLessons: input.withLessons, mode: input.mode, origins: input.origins, ...(input.label ? { label: input.label } : {}), ...(input.model ? { model: input.model } : {}) }))).run,
  generateCases: (perSkill: number, seed: number) => request<{ generated: number; hard: number }>("/cases/generate", send("POST", { perSkill, seed })),
  cancelRun: (id: string) => request<{ cancelling: boolean }>(`/runs/${id}/cancel`, send("POST", {})),
};
