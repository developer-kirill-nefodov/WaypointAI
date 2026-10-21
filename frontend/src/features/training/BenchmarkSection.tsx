import type { EvalResult, EvalRun, ExamCase, RunMetrics, Share } from "@waypoint-ai/shared";
import { Check, ChevronDown, Play, Plus, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { formatEventTime, pick } from "../investigation/format";
import { LearningCurve, MetricsPanel } from "./charts";
import { trainingApi, type TrainingStatus } from "./training-api";
import { checkLabel, errorText, modeLabel, ORIGINS, originLabel, percent, refreshTraining, SKILLS, skillLabel, type RunMode } from "./training-format";

/** Benchmark runs: the run form, the learning curve, the run list, and one run's per-question breakdown. */

/** Seconds per question, measured on this laptop: the first step only, or a whole turn with its answer. */
const SECONDS_PER_CASE: Record<RunMode, number> = { first_step: 20, router: 4, full: 60 };

/** Runs listed before "more": the latest of the mode are the ones compared. */
const RUNS_SHOWN = 6;

export default function BenchmarkSection({ language, runs, activeRunId, cases, lessonCount, editEnabled, onOpenCases, status, preset, selectedId, onSelect: setSelectedId }: { language: Language; runs: EvalRun[] | null; activeRunId: string | null; cases: ExamCase[]; lessonCount: number; editEnabled: boolean; onOpenCases(): void; status: TrainingStatus | null; preset: { mode: RunMode; model: string } | null; selectedId: string | null; onSelect(id: string): void }) {
  const t = makeT(language);
  const [mode, setMode] = useState<RunMode>(preset?.mode ?? runs?.[0]?.mode ?? "first_step");
  // The run form stays folded until it is needed; "compare on the benchmark" opens it filled in.
  const [setupOpen, setSetupOpen] = useState(Boolean(preset));
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [model, setModel] = useState<string>(preset?.model ?? "");
  const present = ORIGINS.filter((origin) => cases.some((item) => item.enabled && item.origin === origin));
  const [origins, setOrigins] = useState<string[]>(() => present.filter((origin) => origin !== "manual"));
  const [withLessons, setWithLessons] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const chosen = cases.filter((item) => item.enabled && (!origins.length || origins.includes(item.origin)));
  const minutes = Math.max(1, Math.round((chosen.length * SECONDS_PER_CASE[mode]) / 60));
  const modeRuns = runs?.filter((run) => run.mode === mode) ?? [];
  const selected = modeRuns.find((run) => run.id === selectedId) ?? modeRuns[0] ?? null;
  const shownRuns = showAllRuns ? modeRuns : modeRuns.slice(0, RUNS_SHOWN);
  // Until a mode is chosen, the list opens on the mode of the latest run; the runs may load after the tab.
  const modeChosen = useRef(Boolean(preset));
  useEffect(() => {
    if (modeChosen.current || !runs?.length) return;
    modeChosen.current = true;
    if (!selectedId) setMode(runs[0]!.mode);
  }, [runs]);
  // A run picked elsewhere (the comparison table) brings its mode along, so it is in the list.
  useEffect(() => {
    const picked = runs?.find((run) => run.id === selectedId);
    if (picked && picked.mode !== mode) setMode(picked.mode);
    // Only a new pick switches the mode; switching the mode by hand keeps the pick.
  }, [selectedId]);
  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const run = await trainingApi.startRun({ withLessons, label: label.trim() || undefined, mode, origins, ...(model ? { model } : {}) });
      setSelectedId(run.id);
      setLabel("");
      setSetupOpen(false);
      refreshTraining("runs");
    } catch (failure) {
      setError(errorText(failure, t));
    } finally {
      setStarting(false);
    }
  };
  if (!runs) return <p className="data-empty">{t("Загружаю…", "Loading…")}</p>;
  const busy = Boolean(activeRunId) || starting;
  return <div className="training-exam">
    <div className="training-exam-toolbar">
      <div className="data-segments" role="radiogroup" aria-label={t("Режим", "Mode")}>
        {(["first_step", "router", "full"] as const).map((item) => <button key={item} type="button" role="radio" aria-checked={mode === item} className={mode === item ? "active" : ""} onClick={() => { modeChosen.current = true; setMode(item); }}>
          {item === "first_step" ? t("Выбор инструмента (полный промпт)", "Tool choice (full prompt)") : item === "router" ? t("Маршрутизатор (короткий промпт)", "Router (short prompt)") : t("Полный ход с ответом", "Full turn with the answer")}
        </button>)}
      </div>
      <button type="button" className={setupOpen ? "data-text-button" : "data-primary"} aria-expanded={setupOpen} disabled={!editEnabled && !setupOpen} onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? <X size={13} /> : <Plus size={13} />}{setupOpen ? t("Скрыть", "Hide") : t("Новый прогон", "New run")}</button>
    </div>
    {setupOpen && <div className="training-run-setup">
      {status && status.installedModels.length > 0 && <label className="training-model-select"><span>{t("Модель", "Model")}</span>
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="">{mode === "router" ? `${t("по умолчанию", "default")}: ${status.routerModel ?? status.model}` : `${t("основная", "main")}: ${status.model}`}</option>
          {status.installedModels.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>}
      <fieldset className="training-origins" aria-label={t("Вопросы", "Questions")}>
        <span aria-hidden="true">{t("Вопросы", "Questions")}</span>
        {present.map((origin) => <label key={origin} className="investigation-toggle"><input type="checkbox" checked={origins.includes(origin)} onChange={(event) => setOrigins(event.target.checked ? [...origins, origin] : origins.filter((item) => item !== origin))} /><span>{originLabel(origin, t)} · {cases.filter((item) => item.enabled && item.origin === origin).length}</span></label>)}
      </fieldset>
      <label className="investigation-toggle"><input type="checkbox" checked={withLessons} onChange={(event) => setWithLessons(event.target.checked)} /><span>{pick(language, { ru: `С уроками в промпте (${lessonCount})`, en: `With prompt lessons (${lessonCount})`, de: `Mit Prompt-Lektionen (${lessonCount})` })}</span></label>
      <div className="training-run-bar">
        <input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder={t("Подпись запуска, например «базовая модель»", "Run label, for example \"base model\"")} aria-label={t("Подпись запуска", "Run label")} />
        <button type="button" className="data-primary" disabled={!editEnabled || busy || !chosen.length} onClick={start}><Play size={13} />{t("Запустить", "Run")}</button>
        <small>{pick(language, { ru: `${chosen.length} вопросов · ~${minutes} мин`, en: `${chosen.length} questions · ~${minutes} min`, de: `${chosen.length} Fragen · ~${minutes} Min.` })}</small>
      </div>
    </div>}
    {!cases.length && <p className="data-note">{t("Вопросов нет.", "There are no questions.")} <button type="button" className="training-link" onClick={onOpenCases}>{t("Сгенерировать бенчмарк →", "Generate the benchmark →")}</button></p>}
    {error && <p className="training-error" role="alert">{error}</p>}
    <LearningCurve language={language} runs={modeRuns} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
    {modeRuns.length ? <div className="training-split runs" id="training-run-detail">
      <div className="training-column">
      <ul className="training-runs">{shownRuns.map((run) => <li key={run.id}><button type="button" className={run.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(run.id)}>
        <span className={`training-run-dot${run.withLessons ? " lessons" : ""}`} />
        <span className="training-run-copy"><strong>{run.label ?? run.model}</strong><small>{formatEventTime(run.startedAt, language)} · {modeLabel(run.mode, t)} · {runStatusText(run, t)}</small></span>
        <span className="training-run-score">{run.metrics ? percent(run.metrics.overall.passed / Math.max(1, run.metrics.overall.total)) : run.score === null ? "—" : percent(run.score)}</span>
      </button></li>)}</ul>
      {modeRuns.length > RUNS_SHOWN && <button type="button" className="data-more" onClick={() => setShowAllRuns(!showAllRuns)}>{showAllRuns ? t("Свернуть", "Show fewer") : pick(language, { ru: `Ещё ${modeRuns.length - RUNS_SHOWN}`, en: `${modeRuns.length - RUNS_SHOWN} more`, de: `${modeRuns.length - RUNS_SHOWN} weitere` })}</button>}
      </div>
      {selected && <RunDetail key={selected.id} language={language} run={selected} runs={runs} />}
    </div> : <p className="data-empty">{runs.length ? t("В этом режиме прогонов ещё не было: нажмите «Новый прогон».", "No runs in this mode yet: press \"New run\".") : t("Запусков ещё не было. Сначала запустите быстрый бенчмарк базовой модели — это точка отсчёта.", "No runs yet. Start with a fast benchmark of the base model: it is the baseline.")}</p>}
  </div>;
}

function runStatusText(run: EvalRun, t: Translator): string {
  if (run.status === "running") return `${t("идёт", "running")} ${run.casesDone}/${run.caseCount}`;
  if (run.status === "cancelled") return `${t("отменён", "cancelled")} ${run.casesDone}/${run.caseCount}`;
  if (run.status === "failed") return t("ошибка", "failed");
  return `${run.casesPassed}/${run.caseCount} ${t("вопросов сдано", "questions passed")}`;
}

function RunDetail({ language, run, runs }: { language: Language; run: EvalRun; runs: EvalRun[] }) {
  const t = makeT(language);
  // Polling the run list refreshes this key too, so new results appear while the shown ones stay.
  const detail = useCachedQuery(`training:runs:${run.id}`, () => trainingApi.run(run.id), 60_000);
  // Compared with the previous finished run of the same mode by default.
  const candidates = runs.filter((item) => item.id !== run.id && item.status !== "running" && item.casesDone > 0 && item.mode === run.mode);
  const [compareId, setCompareId] = useState<string>(() => candidates.find((item) => item.startedAt < run.startedAt)?.id ?? "");
  const compare = useCachedQuery(compareId ? `training:runs:${compareId}:compare` : null, () => trainingApi.run(compareId), 60_000);
  const before = useMemo(() => new Map((compare.data?.results ?? []).map((result) => [result.caseId, result])), [compare.data]);
  const [cancelling, setCancelling] = useState(false);
  const [onlyFailed, setOnlyFailed] = useState(true);
  const [skill, setSkill] = useState("");
  const results = detail.data?.results ?? null;
  const improved = results?.filter((result) => before.has(result.caseId) && result.passed && !before.get(result.caseId)!.passed).length ?? 0;
  const regressed = results?.filter((result) => before.has(result.caseId) && !result.passed && before.get(result.caseId)!.passed).length ?? 0;
  const shown = results?.filter((result) => (!onlyFailed || !result.passed || (before.get(result.caseId) && !before.get(result.caseId)!.passed)) && (!skill || result.skill === skill)) ?? null;
  const metrics = run.metrics ?? (results?.length ? summarize(results) : null);
  return <div className="training-run-detail">
    <div className="training-run-head">
      <div>
        <strong>{metrics ? percent(metrics.overall.passed / Math.max(1, metrics.overall.total)) : "—"}</strong>
        <small>{metrics ? pick(language, { ru: `${metrics.overall.passed} из ${metrics.overall.total} вопросов · 95%: ${percent(metrics.overall.low)}–${percent(metrics.overall.high)}`, en: `${metrics.overall.passed} of ${metrics.overall.total} questions · 95%: ${percent(metrics.overall.low)}–${percent(metrics.overall.high)}`, de: `${metrics.overall.passed} von ${metrics.overall.total} Fragen · 95 %: ${percent(metrics.overall.low)}–${percent(metrics.overall.high)}` }) : ""}</small>
        <small>{run.model}{run.withLessons ? ` · ${t("с уроками", "with lessons")}` : ""}</small>
      </div>
      {run.status === "running" && <>
        <div className="training-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.caseCount} aria-valuenow={run.casesDone}><span style={{ width: `${(run.casesDone / run.caseCount) * 100}%` }} /></div>
        <button type="button" className="data-text-button" disabled={cancelling} onClick={async () => { setCancelling(true); await trainingApi.cancelRun(run.id).catch(() => undefined); refreshTraining("runs"); }}><Square size={12} />{t("Остановить", "Stop")}</button>
      </>}
      {candidates.length > 0 && <label className="training-compare"><span>{t("Сравнить с", "Compare with")}</span>
        <select value={compareId} onChange={(event) => setCompareId(event.target.value)}>
          <option value="">{t("не сравнивать", "no comparison")}</option>
          {candidates.map((item) => <option key={item.id} value={item.id}>{`${formatEventTime(item.startedAt, language)} · ${item.label ?? item.model} · ${item.score === null ? "—" : percent(item.score)}`}</option>)}
        </select>
      </label>}
      {compareId && results && <span className="training-delta"><span className="up">↑ {improved}</span><span className="down">↓ {regressed}</span></span>}
    </div>
    {metrics && <MetricsPanel language={language} metrics={metrics} compare={compareId ? compare.data?.run.metrics ?? null : null} />}
    <div className="training-result-filters">
      <label className="investigation-toggle"><input type="checkbox" checked={onlyFailed} onChange={(event) => setOnlyFailed(event.target.checked)} /><span>{t("Только провалы и изменения", "Only failures and changes")}</span></label>
      <select value={skill} onChange={(event) => setSkill(event.target.value)} aria-label={t("Навык", "Skill")}><option value="">{t("все навыки", "all skills")}</option>{SKILLS.map((item) => <option key={item} value={item}>{skillLabel(item, t)}</option>)}</select>
    </div>
    {!shown ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p> : !shown.length ? <p className="data-empty">{run.status === "running" && !results?.length ? t("Первый вопрос задаётся модели…", "Asking the model the first question…") : t("Здесь пусто: все вопросы сданы.", "Nothing here: every question passed.")}</p>
      : <ul className="training-results">{shown.map((result) => <ResultRow key={result.caseId} language={language} result={result} before={before.get(result.caseId)} />)}</ul>}
  </div>;
}

/** Metrics of a running exam from the results so far; a finished run has them stored. */
function summarize(results: EvalResult[]): RunMetrics {
  const wilson = (passed: number, total: number): Share => {
    if (!total) return { passed, total, low: 0, high: 0 };
    const z = 1.96;
    const p = passed / total;
    const d = 1 + (z * z) / total;
    const c = (p + (z * z) / (2 * total)) / d;
    const m = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
    return { passed, total, low: Math.max(0, c - m), high: Math.min(1, c + m) };
  };
  const group = (key: (result: EvalResult) => string | null | undefined) => {
    const out: Record<string, Share> = {};
    for (const name of [...new Set(results.map(key).filter((value): value is string => Boolean(value)))].sort()) {
      const items = results.filter((result) => key(result) === name);
      out[name] = wilson(items.filter((item) => item.passed).length, items.length);
    }
    return out;
  };
  const check = (name: string) => {
    const items = results.flatMap((result) => result.checks.filter((item) => item.check === name));
    return wilson(items.filter((item) => item.passed).length, items.length);
  };
  return { overall: wilson(results.filter((result) => result.passed).length, results.length), bySkill: group((result) => result.skill), byLanguage: group((result) => result.language), tool: check("tool"), args: check("args") };
}

function ResultRow({ language, result, before }: { language: Language; result: EvalResult; before?: EvalResult }) {
  const t = makeT(language);
  const [open, setOpen] = useState(false);
  const change = before ? (result.passed && !before.passed ? "up" : !result.passed && before.passed ? "down" : null) : null;
  return <li className={`training-result${result.passed ? " passed" : " failed"}`}>
    <button type="button" className="training-result-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="training-result-icon">{result.passed ? <Check size={13} /> : <X size={13} />}</span>
      <span className="training-result-question"><span className="training-lang">{result.language ?? "—"}</span>{result.question}</span>
      {change && <span className={`training-change ${change}`}>{change === "up" ? t("стало лучше", "improved") : t("стало хуже", "regressed")}</span>}
      <span className="training-checks">{result.checks.map((check) => <span key={check.check} className={check.passed ? "ok" : "bad"} title={`${check.check}: ${t("ожидалось", "expected")} ${JSON.stringify(check.expected ?? null)}, ${t("получено", "got")} ${JSON.stringify(check.actual ?? null)}`}>{checkLabel(check.check, t)}</span>)}</span>
      <small>{(result.durationMs / 1000).toFixed(0)} {t("с", "s")}</small>
      <ChevronDown size={13} className="training-chevron" />
    </button>
    {open && <div className="training-result-body">
      <dl className="data-facts wide">
        <div><dt>{t("Навык", "Skill")}</dt><dd>{skillLabel(result.skill, t)}</dd></div>
        <div><dt>{t("Инструменты", "Tools")}</dt><dd>{result.toolCalls.length ? result.toolCalls.map((call, index) => <code key={index}>{call.tool} {JSON.stringify(call.args ?? {})}</code>) : "—"}</dd></div>
        {result.appliedLessons.length > 0 && <div><dt>{t("Уроки", "Lessons")}</dt><dd>{result.appliedLessons.map((lesson) => lesson.title).join("; ")}</dd></div>}
        {result.errorCode && <div><dt>{t("Ошибка", "Error")}</dt><dd>{result.errorCode}</dd></div>}
      </dl>
      <ul className="training-check-list">{result.checks.filter((check) => !check.passed).map((check) => <li key={check.check}><strong>{checkLabel(check.check, t)}</strong>: {t("ожидалось", "expected")} <code>{JSON.stringify(check.expected ?? null)}</code>, {t("получено", "got")} <code>{JSON.stringify(check.actual ?? null)}</code></li>)}</ul>
      {result.answer && <pre className="training-prompt">{result.answer}</pre>}
    </div>}
  </li>;
}
