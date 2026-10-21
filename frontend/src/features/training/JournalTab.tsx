import { Check, DatabaseZap, Loader2, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { invalidateCache, useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language, type Translator } from "../../shared/i18n";
import { formatEventTime, pick } from "../investigation/format";
import { importStore } from "../imports/import-store";
import { journalApi, type JournalEntry } from "./journal-api";
import { TrainingRequestError } from "./training-api";

type Filter = "candidates" | "all" | "confirmed";
const TOOLS = ["search_places", "search_events", "plan_trip", "list_sources", "reply"] as const;
const refresh = () => invalidateCache("training:journal");

/**
 * Real chat turns, kept on this machine: the ones that went wrong are review candidates. A confirmed turn becomes a
 * benchmark case and a training example; a settlement name users write becomes an alias the server resolves.
 */
export default function JournalTab({ language, editEnabled }: { language: Language; editEnabled: boolean }) {
  const t = makeT(language);
  const [filter, setFilter] = useState<Filter>("candidates");
  const [page, setPage] = useState(0);
  const list = useCachedQuery(`training:journal:${filter}:${page}`, () => journalApi.list(filter, 20, page * 20), 15_000);
  const stats = list.data?.stats;
  return <div className="training-journal">
    <p className="training-intro">{t(
      "Журнал хранит запросы чата только на этой машине и удаляет их через 30 дней. Кандидаты — ходы с признаками ошибки: пустой результат, город не найден, неверные аргументы, ответ без инструмента, перефразирование следующим сообщением или оценка «плохо». Подтверждённый правильный вызов попадает в бенчмарк и в набор данных для дообучения.",
      "The journal keeps chat requests on this machine only and deletes them after 30 days. Candidates are turns with signs of failure: an empty result, a settlement not found, invalid arguments, an answer without a tool, a rewording in the next message, or a \"bad answer\" rating. A confirmed right call goes into the benchmark and the training dataset.",
    )}</p>
    {stats && <dl className="data-summary">
      <div><dd>{stats.total}</dd><dt>{t("ходов в журнале", "turns in the journal")}</dt></div>
      <div><dd>{stats.candidates}</dd><dt>{t("ждут разбора", "await review")}</dt></div>
      <div><dd>{stats.confirmed}</dd><dt>{t("подтверждено", "confirmed")}</dt></div>
      <div><dd>{stats.thumbsUp} / {stats.thumbsDown}</dd><dt>{t("оценки: хорошо / плохо", "ratings: good / bad")}</dt></div>
      <div><dd>{stats.failureShareWeek === null ? "—" : `${Math.round(stats.failureShareWeek * 100)}%`}</dd><dt>{t("ходов с ошибкой за неделю", "turns with a failure this week")}</dt></div>
    </dl>}
    <div className="training-split">
      <div className="training-column">
        <div className="data-segments" role="radiogroup" aria-label={t("Фильтр", "Filter")}>
          {(["candidates", "all", "confirmed"] as const).map((item) => <button key={item} type="button" role="radio" aria-checked={filter === item} className={filter === item ? "active" : ""} onClick={() => { setFilter(item); setPage(0); }}>
            {item === "candidates" ? t("Кандидаты", "Candidates") : item === "all" ? t("Все", "All") : t("Подтверждённые", "Confirmed")}
          </button>)}
        </div>
        {!list.data ? <p className="data-empty">{list.error ? t("Не удалось загрузить журнал.", "Could not load the journal.") : t("Загружаю…", "Loading…")}</p>
          : !list.data.entries.length ? <p className="data-empty">{filter === "candidates" ? t("Кандидатов нет: либо всё хорошо, либо чатом ещё не пользовались.", "No candidates: either all is well or the chat has not been used yet.") : t("Пусто.", "Empty.")}</p>
            : <ul className="training-list">{list.data.entries.map((entry) => <JournalRow key={entry.id} language={language} entry={entry} editEnabled={editEnabled} />)}</ul>}
        {list.data && list.data.total > 20 && <div className="training-actions">
          <button type="button" className="data-text-button" disabled={page === 0} onClick={() => setPage(page - 1)}>←</button>
          <small>{page * 20 + 1}–{Math.min(list.data.total, (page + 1) * 20)} / {list.data.total}</small>
          <button type="button" className="data-text-button" disabled={(page + 1) * 20 >= list.data.total} onClick={() => setPage(page + 1)}>→</button>
        </div>}
      </div>
      <div className="training-column">
        <Gaps language={language} />
        <Aliases language={language} editEnabled={editEnabled} />
      </div>
    </div>
  </div>;
}

function signalLabels(entry: JournalEntry, t: Translator): string[] {
  const signals = entry.signals;
  return [
    signals.emptyResult ? t("пустой результат", "empty result") : null,
    signals.placeNotFound ? `${t("не найдено", "not found")}: ${signals.placeNotFound}` : null,
    signals.invalidArgs ? t("неверные аргументы", "invalid arguments") : null,
    signals.retriedWithoutTool ? t("ответ без инструмента", "answer without a tool") : null,
    signals.rephrased ? t("перефразировано", "reworded") : null,
    entry.outcome === "error" ? `${t("ошибка", "error")}: ${entry.errorCode ?? "—"}` : null,
    entry.feedback === -1 ? t("оценка: плохо", "rated bad") : entry.feedback === 1 ? t("оценка: хорошо", "rated good") : null,
  ].filter((value): value is string => Boolean(value));
}

function JournalRow({ language, entry, editEnabled }: { language: Language; entry: JournalEntry; editEnabled: boolean }) {
  const t = makeT(language);
  const [open, setOpen] = useState(false);
  const first = entry.toolCalls[0];
  const [tool, setTool] = useState<string>(entry.corrected?.tool ?? first?.tool ?? "search_places");
  const [args, setArgs] = useState(JSON.stringify(entry.corrected?.args ?? (first?.args && typeof first.args === "object" ? first.args : {}), null, 0));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(args || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      parsed = value as Record<string, unknown>;
    } catch {
      setError(t("Аргументы должны быть JSON-объектом.", "Arguments must be a JSON object."));
      return;
    }
    setSaving(true);
    try {
      await journalApi.review(entry.id, { status: "confirmed", tool, args: tool === "reply" || tool === "list_sources" ? {} : parsed });
      refresh();
      invalidateCache("training:cases");
    } catch (failure) {
      const code = failure instanceof TrainingRequestError ? failure.code : "";
      setError(code === "invalid_example_args" ? t("Инструмент не примет такие аргументы: проверьте поля (например, place, а не координаты).", "The tool would refuse these arguments: check the fields (for example place, not coordinates).") : t("Не получилось сохранить.", "Could not save."));
    } finally { setSaving(false); }
  };
  const dismiss = async () => {
    try { await journalApi.review(entry.id, { status: "dismissed" }); refresh(); } catch { setError(t("Не получилось.", "That did not work.")); }
  };
  const signals = signalLabels(entry, t);
  return <li className={`training-item journal${entry.reviewStatus !== "new" ? " off" : ""}`}>
    <span className={`training-result-icon ${signals.length ? "bad" : "ok"}`}>{signals.length ? <X size={12} /> : <Check size={12} />}</span>
    <div className="training-item-copy">
      <button type="button" className="training-journal-message" aria-expanded={open} onClick={() => setOpen(!open)}><span className="training-lang">{entry.language ?? "—"}</span>{entry.message}</button>
      <code>{entry.toolCalls.length ? entry.toolCalls.map((call) => `${call.tool} ${JSON.stringify(call.args ?? {})}${call.error ? ` · ${t("ошибка", "error")}: ${call.error}` : call.resultCount === 0 ? " → 0" : ""}`).join(" · ") : t("без вызова инструмента", "no tool call")}</code>
      <small>{[formatEventTime(entry.createdAt, language), `${Math.round(entry.durationMs / 1000)} ${t("с", "s")}`, ...signals, entry.reviewStatus === "confirmed" ? t("подтверждено", "confirmed") : entry.reviewStatus === "dismissed" ? t("отклонено", "dismissed") : null].filter(Boolean).join(" · ")}</small>
      {open && editEnabled && entry.reviewStatus === "new" && <form className="training-review" onSubmit={confirm}>
        <span className="training-intro">{t("Правильный первый вызов для этого запроса:", "The right first call for this request:")}</span>
        <div className="training-row">
          <select value={tool} onChange={(event) => setTool(event.target.value)} aria-label={t("Инструмент", "Tool")}>{TOOLS.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          {tool !== "reply" && tool !== "list_sources" && <input className="mono" value={args} onChange={(event) => setArgs(event.target.value)} aria-label={t("Аргументы (JSON)", "Arguments (JSON)")} />}
        </div>
        {error && <p className="training-error" role="alert">{error}</p>}
        <div className="training-actions">
          <button type="submit" className="data-primary" disabled={saving}>{saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />}{t("Подтвердить", "Confirm")}</button>
          <button type="button" className="data-text-button" onClick={dismiss}>{t("Отклонить", "Dismiss")}</button>
        </div>
      </form>}
    </div>
  </li>;
}

function Gaps({ language }: { language: Language }) {
  const t = makeT(language);
  const gaps = useCachedQuery("training:journal:gaps", () => journalApi.gaps(), 60_000);
  const data = gaps.data;
  return <section className="training-editor">
    <h3 className="data-section-title">{t("Пробелы в данных", "Data gaps")}</h3>
    <p className="training-intro">{t("О чём спрашивали, но чего нет в базе. Импорт закрывает пробел для всех следующих запросов.", "What was asked for but is not in the database. An import closes the gap for every later request.")}</p>
    {!data ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p> : !data.missingPlaces.length && !data.emptySearches.length ? <p className="data-empty">{t("Пробелов не найдено.", "No gaps found.")}</p> : <>
      {data.missingPlaces.length > 0 && <ul className="training-applied">{data.missingPlaces.map((gap) => <li key={gap.name}><span className="training-kind">{t("город", "town")}</span>{gap.name}<small>{pick(language, { ru: `${gap.count} раз`, en: `${gap.count} times`, de: `${gap.count}-mal` })}</small></li>)}</ul>}
      {data.emptySearches.length > 0 && <ul className="training-applied">{data.emptySearches.map((gap) => <li key={`${gap.city}-${gap.kind}`}><span className="training-kind example">{gap.kind ?? t("места", "places")}</span>{gap.city}<small>{pick(language, { ru: `${gap.count} раз · 0 результатов`, en: `${gap.count} times · 0 results`, de: `${gap.count}-mal · 0 Treffer` })}</small></li>)}</ul>}
      <div className="training-actions"><button type="button" className="data-text-button" onClick={() => importStore.openDialog(undefined, "area")}><DatabaseZap size={13} />{t("Импортировать город", "Import a city")}</button></div>
    </>}
  </section>;
}

function Aliases({ language, editEnabled }: { language: Language; editEnabled: boolean }) {
  const t = makeT(language);
  const aliases = useCachedQuery("training:journal:aliases", () => journalApi.aliases(), 60_000);
  const [alias, setAlias] = useState("");
  const [settlement, setSettlement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await journalApi.addAlias(alias, settlement);
      setAlias("");
      setSettlement("");
      refresh();
    } catch (failure) {
      const code = failure instanceof TrainingRequestError ? failure.code : "";
      setError(code === "settlement_not_found" ? t("Такого населённого пункта нет в базе: укажите местное название (Roma, Kraków).", "No such settlement in the database: use the local name (Roma, Kraków).")
        : code === "alias_is_a_settlement" ? t("Это название уже принадлежит другому населённому пункту.", "This name already belongs to another settlement.")
          : t("Не получилось сохранить.", "Could not save."));
    }
  };
  return <section className="training-editor">
    <h3 className="data-section-title">{t("Псевдонимы городов", "Settlement aliases")}</h3>
    <p className="training-intro">{t("Как люди называют города, а сервер распознаёт без модели: «Норча» → Norcia, «Рим» → Roma. Работает сразу и для всех запросов.", "How people name towns, resolved by the server without the model: \"Норча\" → Norcia, \"Рим\" → Roma. Works at once for every request.")}</p>
    {editEnabled && <form className="training-row" onSubmit={add}>
      <input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder={t("Как пишут: Норча", "As written: Норча")} aria-label={t("Псевдоним", "Alias")} required minLength={2} maxLength={120} />
      <input value={settlement} onChange={(event) => setSettlement(event.target.value)} placeholder={t("Город в базе: Norcia", "Town in the database: Norcia")} aria-label={t("Населённый пункт", "Settlement")} required maxLength={120} />
      <button type="submit" className="data-text-button">{t("Добавить", "Add")}</button>
    </form>}
    {error && <p className="training-error" role="alert">{error}</p>}
    {aliases.data?.length ? <ul className="training-applied">{aliases.data.map((item) => <li key={item.alias}>{item.alias} → <strong>{item.name}</strong>{item.countryCode && <small>{item.countryCode}</small>}
      {editEnabled && <button type="button" className="data-icon-button small" aria-label={t("Удалить", "Delete")} onClick={async () => { await journalApi.deleteAlias(item.alias).catch(() => undefined); refresh(); }}><Trash2 size={12} /></button>}</li>)}</ul>
      : <p className="data-empty">{t("Псевдонимов пока нет.", "No aliases yet.")}</p>}
  </section>;
}

/** Thumbs under an assistant answer; they only mark the turn for review in the journal. */
export function AnswerFeedback({ language, requestId }: { language: Language; requestId: string }) {
  const t = makeT(language);
  const [rating, setRating] = useState<1 | -1 | null>(null);
  const send = async (value: 1 | -1) => {
    const next = rating === value ? null : value;
    setRating(next);
    await journalApi.feedback(requestId, next).catch(() => setRating(rating));
  };
  return <span className="answer-feedback">
    <button type="button" aria-pressed={rating === 1} title={t("Хороший ответ", "Good answer")} aria-label={t("Хороший ответ", "Good answer")} onClick={() => send(1)}><ThumbsUp size={12} /></button>
    <button type="button" aria-pressed={rating === -1} title={t("Плохой ответ: отправить на разбор", "Bad answer: send for review")} aria-label={t("Плохой ответ", "Bad answer")} onClick={() => send(-1)}><ThumbsDown size={12} /></button>
  </span>;
}
