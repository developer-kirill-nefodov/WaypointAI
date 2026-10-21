import { Check, ChevronDown, ChevronRight, Loader2, Pencil, RefreshCw, Sparkles, Square, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { invalidateCache, useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { formatEventTime, pick } from "../investigation/format";
import { teacherApi, type ExampleStatus, type TeacherBatch, type TeacherExample, type TeacherLanguage, type TeacherState } from "./teacher-api";
import { TrainingRequestError } from "./training-api";

const refresh = () => invalidateCache("training:teacher");
const LANGUAGES: TeacherLanguage[] = ["ru", "en", "de"];

/**
 * The teacher's step of fine-tuning: an OpenAI model writes examples for one topic in a batch, the server checks every
 * example, and a person reviews the batch and accepts it into the dataset. Only synthetic prompts leave the machine.
 */
export default function TeacherSection({ language, editEnabled, step }: { language: Language; editEnabled: boolean; step: number }) {
  const t = makeT(language);
  const state = useCachedQuery("training:teacher", () => teacherApi.state(), 15_000);
  const data = state.data;
  const running = data?.progress ?? null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const [open, setOpen] = useState<string | null>(null);
  const accepted = data?.batches.filter((batch) => batch.status === "accepted") ?? [];
  return <li className={running ? "active" : accepted.length ? "done" : "todo"}>
    <h3 className="data-section-title">{step}. {t("Данные от учителя", "Data from the teacher")}</h3>
    <p>{t(
      "Модель OpenAI пишет примеры партиями по тематике, сервер проверяет каждый: схема инструмента, город в базе (с исправлением на местное написание), язык, тематика, повторы и вопросы бенчмарка. Принятые партии входят в набор данных при следующей сборке. В OpenAI уходят только синтетические задания и названия городов, журнал — никогда.",
      "An OpenAI model writes examples in batches per topic, and the server checks each one: the tool's schema, the city in the database (corrected to the local spelling), the language, the topic, repeats, and benchmark questions. Accepted batches go into the dataset on its next build. Only synthetic instructions and city names go to OpenAI, never the journal.",
    )}</p>
    {!data ? <p className="data-empty">{state.error ? t("Не удалось загрузить учителя.", "Could not load the teacher.") : t("Загружаю…", "Loading…")}</p> : <>
      {!data.available && <p className="data-note">{t("Учитель выключен: задайте OPENAI_API_KEY в .env (модель — TEACHER_MODEL).", "The teacher is off: set OPENAI_API_KEY in .env (the model is TEACHER_MODEL).")}</p>}
      {data.available && editEnabled && <BatchForm language={language} data={data} />}
      {running && <BatchProgress language={language} progress={running} batch={data.batches.find((batch) => batch.id === running.batchId) ?? null} editEnabled={editEnabled} />}
      {data.batches.length > 0 && <ul className="training-list teacher-batches">
        {data.batches.map((batch) => <BatchRow key={batch.id} language={language} data={data} batch={batch} open={open === batch.id} onToggle={() => setOpen(open === batch.id ? null : batch.id)} editEnabled={editEnabled} />)}
      </ul>}
    </>}
  </li>;
}

function BatchForm({ language, data }: { language: Language; data: TeacherState }) {
  const t = makeT(language);
  const [topic, setTopic] = useState(data.topics[0]?.id ?? "places");
  const [languages, setLanguages] = useState<TeacherLanguage[]>(["ru", "en", "de"]);
  const [count, setCount] = useState(50);
  const [crossCheck, setCrossCheck] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = Math.max(0, data.usage.dailyLimit - data.usage.generatedToday);
  const selected = data.topics.find((item) => item.id === topic);
  const start = async () => {
    setBusy(true);
    setError(null);
    try { await teacherApi.start({ topic, languages, count, crossCheck }); refresh(); } catch (failure) { setError(errorText(failure, t)); } finally { setBusy(false); }
  };
  return <div className="teacher-form">
    <div className="training-actions training-generate">
      <label><span>{t("Тематика", "Topic")}</span><select value={topic} onChange={(event) => setTopic(event.target.value)}>{data.topics.map((item) => <option key={item.id} value={item.id}>{item.title[language]}</option>)}</select></label>
      <label><span>{t("Примеров", "Examples")}</span><input type="number" min={5} max={200} step={5} value={count} onChange={(event) => setCount(Math.min(200, Math.max(5, Number(event.target.value) || 50)))} /></label>
      <fieldset className="teacher-languages" aria-label={t("Языки", "Languages")}>
        <span aria-hidden>{t("Языки", "Languages")}</span>
        <div className="data-segments">{LANGUAGES.map((code) => <button key={code} type="button" className={languages.includes(code) ? "active" : ""} aria-pressed={languages.includes(code)} onClick={() => setLanguages(languages.includes(code) ? (languages.length > 1 ? languages.filter((item) => item !== code) : languages) : [...languages, code])}>{code.toUpperCase()}</button>)}</div>
      </fieldset>
      <button type="button" className="data-primary" disabled={busy || Boolean(data.progress) || count > left} onClick={start}>{busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}{t("Сгенерировать", "Generate")}</button>
    </div>
    {selected && <small className="teacher-hint">{selected.description[language]}</small>}
    <label className="investigation-toggle"><input type="checkbox" checked={crossCheck} onChange={(event) => setCrossCheck(event.target.checked)} /><span>{t("Перекрёстная проверка: учитель отвечает на вопросы ещё раз вслепую (примерно вдвое дороже, меньше ошибок)", "Cross-check: the teacher answers the questions again blind (about twice the cost, fewer mistakes)")}</span></label>
    <small className="teacher-hint">{pick(language, {
      ru: `Модель ${data.model} · сегодня ${data.usage.generatedToday} из ${data.usage.dailyLimit} примеров (лимит TEACHER_MAX_EXAMPLES_PER_DAY)`,
      en: `Model ${data.model} · today ${data.usage.generatedToday} of ${data.usage.dailyLimit} examples (limit TEACHER_MAX_EXAMPLES_PER_DAY)`,
      de: `Modell ${data.model} · heute ${data.usage.generatedToday} von ${data.usage.dailyLimit} Beispielen (Limit TEACHER_MAX_EXAMPLES_PER_DAY)`,
    })}</small>
    {count > left && <p className="training-error">{left > 0
      ? pick(language, { ru: `На сегодня осталось ${left} примеров: уменьшите количество.`, en: `${left} examples are left for today: lower the count.`, de: `Für heute sind noch ${left} Beispiele übrig: Verringern Sie die Anzahl.` })
      : t("Суточный лимит исчерпан; он обновится в полночь по UTC.", "The daily limit is used up; it resets at midnight UTC.")}</p>}
    {error && <p className="training-error" role="alert">{error}</p>}
  </div>;
}

function BatchProgress({ language, progress, batch, editEnabled }: { language: Language; progress: NonNullable<TeacherState["progress"]>; batch: TeacherBatch | null; editEnabled: boolean }) {
  const t = makeT(language);
  return <div className="teacher-progress">
    <Loader2 size={13} className="spin" />
    <span>{pick(language, { ru: `Учитель пишет: ${progress.done} из ${progress.total}`, en: `The teacher is writing: ${progress.done} of ${progress.total}`, de: `Der Lehrer schreibt: ${progress.done} von ${progress.total}` })}{batch ? ` · ${t("прошли", "passed")} ${batch.counts.passed}` : ""}</span>
    <div className="training-progress"><span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
    {editEnabled && <button type="button" className="data-text-button" onClick={async () => { await teacherApi.cancel(progress.batchId).catch(() => undefined); refresh(); }}><Square size={12} />{t("Остановить", "Stop")}</button>}
  </div>;
}

function BatchRow({ language, data, batch, open, onToggle, editEnabled }: { language: Language; data: TeacherState; batch: TeacherBatch; open: boolean; onToggle(): void; editEnabled: boolean }) {
  const t = makeT(language);
  const topic = data.topics.find((item) => item.id === batch.topic);
  const kept = batch.counts.passed + batch.counts.edited;
  const tokens = batch.promptTokens + batch.completionTokens;
  return <li className={`teacher-batch ${batch.status}`}>
    <button type="button" className="teacher-batch-head" aria-expanded={open} onClick={onToggle}>
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <span className="teacher-batch-title">
        <strong>{topic?.title[language] ?? batch.topic} · {batch.languages.map((code) => code.toUpperCase()).join(" ")}</strong>
        <small>{[formatEventTime(batch.createdAt, language), batch.model, batch.crossCheck ? t("с перекрёстной проверкой", "cross-checked") : null, tokens ? pick(language, { ru: `${(tokens / 1000).toFixed(1)} тыс. токенов`, en: `${(tokens / 1000).toFixed(1)}k tokens`, de: `${(tokens / 1000).toFixed(1)} Tsd. Tokens` }) : null, batch.errorCode ? errorCodeText(batch.errorCode, t) : null].filter(Boolean).join(" · ")}</small>
      </span>
      <span className="teacher-counts">
        <span className="ok" title={t("прошли проверки", "passed the checks")}>{kept}</span>
        {batch.counts.disputed > 0 && <span className="warn" title={t("спорные", "disputed")}>{batch.counts.disputed}</span>}
        {batch.counts.rejected > 0 && <span className="bad" title={t("отклонены", "rejected")}>{batch.counts.rejected}</span>}
      </span>
      <span className={`teacher-status ${batch.status}`}>{statusText(batch.status, t)}</span>
    </button>
    {open && <BatchDetail language={language} batch={batch} editEnabled={editEnabled} />}
  </li>;
}

type Filter = "all" | ExampleStatus;

function BatchDetail({ language, batch, editEnabled }: { language: Language; batch: TeacherBatch; editEnabled: boolean }) {
  const t = makeT(language);
  const detail = useCachedQuery(`training:teacher:batch:${batch.id}`, () => teacherApi.batch(batch.id), batch.status === "generating" ? 2_000 : 60_000);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await action(); refresh(); } catch (failure) { setError(errorText(failure, t)); } finally { setBusy(false); }
  };
  const examples = detail.data?.examples ?? [];
  const shown = filter === "all" ? examples : examples.filter((example) => example.status === filter || (filter === "passed" && example.status === "edited"));
  const missing = Math.max(0, batch.requested - (batch.counts.passed + batch.counts.edited + batch.counts.disputed));
  const reviewable = batch.status === "review" || batch.status === "accepted";
  return <div className="teacher-detail">
    {editEnabled && <div className="training-actions">
      {batch.status === "review" && <button type="button" className="data-primary" disabled={busy || batch.counts.passed + batch.counts.edited === 0} onClick={() => act(() => teacherApi.accept(batch.id, true))}><Check size={13} />{pick(language, { ru: `Принять в датасет (${batch.counts.passed + batch.counts.edited})`, en: `Accept into the dataset (${batch.counts.passed + batch.counts.edited})`, de: `In den Datensatz übernehmen (${batch.counts.passed + batch.counts.edited})` })}</button>}
      {batch.status === "accepted" && <button type="button" className="data-text-button" disabled={busy} onClick={() => act(() => teacherApi.accept(batch.id, false))}><X size={12} />{t("Убрать из датасета", "Take out of the dataset")}</button>}
      {reviewable && batch.status !== "accepted" && missing > 0 && <button type="button" className="data-text-button" disabled={busy} onClick={() => act(() => teacherApi.regenerate(batch.id))}><RefreshCw size={12} />{pick(language, { ru: `Дописать отклонённые (${missing})`, en: `Replace the rejected (${missing})`, de: `Abgelehnte ersetzen (${missing})` })}</button>}
      {batch.status !== "generating" && <button type="button" className="data-text-button danger" disabled={busy} onClick={() => act(() => teacherApi.removeBatch(batch.id))}><Trash2 size={12} />{t("Удалить партию", "Delete the batch")}</button>}
    </div>}
    {batch.status === "accepted" && <small className="teacher-hint">{t("Партия войдёт в набор данных при следующей сборке («Собрать заново»).", "The batch goes into the dataset on its next build (\"Rebuild\").")}</small>}
    {error && <p className="training-error" role="alert">{error}</p>}
    <div className="data-segments" role="group" aria-label={t("Фильтр", "Filter")}>
      {([["all", t("Все", "All"), examples.length], ["passed", t("Прошли", "Passed"), batch.counts.passed + batch.counts.edited], ["disputed", t("Спорные", "Disputed"), batch.counts.disputed], ["rejected", t("Отклонены", "Rejected"), batch.counts.rejected]] as Array<[Filter, string, number]>).map(([id, label, count]) => <button key={id} type="button" className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label} <small>{count}</small></button>)}
    </div>
    {!detail.data ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p> : shown.length === 0 ? <p className="data-empty">{t("Пусто.", "Empty.")}</p>
      : <ul className="teacher-examples">{shown.map((example) => <ExampleRow key={example.id} language={language} example={example} editable={editEnabled && reviewable && batch.status !== "accepted"} />)}</ul>}
  </div>;
}

function ExampleRow({ language, example, editable }: { language: Language; example: TeacherExample; editable: boolean }) {
  const t = makeT(language);
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(example.question);
  const [call, setCall] = useState(() => JSON.stringify({ tool: example.tool, args: example.args }));
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: Parameters<typeof teacherApi.editExample>[1]) => {
    setError(null);
    try { await teacherApi.editExample(example.id, patch); setEditing(false); refresh(); } catch (failure) { setError(errorText(failure, t)); }
  };
  const saveEdit = () => {
    let parsed: { tool?: unknown; args?: unknown };
    try { parsed = JSON.parse(call) as typeof parsed; } catch { setError(t("Вызов — не JSON.", "The call is not JSON.")); return; }
    if (typeof parsed.tool !== "string" || !parsed.args || typeof parsed.args !== "object") { setError(t("Нужен объект {\"tool\": …, \"args\": {…}}.", "Expected an object {\"tool\": …, \"args\": {…}}.")); return; }
    void save({ question, tool: parsed.tool, args: parsed.args as Record<string, unknown> });
  };
  const notes = example.reasons.filter((reason) => reason.code !== "cross_check_mismatch");
  const blind = example.reasons.find((reason) => reason.code === "cross_check_mismatch");
  return <li className={`teacher-example ${example.status}`}>
    <span className={`training-result-icon ${example.status === "rejected" ? "bad" : example.status === "disputed" ? "" : "ok"}`}>{example.status === "rejected" ? <X size={12} /> : example.status === "disputed" ? "?" : <Check size={12} />}</span>
    {editing ? <div className="teacher-edit">
      <textarea rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} aria-label={t("Вопрос", "Question")} />
      <textarea rows={3} value={call} onChange={(event) => setCall(event.target.value)} aria-label={t("Вызов", "Call")} spellCheck={false} />
      <div className="training-actions">
        <button type="button" className="data-primary" onClick={saveEdit}>{t("Проверить и сохранить", "Check and save")}</button>
        <button type="button" className="data-text-button" onClick={() => { setEditing(false); setError(null); }}>{t("Отмена", "Cancel")}</button>
      </div>
    </div> : <div className="training-item-copy">
      <p>{example.question} <small>{example.language.toUpperCase()}{example.status === "edited" ? ` · ${t("одобрен человеком", "approved by a person")}` : ""}</small></p>
      <code>{example.tool} {JSON.stringify(example.args)}</code>
      {notes.length > 0 && <small className={example.status === "rejected" ? "training-error" : "teacher-hint"}>{notes.map((reason) => reasonText(reason, t)).join(" · ")}</small>}
      {blind && <small className="teacher-hint">{t("Учитель вслепую ответил иначе:", "The teacher answered differently blind:")} <code>{blind.detail}</code></small>}
    </div>}
    {editable && !editing && <div className="training-item-actions">
      {example.status === "disputed" && <button type="button" title={t("Оставить как есть", "Keep as it is")} aria-label={t("Оставить как есть", "Keep as it is")} onClick={() => save({ approve: true })}><Check size={12} /></button>}
      <button type="button" title={t("Исправить", "Edit")} aria-label={t("Исправить", "Edit")} onClick={() => setEditing(true)}><Pencil size={12} /></button>
      <button type="button" className="danger" title={t("Удалить", "Delete")} aria-label={t("Удалить", "Delete")} onClick={async () => { await teacherApi.removeExample(example.id).catch(() => undefined); refresh(); }}><Trash2 size={12} /></button>
    </div>}
    {error && <small className="training-error teacher-row-error">{error}</small>}
  </li>;
}

function statusText(status: TeacherBatch["status"], t: Translator): string {
  return { generating: t("пишется", "writing"), review: t("на проверке", "to review"), accepted: t("в датасете", "in the dataset"), failed: t("ошибка", "failed"), cancelled: t("остановлена", "stopped") }[status];
}

function reasonText(reason: { code: string; detail?: string }, t: Translator): string {
  const labels: Record<string, string> = {
    invalid_call: t("инструмент не принял аргументы", "the tool refused the arguments"),
    question_length: t("слишком короткий или длинный вопрос", "the question is too short or too long"),
    language_mismatch: t("язык не совпадает", "the language does not match"),
    off_topic: t("не по тематике", "off the topic"),
    not_earthquakes: t("search_events только для землетрясений", "search_events is for earthquakes only"),
    city_unknown: t("города нет в базе", "the city is not in the database"),
    duplicate: t("повтор", "a repeat"),
    benchmark_leak: t("вопрос из бенчмарка", "a benchmark question"),
    city_corrected: t("город исправлен", "city corrected"),
  };
  const label = labels[reason.code] ?? reason.code;
  return reason.detail && reason.code !== "invalid_call" ? `${label}: ${reason.detail}` : label;
}

function errorCodeText(code: string, t: Translator): string {
  const labels: Record<string, string> = {
    cancelled: t("остановлена", "stopped"),
    interrupted: t("прервана перезапуском сервера", "interrupted by a server restart"),
    teacher_unauthorized: t("OpenAI не принял ключ", "OpenAI refused the key"),
    teacher_rate_limited: t("лимит запросов OpenAI", "OpenAI rate limit"),
    teacher_refused: t("OpenAI отказался отвечать", "OpenAI refused to answer"),
    teacher_invalid_answer: t("ответ OpenAI не по схеме", "OpenAI's answer did not fit the schema"),
    teacher_failed: t("OpenAI недоступен", "OpenAI is unavailable"),
    teacher_unavailable: t("нет OPENAI_API_KEY", "no OPENAI_API_KEY"),
    daily_limit: t("суточный лимит исчерпан", "the daily limit is used up"),
    teacher_running: t("уже идёт другая партия", "another batch is running"),
    batch_busy: t("партия сейчас занята", "the batch is busy"),
    nothing_to_regenerate: t("нечего дописывать", "nothing to replace"),
    not_disputed: t("пример не спорный", "the example is not disputed"),
  };
  return labels[code] ?? code;
}

function errorText(failure: unknown, t: Translator): string {
  return errorCodeText(failure instanceof TrainingRequestError ? failure.code : "request_failed", t);
}
