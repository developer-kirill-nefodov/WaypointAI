import { TrainingRequestError } from "./training-api";

const apiBase = import.meta.env.VITE_API_BASE ?? "";
const base = `${apiBase}/api/v1/training/finetune`;

export interface LoraRun {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  phase: string;
  baseModel: string;
  epochs: number;
  learningRate: number;
  rank: number;
  examples: number | null;
  device: string | null;
  step: number;
  totalSteps: number | null;
  epoch: number | null;
  etaSeconds: number | null;
  peakMemoryMb: number | null;
  losses: Array<{ step: number; loss: number | null; validationLoss: number | null }>;
  /** When each stage began: training stages, then publishing (merging, converting, creating), published, benchmark. */
  timeline: Array<{ phase: string; at: string }>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  autoBenchmark: boolean;
  publishedAs: string | null;
  publishing: string | null;
  publishError: string | null;
  benchmarkRunId: string | null;
  benchmarkError: string | null;
  imported: { fromRunId: string; kind: "adapter" | "gguf"; at: string } | null;
  exports: { adapter: boolean; gguf: boolean };
}

export type PackageKind = "adapter" | "gguf";

export interface FinetuneState {
  availability: { python: boolean; dataset: boolean; converter?: boolean };
  baseModels: string[];
  dataset: { total: number; bySkill: Record<string, number>; byLanguage: Record<string, number>; bySource: Record<string, number>; byTopic?: Record<string, number>; excludedAsBenchmark: number; createdAt: string; path: string } | null;
  runs: LoraRun[];
  activeRunId: string | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined });
  } catch {
    throw new TrainingRequestError("network_error", 0);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; detail?: string };
    throw new TrainingRequestError(body.detail ? `${body.error}: ${body.detail}` : body.error ?? "request_failed", response.status);
  }
  return (await response.json()) as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const finetuneApi = {
  state: () => request<FinetuneState>("/"),
  buildDataset: (perSkill: number) => request<{ dataset: FinetuneState["dataset"] }>("/dataset", post({ perSkill })),
  start: (input: { baseModel: string; epochs: number; rank: number; autoBenchmark: boolean }) => request<{ run: LoraRun }>("/runs", post(input)),
  cancel: (id: string) => request<{ cancelling: boolean }>(`/runs/${id}/cancel`, post({})),
  publish: (id: string) => request<{ run: LoraRun }>(`/runs/${id}/publish`, post({})),
  /** A plain link: the browser downloads the package itself. */
  exportUrl: (id: string, kind: PackageKind) => `${base}/runs/${id}/export?kind=${kind}`,
  /** Uploads a package with progress (fetch cannot report upload progress); resolves with the new run. */
  importPackage: (file: File, onProgress: (share: number) => void) => new Promise<LoraRun>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/import`);
    xhr.setRequestHeader("content-type", "application/x-tar");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onerror = () => reject(new TrainingRequestError("network_error", 0));
    xhr.onload = () => {
      let body: { run?: LoraRun; error?: string } = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body.run) resolve(body.run);
      else reject(new TrainingRequestError(body.error ?? "request_failed", xhr.status));
    };
    xhr.send(file);
  }),
};
