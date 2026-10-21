import type { EvalRun, ExamCase, Lesson, Share } from "@waypoint-ai/shared";
import { useState } from "react";
import { useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language } from "../../shared/i18n";
import { pick } from "../investigation/format";
import BenchmarkSection from "./BenchmarkSection";
import CasesSection from "./CasesSection";
import LessonsSection from "./LessonsSection";
import { trainingApi, type TrainingStatus } from "./training-api";
import { modeLabel, percent, SKILLS, skillLabel, type RunMode } from "./training-format";

export { percent, refreshTraining } from "./training-format";

export type ExamPreset = { mode: RunMode; model: string; revision: number };

/**
 * Everything that measures the assistant: the comparison of models, benchmark runs with their per-question detail,
 * the benchmark's questions, and, under "Advanced", prompt lessons (they change the prompt, not the weights).
 */
export default function QualityTab({ language, status, runs, activeRunId, cases, lessons, editEnabled, preset }: { language: Language; status: TrainingStatus | null; runs: EvalRun[] | null; activeRunId: string | null; cases: ExamCase[] | null; lessons: Lesson[] | null; editEnabled: boolean; preset: ExamPreset | null }) {
  const t = makeT(language);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [casesOpen, setCasesOpen] = useState(false);
  const enabledLessons = lessons?.filter((lesson) => lesson.enabled).length ?? 0;
  const select = (id: string) => {
    setSelectedId(id);
    document.getElementById("training-run-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return <div className="training-quality-tab">
    {runs && <ComparisonTable language={language} runs={runs} mainModel={status?.model ?? null} selectedId={selectedId} onSelect={select} />}
    <BenchmarkSection key={preset?.revision ?? 0} language={language} runs={runs} activeRunId={activeRunId} cases={cases ?? []} lessonCount={enabledLessons} editEnabled={editEnabled} onOpenCases={() => setCasesOpen(true)} status={status} preset={preset} selectedId={selectedId} onSelect={setSelectedId} />
    <details className="training-more" open={casesOpen} onToggle={(event) => setCasesOpen(event.currentTarget.open)}>
      <summary><span className="data-section-title">{t("Вопросы бенчмарка", "Benchmark questions")}</span><small>{cases ? cases.filter((item) => item.enabled).length : "…"}</small></summary>
      {casesOpen && <CasesSection language={language} cases={cases} editEnabled={editEnabled} />}
    </details>
    <details className="training-more">
      <summary><span className="data-section-title">{t("Дополнительно: уроки в промпте", "Advanced: prompt lessons")}</span><small>{pick(language, { ru: `включено ${enabledLessons}`, en: `${enabledLessons} on`, de: `${enabledLessons} aktiv` })}</small></summary>
      <p className="training-intro">{t("Уроки добавляются в запрос к основной модели и не меняют её веса. Их эффект меряется бенчмарком с опцией «С уроками»; дообучение маршрутизатора обычно даёт больше.", "Lessons are added to the main model's request and do not change its weights. Measure their effect with the benchmark's \"With prompt lessons\" option; fine-tuning the router usually helps more.")}</p>
      <LessonsSection language={language} lessons={lessons} editEnabled={editEnabled} />
    </details>
  </div>;
}
/** The latest complete run of every model and mode (and with or without lessons): one row each. */
export function latestPerModel(runs: EvalRun[]): EvalRun[] {
  const seen = new Set<string>();
  return runs.filter((run) => run.status === "succeeded" && run.metrics).filter((run) => {
    const key = `${run.mode}|${run.model}|${run.withLessons}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One row per model: overall, tool, arguments, skills, languages, speed. The best value of each column within a mode is marked. */
function ComparisonTable({ language, runs, mainModel, selectedId, onSelect }: { language: Language; runs: EvalRun[]; mainModel: string | null; selectedId: string | null; onSelect(id: string): void }) {
  const t = makeT(language);
  const rows = latestPerModel(runs);
  if (!rows.length) return null;
  const skills = SKILLS.filter((skill) => rows.some((run) => run.metrics!.bySkill[skill]));
  const languages = [...new Set(rows.flatMap((run) => Object.keys(run.metrics!.byLanguage)))].sort();
  const share = (value: Share | undefined) => (value && value.total ? value.passed / value.total : null);
  type Column = { key: string; label: string; value(run: EvalRun): number | null };
  const columns: Column[] = [
    { key: "overall", label: t("Всего", "Overall"), value: (run) => share(run.metrics!.overall) },
    { key: "tool", label: t("Инструмент", "Tool"), value: (run) => share(run.metrics!.tool) },
    { key: "args", label: t("Аргументы", "Arguments"), value: (run) => share(run.metrics!.args) },
    ...skills.map((skill) => ({ key: `skill:${skill}`, label: skillLabel(skill, t), value: (run: EvalRun) => share(run.metrics!.bySkill[skill]) })),
    ...languages.map((code) => ({ key: `lang:${code}`, label: code.toUpperCase(), value: (run: EvalRun) => share(run.metrics!.byLanguage[code]) })),
  ];
  const best = new Map<string, number>();
  for (const column of columns) for (const run of rows) {
    const value = column.value(run);
    if (value === null) continue;
    const key = `${run.mode}|${column.key}`;
    const current = best.get(key);
    if (current === undefined || value > current) best.set(key, value);
  }
  const several = (mode: string) => rows.filter((run) => run.mode === mode).length > 1;
  return <section className="training-compare-table">
    <h3 className="data-section-title">{t("Сравнение моделей", "Model comparison")}</h3>
    <p className="training-intro">{t("Последний полный прогон каждой модели. Сравнивать честно только строки одного режима: лучшее значение в режиме выделено. Нажмите строку, чтобы открыть разбор по вопросам.", "The latest complete run of each model. Only rows of the same mode compare fairly: the best value within a mode is highlighted. Click a row to open its per-question breakdown.")}</p>
    <div className="training-table-scroll">
      <table>
        <thead><tr><th>{t("Модель", "Model")}</th><th>{t("Режим", "Mode")}</th>{columns.map((column) => <th key={column.key}>{column.label}</th>)}<th title={t("Медиана времени на вопрос по результатам прогона", "Median time per question over the run's results")}>{t("с/вопрос", "s/question")}</th></tr></thead>
        <tbody>{rows.map((run) => <tr key={run.id} className={run.id === selectedId ? "selected" : ""} onClick={() => onSelect(run.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(run.id); } }}>
          <th scope="row"><strong>{run.label ?? run.model}</strong><small>{run.model}{run.model === mainModel ? ` · ${t("основная", "main")}` : ""}{run.withLessons ? ` · ${t("с уроками", "with lessons")}` : ""}</small></th>
          <td>{modeLabel(run.mode, t)}</td>
          {columns.map((column) => {
            const value = column.value(run);
            const top = value !== null && several(run.mode) && best.get(`${run.mode}|${column.key}`) === value;
            return <td key={column.key} className={`${column.key === "overall" ? "overall" : ""}${top ? " best" : ""}`}>{value === null ? "—" : percent(value)}</td>;
          })}
          <SpeedCell runId={run.id} />
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

/**
 * The median time per question from the run's results. Wall time from start to finish would count pauses, such as the
 * laptop sleeping, and the median ignores a slow first question while the model loads.
 */
function SpeedCell({ runId }: { runId: string }) {
  const detail = useCachedQuery(`training:runs:${runId}`, () => trainingApi.run(runId), 60_000);
  const durations = (detail.data?.results ?? []).map((result) => result.durationMs).sort((left, right) => left - right);
  const median = durations.length ? durations[Math.floor(durations.length / 2)]! / 1000 : null;
  return <td>{median === null ? "…" : median.toFixed(1)}</td>;
}
