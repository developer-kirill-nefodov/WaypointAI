import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { PACKAGE_FILES, PackageError, readPackage, writePackage, type PackageKind } from "./model-package.js";

/**
 * Runs router fine-tuning (model/training/train_router.py) as a child process and publishes the result to Ollama
 * (merge_adapter.py for an imported adapter, then publish_router.sh). Only fixed scripts run, with arguments validated
 * here; nothing from a request reaches a shell. State is kept in each run's folder, so the list survives a server
 * restart. A run can be exported as a package and a package imported as a new run.
 */
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
  /** Epochs done so far, fractional. */
  epoch: number | null;
  etaSeconds: number | null;
  /** Peak memory of the training process. */
  peakMemoryMb: number | null;
  /** Training loss per step and validation loss when measured. */
  losses: Array<{ step: number; loss: number | null; validationLoss: number | null }>;
  /** When each stage began, training and publishing alike. */
  timeline: Array<{ phase: string; at: string }>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Publish to Ollama and run the router benchmark once training succeeds. */
  autoBenchmark: boolean;
  publishedAs: string | null;
  /** The publishing stage while it runs: merging, converting, or creating. */
  publishing: string | null;
  publishError: string | null;
  benchmarkRunId: string | null;
  benchmarkError: string | null;
  imported: { fromRunId: string; kind: PackageKind; at: string } | null;
  /** Which export packages the run's files allow. */
  exports: { adapter: boolean; gguf: boolean };
}

export interface TrainerPaths {
  root: string;
  python: string;
  script: string;
  mergeScript: string;
  publishScript: string;
  /** llama.cpp's GGUF converter, needed to publish to Ollama. */
  converter: string;
  dataset: string;
  runs: string;
}

export interface TrainerHooks {
  /** Starts the router benchmark of a published model; resolves with the benchmark run's id. */
  benchmark?(model: string): Promise<string>;
}

/** Base models a run may start from: small instruct models of the same family as the main model. */
export const LORA_BASE_MODELS = ["Qwen/Qwen3-0.6B", "Qwen/Qwen3-1.7B"] as const;

/** Memory a training run may use; above it only the run is stopped, not the server or the rest of the session. */
const TRAINING_MEMORY_LIMIT = "12G";

/** Runs the command in its own systemd scope with a memory limit when systemd-run is available. */
function withMemoryLimit(command: string, args: string[]): [string, string[]] {
  if (process.platform !== "linux" || !existsSync("/usr/bin/systemd-run")) return [command, args];
  return ["/usr/bin/systemd-run", ["--user", "--scope", "--quiet", "-p", `MemoryMax=${TRAINING_MEMORY_LIMIT}`, "-p", "MemorySwapMax=0", "--", command, ...args]];
}

/** Writes through a temporary file and a rename, so a crash never leaves a truncated run.json. */
async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

const newRunId = () => `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6)}`;
/** Paths are not shown to the page. */
const withoutPaths = (message: string) => message.replace(/\/[^\s]+/g, "…").slice(0, 300);

export class TrainerBusyError extends Error { readonly code = "training_running"; }
export class RunNotFinishedError extends Error { readonly code = "run_not_finished"; }
export class PublishBusyError extends Error { readonly code = "publish_running"; }
export class ExportUnavailableError extends Error { readonly code = "export_unavailable"; }
export class TrainerUnavailableError extends Error { constructor(readonly code: "python_missing" | "dataset_missing" | "converter_missing") { super(code); } }

export class LoraTrainer {
  #process: ChildProcess | null = null;
  /** Runs changed in memory now (training or publishing); their state wins over run.json. */
  #live = new Map<string, LoraRun>();
  #trainingId: string | null = null;
  #publishingId: string | null = null;

  constructor(private readonly paths: TrainerPaths, private readonly hooks: TrainerHooks = {}) {}

  availability() {
    return { python: existsSync(this.paths.python), dataset: existsSync(this.paths.dataset), converter: existsSync(this.paths.converter) };
  }

  get active(): LoraRun | null {
    const run = this.#trainingId ? this.#live.get(this.#trainingId) : null;
    return run?.status === "running" ? run : null;
  }

  async list(): Promise<LoraRun[]> {
    if (!existsSync(this.paths.runs)) return [];
    const ids = await readdir(this.paths.runs);
    const runs = await Promise.all(ids.map((id) => this.#read(id)));
    return runs.filter((run): run is LoraRun => Boolean(run)).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async #read(id: string): Promise<LoraRun | null> {
    const live = this.#live.get(id);
    const folder = join(this.paths.runs, id);
    let run: LoraRun;
    if (live) run = live;
    else {
      try { run = normalize(JSON.parse(await readFile(join(folder, "run.json"), "utf8")) as Partial<LoraRun>); } catch { return null; }
      // A run that was training or publishing when the server stopped did not finish.
      if (run.status === "running") run = { ...run, status: "failed", error: run.error ?? "interrupted" };
      if (run.publishing) run = { ...run, publishing: null, publishError: "interrupted" };
    }
    const adapter = run.status === "succeeded" && existsSync(join(folder, PACKAGE_FILES.adapterWeights));
    return { ...run, exports: { adapter, gguf: adapter && existsSync(join(folder, PACKAGE_FILES.gguf)) } };
  }

  async start(input: { baseModel: string; epochs: number; learningRate: number; rank: number; autoBenchmark: boolean }): Promise<LoraRun> {
    if (this.active) throw new TrainerBusyError("training_running");
    const available = this.availability();
    if (!available.python) throw new TrainerUnavailableError("python_missing");
    if (!available.dataset) throw new TrainerUnavailableError("dataset_missing");
    const id = newRunId();
    const folder = join(this.paths.runs, id);
    await mkdir(folder, { recursive: true });
    const startedAt = new Date().toISOString();
    const run: LoraRun = normalize({ id, status: "running", phase: "starting", ...input, startedAt, timeline: [{ phase: "starting", at: startedAt }] });
    this.#live.set(id, run);
    this.#trainingId = id;
    await this.#save(run);
    const child = spawn(...withMemoryLimit(this.paths.python, [
      this.paths.script, "--data", this.paths.dataset, "--out", folder, "--base", input.baseModel,
      "--epochs", String(input.epochs), "--learning-rate", String(input.learningRate), "--rank", String(input.rank),
    ]), { cwd: this.paths.root, env: { ...process.env, TOKENIZERS_PARALLELISM: "false", HF_HUB_DISABLE_TELEMETRY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    this.#process = child;
    let buffer = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) this.#onLine(run, line);
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    child.on("close", (code, signal) => {
      if (run.status === "running") {
        run.status = signal === "SIGTERM" ? "cancelled" : code === 0 ? "succeeded" : "failed";
        // SIGKILL comes from the memory limit (or the kernel), and Python has no chance to print anything first.
        if (run.status === "failed" && !run.error) run.error = signal === "SIGKILL"
          ? `out_of_memory: training used more than ${TRAINING_MEMORY_LIMIT} of memory and was stopped`
          : stderr.trim().split("\n").at(-1)?.slice(0, 300) || `exit ${code ?? signal}`;
      }
      run.finishedAt = new Date().toISOString();
      this.#process = null;
      this.#trainingId = null;
      void writeFile(join(folder, "stderr.log"), stderr).catch(() => undefined);
      void this.#save(run).then(() => {
        if (this.#publishingId !== id) this.#live.delete(id);
        // Publish and benchmark right away when asked at the start.
        if (run.status === "succeeded" && run.autoBenchmark) void this.publish(id, { benchmark: true }).catch(() => undefined);
      });
    });
    return run;
  }

  cancel(id: string): boolean {
    if (this.#trainingId !== id || !this.#process) return false;
    this.#process.kill("SIGTERM");
    return true;
  }

  /**
   * Registers a finished run in Ollama as waypoint-router:<id>, in the background: a ready GGUF is created directly,
   * a merged model is converted first, and an adapter alone (an imported package) is merged into its base model first.
   */
  async publish(id: string, options: { benchmark?: boolean } = {}): Promise<LoraRun> {
    if (this.#publishingId) throw new PublishBusyError("publish_running");
    const stored = await this.#read(id);
    if (!stored || stored.status !== "succeeded") throw new RunNotFinishedError("run_not_finished");
    const folder = join(this.paths.runs, id);
    const gguf = join(folder, PACKAGE_FILES.gguf);
    const merged = join(folder, "merged");
    const hasMerged = existsSync(join(merged, "config.json"));
    if (!existsSync(gguf) && !existsSync(this.paths.converter)) throw new TrainerUnavailableError("converter_missing");
    if (!existsSync(gguf) && !hasMerged && !existsSync(this.paths.python)) throw new TrainerUnavailableError("python_missing");
    const run = this.#live.get(id) ?? stored;
    this.#live.set(id, run);
    this.#publishingId = id;
    run.publishError = null;
    run.benchmarkError = null;
    this.#stage(run, existsSync(gguf) ? "creating" : hasMerged ? "converting" : "merging", true);
    await this.#save(run);
    void (async () => {
      const name = `waypoint-router:${id}`;
      try {
        if (!existsSync(gguf) && !hasMerged) {
          await this.#exec(...withMemoryLimit(this.paths.python, [this.paths.mergeScript, "--adapter", join(folder, "adapter"), "--base", run.baseModel, "--out", merged]), () => undefined);
        }
        await this.#exec("bash", [this.paths.publishScript, existsSync(gguf) ? gguf : merged, name], (line) => {
          const stage = /^STAGE (converting|creating)$/.exec(line.trim())?.[1];
          if (stage) { this.#stage(run, stage, true); void this.#save(run); }
        });
        run.publishedAs = name;
        this.#stage(run, "published", false);
        if (options.benchmark && this.hooks.benchmark) {
          try {
            run.benchmarkRunId = await this.hooks.benchmark(name);
            this.#stage(run, "benchmark", false);
          } catch (error) {
            run.benchmarkError = (error as { code?: string }).code ?? "benchmark_failed";
          }
        }
      } catch (error) {
        // The runtime's own message (for example an unsupported architecture) is shown, without paths.
        run.publishError = withoutPaths(error instanceof Error ? error.message : String(error));
      } finally {
        run.publishing = null;
        this.#publishingId = null;
        await this.#save(run);
        if (this.#trainingId !== id) this.#live.delete(id);
      }
    })();
    return run;
  }

  /** Writes a finished run as a package: the adapter, and for "gguf" the model ready for Ollama. */
  async exportRun(id: string, kind: PackageKind, output: Writable): Promise<void> {
    const run = await this.#read(id);
    if (!run || run.status !== "succeeded") throw new RunNotFinishedError("run_not_finished");
    if (!run.exports[kind]) throw new ExportUnavailableError("export_unavailable");
    const { id: runId, baseModel, epochs, learningRate, rank, examples, device, losses, startedAt, finishedAt } = run;
    await writePackage(join(this.paths.runs, id), { id: runId, baseModel, epochs, learningRate, rank, examples, device, losses, startedAt, finishedAt }, kind, output);
  }

  /** Reads a package (an uploaded file) into a new run; nothing is kept when any check fails. */
  async importPackage(archive: string): Promise<LoraRun> {
    const id = newRunId();
    const folder = join(this.paths.runs, id);
    await mkdir(folder, { recursive: true });
    try {
      const manifest = await readPackage(archive, folder, LORA_BASE_MODELS);
      await rm(join(folder, PACKAGE_FILES.manifest), { force: true });
      const at = new Date().toISOString();
      const { run: source } = manifest;
      const run = normalize({
        id, status: "succeeded", phase: "done", baseModel: source.baseModel, epochs: source.epochs, learningRate: source.learningRate, rank: source.rank,
        examples: source.examples, device: source.device, losses: source.losses, startedAt: at, finishedAt: at,
        timeline: [{ phase: "imported", at }], imported: { fromRunId: source.id, kind: manifest.kind, at },
      });
      await this.#save(run);
      return (await this.#read(id))!;
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error instanceof PackageError ? error : new PackageError("not_a_package");
    }
  }

  #stage(run: LoraRun, phase: string, publishing: boolean): void {
    if (publishing) run.publishing = phase;
    else run.phase = phase === "published" || phase === "benchmark" ? run.phase : phase;
    if (run.timeline.at(-1)?.phase !== phase) run.timeline.push({ phase, at: new Date().toISOString() });
  }

  /** Runs a fixed script; rejects with its last line of output. */
  #exec(command: string, args: string[], onLine: (line: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.paths.root, env: { ...process.env, TOKENIZERS_PARALLELISM: "false", HF_HUB_DISABLE_TELEMETRY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-2000);
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(onLine);
      });
      child.stderr!.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2000); });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) return resolve();
        const last = output.trim().split("\n").at(-1) ?? "";
        let message = last;
        try { message = String((JSON.parse(last) as { message?: unknown }).message ?? last); } catch { /* plain text */ }
        reject(new Error(signal === "SIGKILL" ? `out_of_memory: more than ${TRAINING_MEMORY_LIMIT} of memory` : message || `exit ${code ?? signal}`));
      });
    });
  }

  #onLine(run: LoraRun, line: string): void {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    if (event.event === "status") {
      this.#stage(run, String(event.phase ?? run.phase).slice(0, 40), false);
      if (typeof event.device === "string") run.device = event.device.slice(0, 20);
      if (typeof event.train === "number") run.examples = event.train;
    } else if (event.event === "progress") {
      this.#stage(run, "training", false);
      run.step = number(event.step) ?? run.step;
      run.totalSteps = number(event.total) ?? run.totalSteps;
      run.epoch = number(event.epoch) ?? run.epoch;
      run.etaSeconds = number(event.eta_seconds);
      run.peakMemoryMb = number(event.peak_memory_mb) ?? run.peakMemoryMb;
      run.losses.push({ step: run.step, loss: number(event.loss), validationLoss: number(event.validation_loss) });
      if (run.losses.length > 2000) run.losses.splice(0, run.losses.length - 2000);
    } else if (event.event === "done") {
      this.#stage(run, "done", false);
      run.status = "succeeded";
    } else if (event.event === "error") {
      run.status = "failed";
      run.error = String(event.message ?? "training failed").slice(0, 300);
    }
    void this.#save(run);
  }

  async #save(run: LoraRun): Promise<void> {
    const { exports: _exports, ...stored } = run;
    await writeAtomically(join(this.paths.runs, run.id, "run.json"), JSON.stringify(stored, null, 1)).catch(() => undefined);
  }
}

/** Fills fields that older run.json files do not have. */
function normalize(run: Partial<LoraRun>): LoraRun {
  return {
    id: run.id ?? "", status: run.status ?? "failed", phase: run.phase ?? "done", baseModel: run.baseModel ?? "", epochs: run.epochs ?? 0,
    learningRate: run.learningRate ?? 0, rank: run.rank ?? 0, examples: run.examples ?? null, device: run.device ?? null, step: run.step ?? 0,
    totalSteps: run.totalSteps ?? null, epoch: run.epoch ?? null, etaSeconds: run.etaSeconds ?? null, peakMemoryMb: run.peakMemoryMb ?? null,
    losses: run.losses ?? [], timeline: run.timeline ?? [], error: run.error ?? null, startedAt: run.startedAt ?? new Date(0).toISOString(),
    finishedAt: run.finishedAt ?? null, autoBenchmark: run.autoBenchmark ?? false, publishedAs: run.publishedAs ?? null, publishing: run.publishing ?? null,
    publishError: run.publishError ?? null, benchmarkRunId: run.benchmarkRunId ?? null, benchmarkError: run.benchmarkError ?? null,
    imported: run.imported ?? null, exports: run.exports ?? { adapter: false, gguf: false },
  };
}
