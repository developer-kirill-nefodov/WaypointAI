import { TrainingRequestError } from "./training-api";

const apiBase = import.meta.env.VITE_API_BASE ?? "";
const base = `${apiBase}/api/v1/training/teacher`;

export type TeacherLanguage = "ru" | "en" | "de";
export type ExampleStatus = "passed" | "disputed" | "rejected" | "edited";

export interface TeacherTopic {
  id: string;
  title: Record<TeacherLanguage, string>;
  description: Record<TeacherLanguage, string>;
  tools: string[];
}

export interface TeacherBatch {
  id: string;
  topic: string;
  languages: TeacherLanguage[];
  requested: number;
  model: string;
  crossCheck: boolean;
  status: "generating" | "review" | "accepted" | "failed" | "cancelled";
  errorCode: string | null;
  promptTokens: number;
  completionTokens: number;
  counts: Record<ExampleStatus, number>;
  createdAt: string;
  finishedAt: string | null;
}

export interface TeacherExample {
  id: string;
  batchId: string;
  question: string;
  language: TeacherLanguage;
  tool: string;
  args: Record<string, unknown>;
  status: ExampleStatus;
  reasons: Array<{ code: string; detail?: string }>;
}

export interface TeacherState {
  available: boolean;
  model: string;
  topics: TeacherTopic[];
  languages: TeacherLanguage[];
  usage: { generatedToday: number; dailyLimit: number };
  progress: { batchId: string; done: number; total: number } | null;
  batches: TeacherBatch[];
}

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

const send = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const teacherApi = {
  state: () => request<TeacherState>("/"),
  start: (input: { topic: string; languages: TeacherLanguage[]; count: number; crossCheck: boolean }) => request<{ batch: TeacherBatch }>("/batches", send("POST", input)),
  batch: (id: string) => request<{ batch: TeacherBatch; examples: TeacherExample[] }>(`/batches/${id}`),
  cancel: (id: string) => request<{ cancelling: boolean }>(`/batches/${id}/cancel`, send("POST", {})),
  regenerate: (id: string) => request<{ batch: TeacherBatch }>(`/batches/${id}/regenerate`, send("POST", {})),
  accept: (id: string, accepted: boolean) => request<{ batch: TeacherBatch }>(`/batches/${id}/accept`, send("POST", { accepted })),
  removeBatch: (id: string) => request<void>(`/batches/${id}`, { method: "DELETE" }),
  editExample: (id: string, patch: { question?: string; tool?: string; args?: Record<string, unknown>; approve?: boolean }) => request<{ example: TeacherExample }>(`/examples/${id}`, send("PATCH", patch)),
  removeExample: (id: string) => request<void>(`/examples/${id}`, { method: "DELETE" }),
};
