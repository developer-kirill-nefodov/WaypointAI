import type { AppliedLesson, CaseExpectation, EvalResult, EvalRun, ExamCase, ExamCaseInput, Lesson, LessonInput, RunMetrics, Share } from "@waypoint-ai/shared";
import { Check, ChevronDown, ListChecks, Loader2, Pencil, Play, Plus, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { invalidateCache, useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { formatEventTime, pick } from "../investigation/format";
import { TrainingRequestError, trainingApi, type TrainingStatus } from "./training-api";

const TOPICS = ["all", "places", "events", "trips", "sources"] as const;
const EXAMPLE_TOOLS = ["search_places", "search_events", "list_sources", "plan_trip", "reply"] as const;
const CASE_TOOLS = [...EXAMPLE_TOOLS, "search_records", "get_record_details", "edit_trip_plan"] as const;

export const refreshTraining = (what: "lessons" | "cases" | "runs" | "all" = "all") => invalidateCache(what === "all" ? "training:" : `training:${what}`);

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function errorText(error: unknown, t: Translator): string {
  const code = error instanceof TrainingRequestError ? error.code : "request_failed";
  const messages: Record<string, string> = {
    forbidden_text: t("Текст похож на попытку изменить правила, SQL, ссылку или код. Такие уроки не принимаются.", "The text looks like an attempt to change the rules, SQL, a link, or code. Such lessons are refused."),
    invalid_example_args: t("Аргументы не подходят инструменту: используйте только его поля (например, place, а не координаты).", "The arguments do not fit the tool: use only its fields (for example place, not coordinates)."),
    example_needs_tool_or_answer: t("Примеру нужен вызов инструмента, ответ или и то и другое.", "An example needs a tool call, an answer, or both."),
    invalid_lesson: t("Проверьте поля урока.", "Check the lesson's fields."),
    invalid_case: t("Проверьте поля вопроса.", "Check the question's fields."),
    training_disabled: t("Редактирование выключено на сервере (TRAINING_ENABLED).", "Editing is off on the server (TRAINING_ENABLED)."),
    exam_running: t("Экзамен уже идёт.", "An exam is already running."),
    no_cases: t("Нет включённых вопросов экзамена.", "No exam questions are enabled."),
    network_error: t("Сервер недоступен.", "The server is unreachable."),
  };
  return messages[code] ?? t("Не получилось. Попробуйте ещё раз.", "That did not work. Try again.");
}

function topicLabel(topic: string, t: Translator): string {
  const labels: Record<string, string> = { all: t("всё", "all"), places: t("места", "places"), events: t("события", "events"), trips: t("поездки", "trips"), sources: t("источники", "sources") };
  return labels[topic] ?? topic;
}

// ——— Quality tab ———

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
    <ExamTab key={preset?.revision ?? 0} language={language} runs={runs} activeRunId={activeRunId} cases={cases ?? []} lessonCount={enabledLessons} editEnabled={editEnabled} onOpenCases={() => setCasesOpen(true)} status={status} preset={preset} selectedId={selectedId} onSelect={setSelectedId} />
    <details className="training-more" open={casesOpen} onToggle={(event) => setCasesOpen(event.currentTarget.open)}>
      <summary><span className="data-section-title">{t("Вопросы бенчмарка", "Benchmark questions")}</span><small>{cases ? cases.filter((item) => item.enabled).length : "…"}</small></summary>
      {casesOpen && <CasesTab language={language} cases={cases} editEnabled={editEnabled} />}
    </details>
    <details className="training-more">
      <summary><span className="data-section-title">{t("Дополнительно: уроки в промпте", "Advanced: prompt lessons")}</span><small>{pick(language, { ru: `включено ${enabledLessons}`, en: `${enabledLessons} on`, de: `${enabledLessons} aktiv` })}</small></summary>
      <p className="training-intro">{t("Уроки добавляются в запрос к основной модели и не меняют её веса. Их эффект меряется бенчмарком с опцией «С уроками»; дообучение маршрутизатора обычно даёт больше.", "Lessons are added to the main model's request and do not change its weights. Measure their effect with the benchmark's \"With prompt lessons\" option; fine-tuning the router usually helps more.")}</p>
      <LessonsTab language={language} lessons={lessons} editEnabled={editEnabled} />
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

const modeLabel = (mode: string, t: Translator) => (mode === "first_step" ? t("инструмент", "tool choice") : mode === "router" ? t("маршрутизатор", "router") : t("полный ход", "full turn"));

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

// ——— Lessons ———

type Editing = { kind: "rule" | "example"; lesson?: Lesson } | null;

function LessonsTab({ language, lessons, editEnabled }: { language: Language; lessons: Lesson[] | null; editEnabled: boolean }) {
  const t = makeT(language);
  const [editing, setEditing] = useState<Editing>(null);
  if (!lessons) return <p className="data-empty">{t("Загружаю…", "Loading…")}</p>;
  const rules = lessons.filter((lesson) => lesson.kind === "rule");
  const examples = lessons.filter((lesson) => lesson.kind === "example");
  return <div className="training-split">
    <div className="training-column">
      <p className="training-intro">{t(
        "Правила добавляются в каждый запрос к модели, примеры — когда вопрос похож на пример. Уроки стоят ниже системных правил: они не дают новых инструментов, источников или фактов.",
        "Rules go into every request to the model; examples go in when a question resembles them. Lessons rank below the system rules: they never add tools, sources, or facts.",
      )}</p>
      <div className="training-actions">
        <button type="button" className="data-primary" disabled={!editEnabled} onClick={() => setEditing({ kind: "rule" })}><Plus size={14} />{t("Правило", "Rule")}</button>
        <button type="button" className="data-text-button" disabled={!editEnabled} onClick={() => setEditing({ kind: "example" })}><Plus size={14} />{t("Пример", "Example")}</button>
      </div>
      <LessonGroup language={language} title={t("Правила", "Rules")} lessons={rules} editEnabled={editEnabled} onEdit={(lesson) => setEditing({ kind: lesson.kind, lesson })} empty={t("Правил пока нет. Например: «Всегда называй источник данных».", "No rules yet. For example: \"Always name the data source\".")} />
      <LessonGroup language={language} title={t("Примеры", "Examples")} lessons={examples} editEnabled={editEnabled} onEdit={(lesson) => setEditing({ kind: lesson.kind, lesson })} empty={t("Примеров пока нет. Например: «Что трясло у Норчи?» → search_events {place: Norcia}.", "No examples yet. For example: \"What shook near Norcia?\" → search_events {place: Norcia}.")} />
    </div>
    <div className="training-column">
      {editing ? <LessonEditor key={editing.lesson?.id ?? editing.kind} language={language} editing={editing} onDone={() => setEditing(null)} /> : <LessonPreview language={language} />}
    </div>
  </div>;
}

function LessonGroup({ language, title, lessons, editEnabled, onEdit, empty }: { language: Language; title: string; lessons: Lesson[]; editEnabled: boolean; onEdit(lesson: Lesson): void; empty: string }) {
  return <section className="training-group">
    <h3 className="data-section-title">{title} · {lessons.length}</h3>
    {lessons.length ? <ul className="training-list">{lessons.map((lesson) => <LessonRow key={lesson.id} language={language} lesson={lesson} editEnabled={editEnabled} onEdit={() => onEdit(lesson)} />)}</ul> : <p className="data-empty">{empty}</p>}
  </section>;
}

function LessonRow({ language, lesson, editEnabled, onEdit }: { language: Language; lesson: Lesson; editEnabled: boolean; onEdit(): void }) {
  const t = makeT(language);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); refreshTraining("lessons"); } catch (failure) { setError(errorText(failure, t)); }
  };
  const args = lesson.exampleArgs && Object.keys(lesson.exampleArgs).length ? ` ${JSON.stringify(lesson.exampleArgs)}` : "";
  const call = lesson.exampleTool ? `${lesson.exampleTool}${args}` : null;
  return <li className={`training-item${lesson.enabled ? "" : " off"}`}>
    <Switch checked={lesson.enabled} disabled={!editEnabled} label={lesson.title} onChange={(enabled) => act(() => trainingApi.updateLesson(lesson.id, { enabled }))} />
    <div className="training-item-copy">
      <strong>{lesson.title}</strong>
      <p>{lesson.kind === "example" ? `«${lesson.text}»` : lesson.text}</p>
      {call && <code>→ {call}</code>}
      {lesson.exampleAnswer && <p className="training-answer">→ {lesson.exampleAnswer}</p>}
      <small>{[topicLabel(lesson.topic, t), `v${lesson.version}`, pick(language, { ru: `сработал ${lesson.appliedCount} раз`, en: `applied ${lesson.appliedCount} times`, de: `${lesson.appliedCount}-mal angewendet` }), lesson.lastAppliedAt ? `${t("последний раз", "last")} ${formatEventTime(lesson.lastAppliedAt, language)}` : null].filter(Boolean).join(" · ")}</small>
      {error && <small className="training-error" role="alert">{error}</small>}
    </div>
    <div className="training-item-actions">
      {confirming ? <>
        <button type="button" className="danger" onClick={() => act(() => trainingApi.deleteLesson(lesson.id))}>{t("Удалить", "Delete")}</button>
        <button type="button" onClick={() => setConfirming(false)} aria-label={t("Отмена", "Cancel")}><X size={13} /></button>
      </> : <>
        <button type="button" disabled={!editEnabled} onClick={onEdit} aria-label={t("Изменить", "Edit")} title={t("Изменить", "Edit")}><Pencil size={13} /></button>
        <button type="button" disabled={!editEnabled} onClick={() => setConfirming(true)} aria-label={t("Удалить", "Delete")} title={t("Удалить", "Delete")}><Trash2 size={13} /></button>
      </>}
    </div>
  </li>;
}

function LessonEditor({ language, editing, onDone }: { language: Language; editing: NonNullable<Editing>; onDone(): void }) {
  const t = makeT(language);
  const source = editing.lesson;
  const [topic, setTopic] = useState<string>(source?.topic ?? "all");
  const [title, setTitle] = useState(source?.title ?? "");
  const [text, setText] = useState(source?.text ?? "");
  const [tool, setTool] = useState<string>(source?.exampleTool ?? (editing.kind === "example" ? "search_events" : ""));
  const [args, setArgs] = useState(source?.exampleArgs ? JSON.stringify(source.exampleArgs) : editing.kind === "example" ? "{\"place\": \"Norcia\"}" : "");
  const [answer, setAnswer] = useState(source?.exampleAnswer ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    let input: LessonInput;
    if (editing.kind === "rule") input = { kind: "rule", topic: topic as LessonInput["topic"], title, text };
    else {
      let parsedArgs: Record<string, unknown> | null = null;
      if (tool && tool !== "reply" && args.trim()) {
        try {
          const value: unknown = JSON.parse(args);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
          parsedArgs = value as Record<string, unknown>;
        } catch {
          setError(t("Аргументы должны быть JSON-объектом, например {\"place\": \"Norcia\"}.", "Arguments must be a JSON object, for example {\"place\": \"Norcia\"}."));
          return;
        }
      }
      input = { kind: "example", topic: topic as LessonInput["topic"], title, text, exampleTool: (tool || null) as Lesson["exampleTool"], exampleArgs: tool ? parsedArgs ?? {} : null, exampleAnswer: answer.trim() || null };
    }
    setSaving(true);
    try {
      if (source) await trainingApi.updateLesson(source.id, input);
      else await trainingApi.createLesson(input);
      refreshTraining("lessons");
      onDone();
    } catch (failure) {
      setError(errorText(failure, t));
    } finally {
      setSaving(false);
    }
  };
  return <form className="training-editor" onSubmit={submit}>
    <h3 className="data-section-title">{source ? t("Изменить урок", "Edit lesson") : editing.kind === "rule" ? t("Новое правило", "New rule") : t("Новый пример", "New example")}</h3>
    <label><span>{t("Название", "Title")}</span><input value={title} maxLength={120} required onChange={(event) => setTitle(event.target.value)} placeholder={editing.kind === "rule" ? t("Называть источник", "Name the source") : t("Землетрясения у города", "Earthquakes near a town")} /></label>
    <label><span>{t("Тема", "Topic")}</span><select value={topic} onChange={(event) => setTopic(event.target.value)}>{TOPICS.map((item) => <option key={item} value={item}>{topicLabel(item, t)}</option>)}</select></label>
    <label><span>{editing.kind === "rule" ? t("Правило", "Rule") : t("Вопрос пользователя", "User's question")}</span>
      <textarea value={text} maxLength={300} required rows={3} onChange={(event) => setText(event.target.value)} placeholder={editing.kind === "rule" ? t("Всегда называй каталог, из которого взято событие.", "Always name the catalogue an event comes from.") : t("Что трясло у Норчи на этой неделе?", "What shook near Norcia this week?")} />
    </label>
    {editing.kind === "example" && <>
      <label><span>{t("Правильный инструмент", "Right tool")}</span><select value={tool} onChange={(event) => setTool(event.target.value)}>
        <option value="">{t("без инструмента (только ответ)", "no tool (answer only)")}</option>
        {EXAMPLE_TOOLS.map((item) => <option key={item} value={item}>{item}</option>)}
      </select></label>
      {tool && tool !== "reply" && tool !== "list_sources" && <label><span>{t("Аргументы (JSON)", "Arguments (JSON)")}</span><textarea className="mono" rows={2} value={args} onChange={(event) => setArgs(event.target.value)} /></label>}
      <label><span>{t("Образец ответа (необязательно)", "Sample answer (optional)")}</span><textarea value={answer} maxLength={600} rows={3} onChange={(event) => setAnswer(event.target.value)} placeholder={t("Коротко: сколько событий, самое сильное, источник.", "Briefly: how many events, the strongest, the source.")} /></label>
    </>}
    {error && <p className="training-error" role="alert">{error}</p>}
    <div className="training-actions">
      <button type="submit" className="data-primary" disabled={saving}>{saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}{t("Сохранить", "Save")}</button>
      <button type="button" className="data-text-button" onClick={onDone}>{t("Отмена", "Cancel")}</button>
    </div>
  </form>;
}

function LessonPreview({ language }: { language: Language }) {
  const t = makeT(language);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ applied: AppliedLesson[]; prompt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try { setResult(await trainingApi.preview(message)); } catch (failure) { setError(errorText(failure, t)); }
  };
  return <form className="training-editor" onSubmit={submit}>
    <h3 className="data-section-title">{t("Какие уроки получит сообщение", "Which lessons a message gets")}</h3>
    <p className="training-intro">{t("Модель не вызывается: показан ровно тот текст, который будет добавлен к запросу.", "The model is not called: this is exactly the text that will be added to the request.")}</p>
    <textarea value={message} rows={2} maxLength={500} required onChange={(event) => setMessage(event.target.value)} placeholder={t("Например: землетрясения у Норчи за 3 дня", "For example: earthquakes near Norcia in the last 3 days")} />
    <div className="training-actions"><button type="submit" className="data-text-button">{t("Проверить", "Check")}</button></div>
    {error && <p className="training-error" role="alert">{error}</p>}
    {result && (result.applied.length ? <>
      <ul className="training-applied">{result.applied.map((item) => <li key={item.id}><span className={`training-kind ${item.kind}`}>{item.kind === "rule" ? t("правило", "rule") : t("пример", "example")}</span>{item.title}{item.kind === "example" && <small>{t("сходство", "similarity")} {percent(item.score)}</small>}</li>)}</ul>
      <pre className="training-prompt">{result.prompt}</pre>
    </> : <p className="data-empty">{t("Ни один урок не подходит.", "No lesson applies.")}</p>)}
  </form>;
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`training-switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

// ——— Benchmark ———

export type RunMode = "first_step" | "router" | "full";
const ORIGINS = ["generated", "hard", "starter", "manual", "journal"] as const;
const SKILLS = ["places", "events", "trips", "sources", "reply", "other"] as const;
/** Seconds per question, measured on this laptop: the first step only, or a whole turn with its answer. */
const SECONDS_PER_CASE: Record<RunMode, number> = { first_step: 20, router: 4, full: 60 };

function originLabel(origin: string, t: Translator): string {
  const labels: Record<string, string> = { generated: t("сгенерированные", "generated"), hard: t("трудные", "hard"), starter: t("стартовые", "starter"), manual: t("ручные", "manual"), journal: t("из журнала", "from the journal") };
  return labels[origin] ?? origin;
}

export function skillLabel(skill: string, t: Translator): string {
  const labels: Record<string, string> = { places: t("места", "places"), events: t("события", "events"), trips: t("поездки", "trips"), sources: t("источники", "sources"), reply: t("ответ без данных", "reply"), other: t("другое", "other") };
  return labels[skill] ?? skill;
}

/** Runs listed before "more": the latest of the mode are the ones compared. */
const RUNS_SHOWN = 6;

function ExamTab({ language, runs, activeRunId, cases, lessonCount, editEnabled, onOpenCases, status, preset, selectedId, onSelect: setSelectedId }: { language: Language; runs: EvalRun[] | null; activeRunId: string | null; cases: ExamCase[]; lessonCount: number; editEnabled: boolean; onOpenCases(): void; status: TrainingStatus | null; preset: { mode: RunMode; model: string } | null; selectedId: string | null; onSelect(id: string): void }) {
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

/** Share of passed questions of every complete run of one mode over time, with its 95% interval. */
export function LearningCurve({ language, runs, selectedId, onSelect }: { language: Language; runs: EvalRun[]; selectedId: string | null; onSelect(id: string): void }) {
  const t = makeT(language);
  // Only complete runs: a cancelled or failed run scored only some of the questions.
  const points = [...runs].filter((run) => run.status === "succeeded" && run.metrics).reverse();
  const [chartRef, width] = useChartWidth();
  if (points.length < 1) return null;
  const height = 150;
  const pad = { left: 34, right: 12, top: 12, bottom: 22 };
  const share = (run: EvalRun) => run.metrics!.overall.passed / Math.max(1, run.metrics!.overall.total);
  const x = (index: number) => pad.left + (points.length === 1 ? (width - pad.left - pad.right) / 2 : (index * (width - pad.left - pad.right)) / (points.length - 1));
  const y = (score: number) => pad.top + (1 - score) * (height - pad.top - pad.bottom);
  const series = (withLessons: boolean) => points.map((run, index) => ({ run, index })).filter(({ run }) => run.withLessons === withLessons);
  const line = (items: ReturnType<typeof series>) => items.map(({ run, index }) => `${x(index)},${y(share(run))}`).join(" ");
  return <figure className="training-curve" ref={chartRef}>
    <figcaption><span className="data-section-title">{t("Кривая качества", "Quality curve")}</span><span className="training-legend"><i className="lessons" />{t("с уроками", "with lessons")}<i />{t("без уроков", "without lessons")}<span>│ {t("полоса — 95% интервал", "bar: 95% interval")}</span></span></figcaption>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("Доля сданных вопросов по запускам", "Share of passed questions per run")}>
      {[0, 0.5, 1].map((value) => <g key={value}><line x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} className="grid" /><text x={pad.left - 6} y={y(value) + 3} textAnchor="end">{percent(value)}</text></g>)}
      {[false, true].map((withLessons) => <polyline key={String(withLessons)} points={line(series(withLessons))} className={withLessons ? "lessons" : "baseline"} />)}
      {points.map((run, index) => <g key={run.id} className={`point${run.withLessons ? " lessons" : ""}${run.id === selectedId ? " selected" : ""}`} onClick={() => onSelect(run.id)}>
        <line x1={x(index)} x2={x(index)} y1={y(run.metrics!.overall.low)} y2={y(run.metrics!.overall.high)} className="interval" />
        <circle cx={x(index)} cy={y(share(run))} r={run.id === selectedId ? 6 : 4.5} />
        <title>{`${run.label ?? run.model} · ${percent(share(run))} (${percent(run.metrics!.overall.low)}–${percent(run.metrics!.overall.high)}) · ${formatEventTime(run.startedAt, language)}`}</title>
        {(index === points.length - 1 || run.id === selectedId) && <text x={x(index) + 9} y={y(share(run)) + 3}>{percent(share(run))}</text>}
      </g>)}
    </svg>
  </figure>;
}

/** The drawn width of a chart: its SVG is laid out 1:1, so text and lines keep their size on any screen. */
export function useChartWidth(fallback = 640): [(node: Element | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width))); });
    observer.current.observe(node);
  }, []);
  return [ref, width];
}

/** Accuracy per skill and language with intervals, and the change against a compared run of the same mode. */
export function MetricsPanel({ language, metrics, compare }: { language: Language; metrics: RunMetrics; compare?: RunMetrics | null }) {
  const t = makeT(language);
  const row = (name: string, share: Share, before?: Share) => {
    const value = share.total ? share.passed / share.total : 0;
    const delta = before && before.total ? value - before.passed / before.total : null;
    return <li key={name}>
      <span className="training-metric-name">{name}</span>
      <span className="training-metric-bar" title={`${percent(share.low)}–${percent(share.high)}`}>
        <span className="interval" style={{ left: `${share.low * 100}%`, width: `${Math.max(0, share.high - share.low) * 100}%` }} />
        <span className="value" style={{ left: `${value * 100}%` }} />
      </span>
      <span className="training-metric-value">{percent(value)} <small>{share.passed}/{share.total}</small></span>
      <span className={`training-metric-delta${delta === null ? "" : delta > 0.005 ? " up" : delta < -0.005 ? " down" : ""}`}>{delta === null ? "" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(Math.round(delta * 100))}`}</span>
    </li>;
  };
  return <div className="training-metrics">
    <ul>
      {row(t("Выбор инструмента", "Tool choice"), metrics.tool, compare?.tool)}
      {row(t("Аргументы", "Arguments"), metrics.args, compare?.args)}
    </ul>
    <ul>{Object.entries(metrics.bySkill).map(([skill, share]) => row(skillLabel(skill, t), share, compare?.bySkill[skill]))}</ul>
    <ul>{Object.entries(metrics.byLanguage).map(([code, share]) => row(code.toUpperCase(), share, compare?.byLanguage[code]))}</ul>
  </div>;
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

function checkLabel(check: string, t: Translator): string {
  const labels: Record<string, string> = {
    completed: t("ответ", "answer"), tool: t("инструмент", "tool"), args: t("аргументы", "arguments"), language: t("язык", "language"),
    mustInclude: t("есть нужное", "includes"), mustNotInclude: t("нет лишнего", "excludes"), citations: t("ссылки", "citations"), citeEachEvent: t("ссылка у каждого события", "each event cited"), maxSentences: t("длина", "length"),
  };
  return labels[check] ?? check;
}

// ——— Benchmark questions ———

function CasesTab({ language, cases, editEnabled }: { language: Language; cases: ExamCase[] | null; editEnabled: boolean }) {
  const t = makeT(language);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [perSkill, setPerSkill] = useState(20);
  const [seed, setSeed] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [origin, setOrigin] = useState("");
  const [skill, setSkill] = useState("");
  if (!cases) return <p className="data-empty">{t("Загружаю…", "Loading…")}</p>;
  const generate = async () => {
    setMessage(null);
    setGenerating(true);
    try {
      const result = await trainingApi.generateCases(perSkill, seed);
      setMessage(pick(language, { ru: `Сгенерировано вопросов: ${result.generated}, добавлено трудных: ${result.hard}.`, en: `Generated ${result.generated} questions, added ${result.hard} hard ones.`, de: `${result.generated} Fragen erzeugt, ${result.hard} schwierige hinzugefügt.` }));
      refreshTraining("cases");
    } catch (failure) { setMessage(errorText(failure, t)); } finally { setGenerating(false); }
  };
  const shown = cases.filter((item) => (!origin || item.origin === origin) && (!skill || item.skill === skill));
  return <div className="training-split">
    <div className="training-column">
      <p className="training-intro">{t(
        "Бенчмарк собирается из базы: шаблоны вопросов на трёх языках и реальные города, поэтому правильный вызов инструмента известен заранее. Трудные вопросы написаны вручную: падежи и экзонимы («в Риме» → Roma), опечатки, смешанные языки, запросы без нужного инструмента.",
        "The benchmark is built from the database: question templates in three languages and real cities, so the right tool call is known in advance. Hard questions are hand-written: inflected exonyms (\"в Риме\" → Roma), typos, mixed languages, requests no tool serves.",
      )}</p>
      <div className="training-actions training-generate">
        <label><span>{t("Вопросов на навык", "Questions per skill")}</span><input type="number" min={5} max={60} value={perSkill} onChange={(event) => setPerSkill(Math.min(60, Math.max(5, Number(event.target.value) || 20)))} /></label>
        <label><span>{t("Зерно", "Seed")}</span><input type="number" min={0} max={1000000} value={seed} onChange={(event) => setSeed(Math.max(0, Number(event.target.value) || 0))} /></label>
        <button type="button" className="data-primary" disabled={!editEnabled || generating} onClick={generate}>{generating ? <Loader2 size={14} className="spin" /> : <ListChecks size={14} />}{t("Сгенерировать заново", "Regenerate")}</button>
        <button type="button" className="data-text-button" disabled={!editEnabled} onClick={() => setAdding(true)}><Plus size={14} />{t("Свой вопрос", "Own question")}</button>
      </div>
      {message && <p className="training-intro" role="status">{message}</p>}
      <div className="training-result-filters">
        <select value={origin} onChange={(event) => setOrigin(event.target.value)} aria-label={t("Происхождение", "Origin")}><option value="">{t("все наборы", "all sets")}</option>{ORIGINS.map((item) => <option key={item} value={item}>{originLabel(item, t)} · {cases.filter((caseItem) => caseItem.origin === item).length}</option>)}</select>
        <select value={skill} onChange={(event) => setSkill(event.target.value)} aria-label={t("Навык", "Skill")}><option value="">{t("все навыки", "all skills")}</option>{SKILLS.map((item) => <option key={item} value={item}>{skillLabel(item, t)} · {cases.filter((caseItem) => caseItem.skill === item).length}</option>)}</select>
        <small>{shown.length}</small>
      </div>
      {shown.length ? <ul className="training-list">{shown.map((item) => <CaseRow key={item.id} language={language} examCase={item} editEnabled={editEnabled} />)}</ul> : <p className="data-empty">{t("Вопросов пока нет.", "No questions yet.")}</p>}
    </div>
    <div className="training-column">{adding ? <CaseEditor language={language} onDone={() => setAdding(false)} /> : <p className="data-empty">{t("Хороший вопрос проверяет одно поведение: выбор инструмента, город в местном написании, язык ответа или ссылки на источники.", "A good question checks one behaviour: the tool choice, the city in its local spelling, the answer's language, or source citations.")}</p>}</div>
  </div>;
}

function expectationSummary(expect: CaseExpectation, t: Translator): string {
  return [
    expect.tool ? `→ ${expect.tool}${expect.args ? ` ${JSON.stringify(expect.args)}` : ""}` : null,
    expect.mustInclude?.length ? `${t("есть", "has")}: ${expect.mustInclude.join(", ")}` : null,
    expect.mustNotInclude?.length ? `${t("нет", "not")}: ${expect.mustNotInclude.join(", ")}` : null,
    expect.citations ? t("со ссылками", "cited") : null,
    expect.citeEachEvent ? t("ссылка у каждого события", "each event cited") : null,
    expect.maxSentences ? `≤ ${expect.maxSentences} ${t("предл.", "sent.")}` : null,
  ].filter(Boolean).join(" · ");
}

function CaseRow({ language, examCase, editEnabled }: { language: Language; examCase: ExamCase; editEnabled: boolean }) {
  const t = makeT(language);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); refreshTraining("cases"); } catch (failure) { setError(errorText(failure, t)); }
  };
  return <li className={`training-item${examCase.enabled ? "" : " off"}`}>
    <Switch checked={examCase.enabled} disabled={!editEnabled} label={examCase.question} onChange={(enabled) => act(() => trainingApi.updateCase(examCase.id, { enabled }))} />
    <div className="training-item-copy">
      <strong><span className="training-lang">{examCase.language}</span>{examCase.question}</strong>
      <code>{expectationSummary(examCase.expect, t)}</code>
      {error && <small className="training-error" role="alert">{error}</small>}
    </div>
    <div className="training-item-actions">
      <button type="button" disabled={!editEnabled} onClick={() => act(() => trainingApi.deleteCase(examCase.id))} aria-label={t("Удалить", "Delete")} title={t("Удалить", "Delete")}><Trash2 size={13} /></button>
    </div>
  </li>;
}

function CaseEditor({ language, onDone }: { language: Language; onDone(): void }) {
  const t = makeT(language);
  const [question, setQuestion] = useState("");
  const [caseLanguage, setCaseLanguage] = useState<ExamCase["language"]>(language);
  const [tool, setTool] = useState("");
  const [args, setArgs] = useState("");
  const [mustInclude, setMustInclude] = useState("");
  const [mustNotInclude, setMustNotInclude] = useState("");
  const [citations, setCitations] = useState(false);
  const [citeEachEvent, setCiteEachEvent] = useState(false);
  const [maxSentences, setMaxSentences] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 5);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const expect: CaseExpectation = {};
    if (tool) expect.tool = tool as CaseExpectation["tool"];
    if (args.trim()) {
      try {
        const value: unknown = JSON.parse(args);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        expect.args = value as CaseExpectation["args"];
      } catch {
        setError(t("Аргументы должны быть JSON-объектом.", "Arguments must be a JSON object."));
        return;
      }
    }
    if (list(mustInclude).length) expect.mustInclude = list(mustInclude);
    if (list(mustNotInclude).length) expect.mustNotInclude = list(mustNotInclude);
    if (citations) expect.citations = true;
    if (citeEachEvent) expect.citeEachEvent = true;
    if (maxSentences) expect.maxSentences = Number(maxSentences);
    const input: ExamCaseInput = { question, language: caseLanguage, expect };
    try {
      await trainingApi.createCase(input);
      refreshTraining("cases");
      onDone();
    } catch (failure) { setError(errorText(failure, t)); }
  };
  return <form className="training-editor" onSubmit={submit}>
    <h3 className="data-section-title">{t("Новый вопрос экзамена", "New exam question")}</h3>
    <label><span>{t("Вопрос", "Question")}</span><textarea value={question} maxLength={300} rows={2} required onChange={(event) => setQuestion(event.target.value)} placeholder={t("Музеи в Кракове", "Museums in Kraków")} /></label>
    <div className="training-row">
      <label><span>{t("Язык ответа", "Answer language")}</span><select value={caseLanguage} onChange={(event) => setCaseLanguage(event.target.value as ExamCase["language"])}><option value="ru">ru</option><option value="en">en</option><option value="de">de</option></select></label>
      <label><span>{t("Ожидаемый инструмент", "Expected tool")}</span><select value={tool} onChange={(event) => setTool(event.target.value)}><option value="">{t("не проверять", "do not check")}</option>{CASE_TOOLS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    </div>
    <label><span>{t("Обязательные аргументы (JSON)", "Required arguments (JSON)")}</span><textarea className="mono" rows={2} value={args} onChange={(event) => setArgs(event.target.value)} placeholder='{"kind": "museum", "city": "Kraków"}' /></label>
    <label><span>{t("В ответе должно быть (через запятую)", "The answer must include (comma-separated)")}</span><input value={mustInclude} onChange={(event) => setMustInclude(event.target.value)} /></label>
    <label><span>{t("В ответе не должно быть (через запятую)", "The answer must not include (comma-separated)")}</span><input value={mustNotInclude} onChange={(event) => setMustNotInclude(event.target.value)} /></label>
    <div className="training-row">
      <div className="training-checkboxes">
        <label className="investigation-toggle"><input type="checkbox" checked={citations} onChange={(event) => setCitations(event.target.checked)} /><span>{t("Нужны ссылки на источники", "Citations required")}</span></label>
        <label className="investigation-toggle"><input type="checkbox" checked={citeEachEvent} onChange={(event) => setCiteEachEvent(event.target.checked)} /><span>{t("Ссылка у каждого события с магнитудой", "Every event with a magnitude cited")}</span></label>
      </div>
      <label><span>{t("Не длиннее (предложений)", "At most (sentences)")}</span><input type="number" min={1} max={20} value={maxSentences} onChange={(event) => setMaxSentences(event.target.value)} /></label>
    </div>
    {error && <p className="training-error" role="alert">{error}</p>}
    <div className="training-actions">
      <button type="submit" className="data-primary"><Check size={14} />{t("Добавить", "Add")}</button>
      <button type="button" className="data-text-button" onClick={onDone}>{t("Отмена", "Cancel")}</button>
    </div>
  </form>;
}
