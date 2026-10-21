import type { AppliedLesson, Lesson, LessonInput } from "@waypoint-ai/shared";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { makeT, type Language } from "../../shared/i18n";
import { formatEventTime, pick } from "../investigation/format";
import Switch from "./Switch";
import { trainingApi } from "./training-api";
import { errorText, EXAMPLE_TOOLS, percent, refreshTraining, TOPICS, topicLabel } from "./training-format";

/** Prompt lessons: rules for every request and examples for similar questions, with a preview of what a message gets. */

type Editing = { kind: "rule" | "example"; lesson?: Lesson } | null;

export default function LessonsSection({ language, lessons, editEnabled }: { language: Language; lessons: Lesson[] | null; editEnabled: boolean }) {
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
