import { Check, Download, Loader2, Play, Square, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { invalidateCache, useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { formatEventTime, pick } from "../investigation/format";
import { finetuneApi, type LoraRun } from "./finetune-api";
import { useChartWidth } from "./QualityTab";
import TeacherSection from "./TeacherSection";
import { TrainingRequestError } from "./training-api";

const refresh = () => invalidateCache("training:finetune");

/**
 * Fine-tuning the router with LoRA: examples from the teacher, the dataset, training in a local Python process,
 * publishing to Ollama, and the benchmark; a trained run can be exported and imported as a package. The page only
 * starts fixed scripts with validated settings.
 */
export default function FinetuneTab({ language, editEnabled, onCompare }: { language: Language; editEnabled: boolean; onCompare(model: string): void }) {
  const t = makeT(language);
  const state = useCachedQuery("training:finetune", () => finetuneApi.state(), 10_000);
  const data = state.data;
  const active = data?.activeRunId ?? null;
  const busy = Boolean(active) || Boolean(data?.runs.some((run) => run.publishing));
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, [busy]);
  if (!data) return <p className="data-empty">{state.error ? t("Не удалось загрузить состояние дообучения.", "Could not load the fine-tuning state.") : t("Загружаю…", "Loading…")}</p>;
  return <div className="training-finetune">
    <p className="training-intro">{t(
      "Маленькая модель учится одному делу — выбирать инструмент и аргументы по короткому промпту. Она быстрее основной, а качество решает бенчмарк: модель включается только если она не хуже.",
      "A small model learns one task: choosing the tool and its arguments from a short prompt. It is faster than the main model, and the benchmark decides: it is used only if it is not worse.",
    )}</p>
    <ol className="training-pipeline">
      <TeacherSection language={language} editEnabled={editEnabled} step={1} />
      <DatasetStep language={language} editEnabled={editEnabled} dataset={data.dataset} />
      <li className={data.availability.python ? "done" : "todo"}>
        <h3 className="data-section-title">3. {t("Окружение Python", "Python environment")}</h3>
        {data.availability.python ? <p>{data.availability.converter ? t("Готово: model/training/.venv и конвертер GGUF.", "Ready: model/training/.venv and the GGUF converter.") : t("Python готов; для публикации в Ollama нужен конвертер GGUF (см. model/training/README.md).", "Python is ready; publishing to Ollama needs the GGUF converter (see model/training/README.md).")}</p> : <>
          <p>{t("Нужно один раз установить PyTorch, transformers и peft (около 1–2 ГБ, версия для CPU). Базовая модель скачается с Hugging Face при первом запуске.", "Install PyTorch, transformers, and peft once (about 1–2 GB, CPU build). The base model is downloaded from Hugging Face on the first run.")}</p>
          <pre className="training-prompt">python3 -m venv model/training/.venv{"\n"}model/training/.venv/bin/pip install -r model/training/requirements.txt</pre>
        </>}
      </li>
      <TrainStep language={language} editEnabled={editEnabled && data.availability.python && data.availability.dataset} baseModels={data.baseModels} active={active} />
    </ol>
    <section className="training-group">
      <div className="training-runs-head">
        <h3 className="data-section-title">{t("Запуски обучения", "Training runs")}</h3>
        {editEnabled && <ImportButton language={language} />}
      </div>
      {data.runs.length ? <ul className="training-list">{data.runs.map((run) => <RunRow key={run.id} language={language} run={run} editEnabled={editEnabled} onCompare={onCompare} />)}</ul>
        : <p className="data-empty">{t("Запусков ещё не было.", "No runs yet.")}</p>}
    </section>
  </div>;
}

function DatasetStep({ language, editEnabled, dataset }: { language: Language; editEnabled: boolean; dataset: Awaited<ReturnType<typeof finetuneApi.state>>["dataset"] }) {
  const t = makeT(language);
  const [perSkill, setPerSkill] = useState(150);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const build = async () => {
    setBusy(true);
    setError(null);
    try { await finetuneApi.buildDataset(perSkill); refresh(); } catch (failure) { setError(failure instanceof TrainingRequestError ? failure.code : "request_failed"); } finally { setBusy(false); }
  };
  const list = (counts: Record<string, number>) => Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(" · ");
  return <li className={dataset ? "done" : "todo"}>
    <h3 className="data-section-title">2. {t("Набор данных", "Dataset")}</h3>
    {dataset ? <dl className="training-facts">
      <div><dt>{t("Примеров", "Examples")}</dt><dd>{dataset.total} · {formatEventTime(dataset.createdAt, language)}</dd></div>
      <div><dt>{t("Навыки", "Skills")}</dt><dd>{list(dataset.bySkill)}</dd></div>
      <div><dt>{t("Языки", "Languages")}</dt><dd>{list(dataset.byLanguage)}</dd></div>
      <div><dt>{t("Источники", "Sources")}</dt><dd>{list(dataset.bySource)}</dd></div>
      {dataset.byTopic && Object.keys(dataset.byTopic).length > 0 && <div><dt>{t("От учителя", "From the teacher")}</dt><dd>{list(dataset.byTopic)}</dd></div>}
      <div><dt>{t("Без утечки", "No leakage")}</dt><dd>{pick(language, { ru: `исключено вопросов из бенчмарка: ${dataset.excludedAsBenchmark}`, en: `benchmark questions left out: ${dataset.excludedAsBenchmark}`, de: `Benchmark-Fragen ausgeschlossen: ${dataset.excludedAsBenchmark}` })}</dd></div>
      <div><dt>{t("Файл", "File")}</dt><dd><code>{dataset.path}</code></dd></div>
    </dl> : <p>{t("Синтетические вопросы из базы (другое зерно, чем у бенчмарка), принятые партии учителя и подтверждённые ходы журнала.", "Synthetic questions from the database (another seed than the benchmark), accepted teacher batches, and confirmed journal turns.")}</p>}
    {editEnabled && <div className="training-actions training-generate">
      <label><span>{t("Примеров на навык", "Examples per skill")}</span><input type="number" min={20} max={500} value={perSkill} onChange={(event) => setPerSkill(Math.min(500, Math.max(20, Number(event.target.value) || 150)))} /></label>
      <button type="button" className="data-text-button" disabled={busy} onClick={build}>{busy ? <Loader2 size={13} className="spin" /> : null}{dataset ? t("Собрать заново", "Rebuild") : t("Собрать", "Build")}</button>
    </div>}
    {error && <p className="training-error" role="alert">{error}</p>}
  </li>;
}

function TrainStep({ language, editEnabled, baseModels, active }: { language: Language; editEnabled: boolean; baseModels: string[]; active: string | null }) {
  const t = makeT(language);
  const [baseModel, setBaseModel] = useState(baseModels[0] ?? "Qwen/Qwen3-0.6B");
  const [epochs, setEpochs] = useState(2);
  const [rank, setRank] = useState(16);
  const [autoBenchmark, setAutoBenchmark] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setError(null);
    try { await finetuneApi.start({ baseModel, epochs, rank, autoBenchmark }); refresh(); } catch (failure) {
      const code = failure instanceof TrainingRequestError ? failure.code : "request_failed";
      setError(code === "python_missing" ? t("Сначала установите окружение Python (шаг 3).", "Install the Python environment first (step 3).") : code === "dataset_missing" ? t("Сначала соберите набор данных (шаг 2).", "Build the dataset first (step 2).") : code);
    }
  };
  return <li className={active ? "active" : "todo"}>
    <h3 className="data-section-title">4. {t("Обучение LoRA", "LoRA training")}</h3>
    <p>{t("На CPU это займёт от десятков минут до нескольких часов: модель 0.6B быстрее, 1.7B точнее. Пока идёт обучение, чат работает, но медленнее.", "On a CPU this takes from tens of minutes to a few hours: 0.6B is faster, 1.7B more accurate. The chat keeps working meanwhile, more slowly.")}</p>
    <div className="training-actions training-generate">
      <label><span>{t("Базовая модель", "Base model")}</span><select value={baseModel} onChange={(event) => setBaseModel(event.target.value)}>{baseModels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label><span>{t("Эпох", "Epochs")}</span><input type="number" min={0.5} max={5} step={0.5} value={epochs} onChange={(event) => setEpochs(Number(event.target.value) || 2)} /></label>
      <label><span>{t("Ранг LoRA", "LoRA rank")}</span><select value={rank} onChange={(event) => setRank(Number(event.target.value))}>{[8, 16, 32].map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <button type="button" className="data-primary" disabled={!editEnabled || Boolean(active)} onClick={start}><Play size={13} />{t("Начать обучение", "Start training")}</button>
    </div>
    <label className="investigation-toggle"><input type="checkbox" checked={autoBenchmark} onChange={(event) => setAutoBenchmark(event.target.checked)} /><span>{t("Потом сразу опубликовать в Ollama и проверить на бенчмарке (режим маршрутизатора)", "Then publish to Ollama and run the benchmark right away (router mode)")}</span></label>
    {error && <p className="training-error" role="alert">{error}</p>}
  </li>;
}

/** Uploads a package (.tar) as a new run; the server checks it before keeping anything. */
function ImportButton({ language }: { language: Language }) {
  const t = makeT(language);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File) => {
    setError(null);
    setProgress(0);
    try { await finetuneApi.importPackage(file, setProgress); refresh(); } catch (failure) { setError(packageError(failure instanceof TrainingRequestError ? failure.code : "request_failed", t)); } finally { setProgress(null); }
  };
  return <div className="training-import">
    <input ref={input} type="file" accept=".tar,application/x-tar" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
    {progress !== null ? <span className="training-import-progress">
      <Loader2 size={13} className="spin" />{progress < 1 ? pick(language, { ru: `Загрузка ${Math.round(progress * 100)}%`, en: `Uploading ${Math.round(progress * 100)}%`, de: `Hochladen ${Math.round(progress * 100)} %` }) : t("Проверяю пакет…", "Checking the package…")}
      <span className="training-progress"><span style={{ width: `${progress * 100}%` }} /></span>
    </span> : <button type="button" className="data-text-button" title={t("Пакет .tar, экспортированный из Waypoint AI: адаптер LoRA или готовая модель GGUF", "A .tar package exported from Waypoint AI: a LoRA adapter or a ready GGUF model")} onClick={() => input.current?.click()}><Upload size={12} />{t("Импортировать модель", "Import a model")}</button>}
    {error && <small className="training-error" role="alert">{error}</small>}
  </div>;
}

function RunRow({ language, run, editEnabled, onCompare }: { language: Language; run: LoraRun; editEnabled: boolean; onCompare(model: string): void }) {
  const t = makeT(language);
  const [error, setError] = useState<string | null>(null);
  const publish = async () => {
    setError(null);
    try { await finetuneApi.publish(run.id); refresh(); } catch (failure) { setError(packageError(failure instanceof TrainingRequestError ? failure.code : "publish_failed", t)); }
  };
  const lastValidation = [...run.losses].reverse().find((point) => point.validationLoss !== null)?.validationLoss ?? null;
  const title = run.imported
    ? pick(language, { ru: `Импорт · ${run.baseModel} · ранг ${run.rank}`, en: `Imported · ${run.baseModel} · rank ${run.rank}`, de: `Importiert · ${run.baseModel} · Rang ${run.rank}` })
    : `${run.baseModel} · ${pick(language, { ru: `${run.epochs} эп. · ранг ${run.rank}`, en: `${run.epochs} ep. · rank ${run.rank}`, de: `${run.epochs} Ep. · Rang ${run.rank}` })}`;
  const meta = [
    formatEventTime(run.startedAt, language),
    run.imported ? pick(language, { ru: `из запуска ${run.imported.fromRunId} (${run.imported.kind === "gguf" ? "GGUF" : "адаптер"})`, en: `from run ${run.imported.fromRunId} (${run.imported.kind === "gguf" ? "GGUF" : "adapter"})`, de: `aus Lauf ${run.imported.fromRunId} (${run.imported.kind === "gguf" ? "GGUF" : "Adapter"})` }) : run.device,
    run.examples ? pick(language, { ru: `${run.examples} примеров`, en: `${run.examples} examples`, de: `${run.examples} Beispiele` }) : null,
    lastValidation !== null ? `val loss ${lastValidation.toFixed(3)}` : null,
  ].filter(Boolean).join(" · ");
  const working = run.status === "running" || Boolean(run.publishing);
  return <li className="training-item journal">
    <span className={`training-result-icon ${run.status === "succeeded" && !run.publishError ? "ok" : run.status === "failed" || run.publishError ? "bad" : ""}`}>{working ? <Loader2 size={12} className="spin" /> : run.status === "succeeded" && !run.publishError ? <Check size={12} /> : <X size={12} />}</span>
    <div className="training-item-copy">
      <strong>{title}</strong>
      <small>{meta}</small>
      <RunStages language={language} run={run} />
      {run.losses.length > 1 && <LossChart language={language} run={run} />}
      {run.error && <small className="training-error">{run.error.startsWith("out_of_memory") ? t("Не хватило памяти: обучение превысило лимит и было остановлено. Уменьшите число эпох или ранг либо закройте другие программы.", "Out of memory: training went over the limit and was stopped. Lower the epochs or rank, or close other programs.") : run.error}</small>}
      {run.publishError && <small className="training-error">{t("Публикация не удалась:", "Publishing failed:")} {run.publishError === "interrupted" ? t("прервана перезапуском сервера", "interrupted by a server restart") : run.publishError}</small>}
      {run.benchmarkError && <small className="training-error">{t("Бенчмарк не запустился:", "The benchmark did not start:")} {run.benchmarkError === "exam_running" ? t("уже идёт другой прогон", "another run is in progress") : run.benchmarkError}</small>}
      {error && <small className="training-error">{error}</small>}
      <div className="training-actions">
        {run.status === "running" && editEnabled && <button type="button" className="data-text-button" onClick={async () => { await finetuneApi.cancel(run.id).catch(() => undefined); refresh(); }}><Square size={12} />{t("Остановить", "Stop")}</button>}
        {run.status === "succeeded" && !run.publishedAs && !run.publishing && editEnabled && <button type="button" className="data-primary" onClick={publish}><Upload size={13} />{t("Опубликовать в Ollama", "Publish to Ollama")}</button>}
        {run.publishedAs && <><code>{run.publishedAs}</code><button type="button" className="data-text-button" onClick={() => onCompare(run.publishedAs!)}>{run.benchmarkRunId ? t("Результат бенчмарка →", "Benchmark result →") : t("Сравнить на бенчмарке →", "Compare on the benchmark →")}</button></>}
        {editEnabled && run.exports.adapter && <span className="training-export">
          <Download size={12} aria-hidden />
          <a className="data-text-button" href={finetuneApi.exportUrl(run.id, "adapter")} download title={t("Только поправки LoRA (десятки МБ): для подключения нужен Python и та же базовая модель", "Only the LoRA weights (tens of MB): connecting it needs Python and the same base model")}>{t("Адаптер", "Adapter")}</a>
          {run.exports.gguf && <a className="data-text-button" href={finetuneApi.exportUrl(run.id, "gguf")} download title={t("Адаптер и готовая модель для Ollama (сотни МБ): встаёт сразу", "The adapter and the model ready for Ollama (hundreds of MB): works right away")}>GGUF</a>}
        </span>}
      </div>
    </div>
  </li>;
}

type StageState = "done" | "active" | "failed" | "pending";
interface Stage { id: string; label: string; state: StageState; at: string | null; until: string | null; detail?: string }

/** Training phases from the script and publishing phases from the backend, in the order they happen. */
const TRAINING_STAGES = [["loading", ["starting", "loading"]], ["tokenized", ["tokenized"]], ["training", ["training"]], ["saving", ["saving", "done"]]] as const;

/** The run's stages from its timeline: what is done, what runs now (with progress), and where it stopped. */
export function runStages(run: LoraRun, t: Translator, language: Language): Stage[] {
  const labels: Record<string, string> = {
    imported: t("Импорт", "Import"), loading: t("Загрузка модели", "Loading the model"), tokenized: t("Подготовка примеров", "Preparing examples"),
    training: t("Обучение", "Training"), saving: t("Сохранение", "Saving"), merging: t("Слияние адаптера", "Merging the adapter"),
    converting: t("Конвертация GGUF", "Converting to GGUF"), creating: t("Ollama", "Ollama"), benchmark: t("Бенчмарк", "Benchmark"),
  };
  const stageOf = (phase: string) => TRAINING_STAGES.find(([, phases]) => (phases as readonly string[]).includes(phase))?.[0] ?? phase;
  const timeline = run.timeline.length ? run.timeline : [
    // Runs from before the timeline: what their state implies, without times.
    ...(run.status === "succeeded" ? TRAINING_STAGES.map(([id]) => ({ phase: id, at: "" })) : []),
    ...(run.publishedAs ? [{ phase: "creating", at: "" }, { phase: "published", at: "" }] : []),
  ];
  const reached = timeline.map((entry) => ({ id: stageOf(entry.phase), at: entry.at }));
  const ids: string[] = [
    ...(run.imported ? ["imported"] : TRAINING_STAGES.map(([id]) => id)),
    ...(reached.some((entry) => entry.id === "merging") ? ["merging"] : []),
    ...(run.imported?.kind === "gguf" ? [] : ["converting"]),
    "creating",
    ...(run.autoBenchmark || run.benchmarkRunId ? ["benchmark"] : []),
  ];
  const lastIndex = Math.max(-1, ...reached.map((entry) => ids.indexOf(entry.id)));
  const published = reached.some((entry) => entry.id === "published");
  return ids.map((id, index): Stage => {
    const start = reached.find((entry) => entry.id === id)?.at || null;
    const next = reached.find((entry) => ids.indexOf(entry.id) > index || entry.id === "published")?.at || null;
    const isTraining = TRAINING_STAGES.some(([stage]) => stage === id);
    let state: StageState = index < lastIndex ? "done" : index > lastIndex ? "pending" : "done";
    if (index === lastIndex) {
      if (isTraining && run.status === "running") state = "active";
      else if (isTraining && run.status !== "succeeded") state = "failed";
      else if (!isTraining && run.publishing) state = "active";
      else if (!isTraining && run.publishError && !published) state = "failed";
    }
    // Stages that a stopped run never reached stay pending; the creating stage is done only once published.
    if (id === "creating" && state === "done" && !published) state = run.publishing ? "active" : run.publishError ? "failed" : "pending";
    let detail: string | undefined;
    if (id === "training" && (state === "active" || state === "done") && run.totalSteps) {
      detail = [
        run.epoch !== null ? pick(language, { ru: `эпоха ${run.epoch.toFixed(1)}/${run.epochs}`, en: `epoch ${run.epoch.toFixed(1)}/${run.epochs}`, de: `Epoche ${run.epoch.toFixed(1)}/${run.epochs}` }) : null,
        `${run.step}/${run.totalSteps}`,
        state === "active" && run.etaSeconds ? `~${Math.max(1, Math.round(run.etaSeconds / 60))} ${t("мин", "min")}` : null,
        run.peakMemoryMb ? `${(run.peakMemoryMb / 1024).toFixed(1)} ${t("ГБ", "GB")}` : null,
      ].filter(Boolean).join(" · ");
    }
    if (id === "benchmark" && state === "done") detail = t("запущен", "started");
    // A training stage ends with the run, not when publishing starts later.
    const until = start && isTraining && run.finishedAt && (!next || next > run.finishedAt) ? run.finishedAt : next;
    return { id, label: labels[id] ?? id, state, at: start, until: state === "active" ? null : until, ...(detail ? { detail } : {}) };
  });
}

function duration(from: string | null, until: string | null, t: Translator): string | null {
  if (!from) return null;
  const seconds = Math.max(0, Math.round(((until ? Date.parse(until) : Date.now()) - Date.parse(from)) / 1000));
  if (seconds < 1) return null;
  const minutes = t("мин", "min");
  return seconds < 60 ? `${seconds} ${t("с", "s")}` : seconds < 3600 ? `${Math.round(seconds / 60)} ${minutes}` : `${Math.floor(seconds / 3600)} ${t("ч", "h")} ${Math.round((seconds % 3600) / 60)} ${minutes}`;
}

function RunStages({ language, run }: { language: Language; run: LoraRun }) {
  const t = makeT(language);
  const stages = runStages(run, t, language).map((stage) => ({ ...stage, note: [stage.detail, (stage.state === "done" || stage.state === "active") && stage.id !== "imported" ? duration(stage.at, stage.until, t) : null].filter(Boolean).join(" · ") }));
  const current = stages.find((stage) => stage.state === "active");
  return <div className="run-stages">
    <ol aria-label={t("Этапы", "Stages")}>
      {stages.map((stage) => <li key={stage.id} className={stage.state} aria-current={stage.state === "active" ? "step" : undefined}>
        <span className="run-stage-dot">{stage.state === "done" ? <Check size={9} /> : stage.state === "failed" ? <X size={9} /> : stage.state === "active" ? <Loader2 size={9} className="spin" /> : null}</span>
        <span className="run-stage-copy"><span>{stage.label}</span>{stage.note && <small>{stage.note}</small>}</span>
      </li>)}
    </ol>
    {current?.id === "training" && run.totalSteps && <div className="training-progress"><span style={{ width: `${(run.step / run.totalSteps) * 100}%` }} /></div>}
  </div>;
}

function packageError(code: string, t: Translator): string {
  const labels: Record<string, string> = {
    not_a_package: t("Это не пакет модели Waypoint AI.", "This is not a Waypoint AI model package."),
    unexpected_entry: t("В пакете есть лишние или опасные файлы — импорт отклонён.", "The package has extra or unsafe files, so it was refused."),
    too_large: t("Пакет слишком большой.", "The package is too large."),
    checksum_mismatch: t("Файлы пакета повреждены или изменены (sha256 не совпадает).", "The package's files are damaged or changed (SHA-256 mismatch)."),
    unsupported_base_model: t("Адаптер сделан для базовой модели, которой здесь нет.", "The adapter is for a base model this machine does not train."),
    invalid_weights: t("Веса модели в пакете повреждены.", "The model weights in the package are damaged."),
    missing_file: t("В пакете не хватает файлов.", "The package is missing files."),
    import_running: t("Уже идёт другой импорт.", "Another import is in progress."),
    unsupported_media_type: t("Нужен файл .tar.", "A .tar file is needed."),
    publish_running: t("Уже публикуется другая модель.", "Another model is being published."),
    converter_missing: t("Нет конвертера GGUF (см. model/training/README.md).", "The GGUF converter is missing (see model/training/README.md)."),
    python_missing: t("Для слияния адаптера нужно окружение Python (шаг 3).", "Merging an adapter needs the Python environment (step 3)."),
    run_not_finished: t("Запуск ещё не завершён.", "The run has not finished."),
  };
  return labels[code] ?? code;
}

/** Training loss per step and validation loss where measured. */
function LossChart({ language, run }: { language: Language; run: LoraRun }) {
  const t = makeT(language);
  const points = run.losses.filter((point) => point.loss !== null || point.validationLoss !== null);
  const values = points.flatMap((point) => [point.loss, point.validationLoss]).filter((value): value is number => value !== null);
  const max = Math.max(...values, 0.01);
  const lastStep = Math.max(run.totalSteps ?? 0, ...points.map((point) => point.step), 1);
  const [chartRef, width] = useChartWidth();
  const height = 120;
  const x = (step: number) => 30 + (step / lastStep) * (width - 40);
  const y = (value: number) => 8 + (1 - value / max) * (height - 24);
  const line = (key: "loss" | "validationLoss") => points.filter((point) => point[key] !== null).map((point) => `${x(point.step)},${y(point[key]!)}`).join(" ");
  return <figure className="training-curve training-loss" ref={chartRef}>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("Потери при обучении", "Training loss")}>
      <line x1={30} x2={width - 10} y1={y(0)} y2={y(0)} className="grid" />
      <text x={26} y={y(max) + 4} textAnchor="end">{max.toFixed(2)}</text>
      <text x={26} y={y(0) + 3} textAnchor="end">0</text>
      <polyline points={line("loss")} className="baseline" />
      <polyline points={line("validationLoss")} className="lessons" />
    </svg>
    <figcaption><span className="training-legend"><i />{t("обучение", "training")}<i className="lessons" />{t("проверка", "validation")}</span></figcaption>
  </figure>;
}
