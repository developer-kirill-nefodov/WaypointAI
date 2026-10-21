import { ArrowUp, ArrowUpRight, ChevronDown, Clock3, Layers3, MoreHorizontal, Plus, RefreshCw, SlidersHorizontal, Sparkles, Square, Trash2 } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { SourceView } from "@waypoint-ai/shared";
import { makeT, type Language } from "../../shared/i18n";
import type { SavedChat } from "./chat-storage";
import { conversationTitle, formatChatDate } from "./chat-utils";

/** The chat's controls around the messages: header with history, filters, suggestions, and the composer. */

const closeMenu = (element: HTMLElement) => element.closest("details")?.removeAttribute("open");

export function ChatHeader({ language, title, busy, recentChats, resultSources, onNewChat, onOpenChat, onResetHistory }: {
  language: Language; title: string; busy: boolean; recentChats: SavedChat[]; resultSources: SourceView[];
  onNewChat(): void; onOpenChat(id: string): void; onResetHistory(): void;
}) {
  const t = makeT(language);
  return <div className="panel-heading chat-heading">
    <div className="chat-heading-title"><span className="eyebrow">{t("ЛОКАЛЬНЫЙ ПОМОЩНИК", "LOCAL ASSISTANT")}</span><h2 title={title}>{title}</h2></div>
    <div className="panel-heading-actions">
      <button type="button" className="new-chat-button" disabled={busy} onClick={onNewChat}><Plus size={15} /><span>{t("Новый чат", "New chat")}</span></button>
      <details className="chat-options">
        <summary className="icon-button" aria-label={t("Опции чата", "Chat options")} title={t("История и настройки", "History and settings")}><MoreHorizontal size={18} /></summary>
        <div className="chat-options-menu">
          <div className="chat-options-heading"><Clock3 size={14} /><span>{t("Недавние чаты", "Recent chats")}</span><small>{recentChats.length}</small></div>
          {recentChats.length ? <div className="recent-chat-list">
            {recentChats.map((chat) => <button key={chat.id} type="button" className="recent-chat-item" onClick={(event) => { onOpenChat(chat.id); closeMenu(event.currentTarget); }}>
              <span>{conversationTitle(chat.messages, language)}</span><small>{formatChatDate(chat.savedAt, language)}</small>
            </button>)}
          </div> : <p className="chat-options-empty">{t("Новый чат сохраняет предыдущий здесь, чтобы вы могли к нему вернуться.", "Starting a new chat keeps the previous one here so you can return to it.")}</p>}
          {resultSources.length > 0 && <section className="chat-options-sources" aria-label={t("Источники последнего ответа", "Sources for the latest answer")}>
            <div className="chat-options-heading"><Layers3 size={14} /><span>{t("Источники последнего ответа", "Sources for the latest answer")}</span><small>{resultSources.length}</small></div>
            <div className="chat-option-source-list">{resultSources.map((source) => <div key={source.id} className="chat-option-source">
              <strong>{source.label}</strong>
              <span>{[source.license, source.snapshotDate ? `${t("снимок", "snapshot")} ${source.snapshotDate}` : null].filter(Boolean).join(" · ") || source.mode}</span>
            </div>)}</div>
          </section>}
          <p className="chat-history-note">{t("Хранится в этом браузере до 30 дней.", "Stored in this browser for up to 30 days.")}</p>
          <button type="button" className="clear-history-option" disabled={busy} onClick={(event) => { onResetHistory(); closeMenu(event.currentTarget); }}><Trash2 size={14} /><span>{t("Удалить всю историю", "Delete all history")}</span></button>
        </div>
      </details>
    </div>
  </div>;
}

export interface ChatFilterState {
  selectedSourceIds: string[];
  fromDate: string;
  toDate: string;
}

export function ChatFilters({ language, expanded, onToggle, sources, sourcesFailed, databaseUnavailable, filters, onSources, onFromDate, onToDate, dateRangeInvalid }: {
  language: Language; expanded: boolean; onToggle(): void; sources: SourceView[]; sourcesFailed: boolean; databaseUnavailable: boolean;
  filters: ChatFilterState; onSources(update: (current: string[]) => string[]): void; onFromDate(value: string): void; onToDate(value: string): void; dateRangeInvalid: boolean;
}) {
  const t = makeT(language);
  const { selectedSourceIds, fromDate, toDate } = filters;
  const activeCount = Number(selectedSourceIds.length > 0) + Number(Boolean(fromDate || toDate));
  return <>
    <button type="button" className="section-toggle filters-toggle" aria-expanded={expanded} aria-controls="chat-filters" onClick={onToggle}><SlidersHorizontal size={15} /><span>{t("Фильтры", "Filters")}</span><small>{activeCount ? `${activeCount} ${t("активных", "active")}` : t("Источники и период", "Sources and date range")}</small><ChevronDown size={15} className="section-chevron" /></button>
    <div id="chat-filters" className={`inline-disclosure${expanded ? " is-open" : ""}`} aria-hidden={!expanded} inert={!expanded}>
      <div className="inline-disclosure-inner"><div className="scope-controls" aria-label={t("Фильтры запроса", "Query filters")}>
        <details className="source-filter">
          <summary><span>{t("Источники", "Sources")}</span><strong>{selectedSourceIds.length ? `${t("Выбрано", "Selected")}: ${selectedSourceIds.length}` : t("Все", "All")}</strong></summary>
          <div className="source-filter-menu">
            {sources.map((source) => <label key={source.id} className="source-option">
              <input type="checkbox" checked={selectedSourceIds.includes(source.id)} disabled={!selectedSourceIds.includes(source.id) && selectedSourceIds.length >= 20} onChange={(event) => onSources((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id))} />
              <span><strong>{source.label}</strong><small>{source.mode === "public_snapshot" ? t("Публичный снимок", "Public snapshot") : source.mode === "synthetic_local" ? t("Синтетические демо-данные", "Synthetic demo data") : source.mode}</small></span>
            </label>)}
            {!sources.length && <p className="source-empty">{sourcesFailed ? t("Не удалось загрузить источники", "Could not load sources") : databaseUnavailable ? t("База данных пока недоступна", "Database is not available yet") : t("Источников пока нет", "No sources available")}</p>}
            {selectedSourceIds.length > 0 && <button type="button" className="clear-sources" onClick={() => onSources(() => [])}>{t("Сбросить выбор · использовать все", "Clear selection · use all sources")}</button>}
          </div>
        </details>
        <div className="date-filter">
          <label>{t("С", "From")} <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => onFromDate(event.target.value)} /></label>
          <label>{t("По", "To")} <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => onToDate(event.target.value)} /></label>
        </div>
        {dateRangeInvalid && <p className="filter-error" role="alert">{t("Начало периода должно быть раньше окончания.", "The start date must be before the end date.")}</p>}
      </div></div>
    </div>
  </>;
}

export function SuggestionsPanel({ language, expanded, onToggle, total, visible, onMore, onChoose }: {
  language: Language; expanded: boolean; onToggle(): void; total: number; visible: Array<{ label: string; prompt: string }>; onMore(): void; onChoose(prompt: string): void;
}) {
  const t = makeT(language);
  return <div className="suggestions-panel">
    <div className="suggestions-heading">
      <button type="button" className="section-toggle suggestions-toggle" aria-expanded={expanded} aria-controls="suggested-requests" onClick={onToggle}>
        <Sparkles size={14} /><span>{t("Актуальные подсказки", "Suggested follow-ups")}</span><small>{total}</small><ChevronDown size={14} className="section-chevron" />
      </button>
      {expanded && <button type="button" className="refresh-suggestions" onClick={onMore} aria-label={t("Обновить подсказки", "Refresh suggestions")} title={t("Показать другие подсказки", "Show other suggestions")}><RefreshCw size={13} /><span>{t("Другие", "More")}</span></button>}
    </div>
    <div id="suggested-requests" className={`inline-disclosure${expanded ? " is-open" : ""}`} aria-hidden={!expanded} inert={!expanded}>
      <div className="inline-disclosure-inner">
        {expanded && <div className="suggestions" aria-label={t("Рекомендуемые запросы", "Suggested prompts")}>{visible.map((reply) => <button key={reply.label} onClick={() => onChoose(reply.prompt)}><span>{reply.label}</span><ArrowUpRight size={14} /></button>)}</div>}
      </div>
    </div>
  </div>;
}

export function ChatComposer({ language, composerRef, draft, onDraft, onSubmit, dictating, canSend, statusText, statusClass, pending, onCancel, mic }: {
  language: Language; composerRef: RefObject<HTMLTextAreaElement | null>; draft: string; onDraft(value: string): void; onSubmit(): void;
  /** Dictation is running: the text is written by the transcript. */
  dictating: boolean; canSend: boolean; statusText: string; statusClass?: string; pending: boolean; onCancel(): void; mic?: ReactNode;
}) {
  const t = makeT(language);
  return <form className="composer" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <textarea ref={composerRef} value={draft} readOnly={dictating} onChange={(event) => onDraft(event.target.value)} onKeyDown={(event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
      }
    }} placeholder={t("Введите запрос · Enter — отправить, Shift+Enter — новая строка", "Ask a question · Enter to send, Shift+Enter for a new line")} rows={2} aria-label={t("Сообщение помощнику", "Message the assistant")} />
    <div className="composer-footer">
      <span className={statusClass} role="status" aria-live="polite">{statusText}</span>
      <div className="composer-actions">
        {pending && <button type="button" className="cancel-request" onClick={onCancel}><Square size={12} />{t("Остановить", "Stop")}</button>}
        {mic}
        <button type="submit" disabled={!canSend} aria-label={t("Отправить запрос", "Send request")}><ArrowUp size={17} /></button>
      </div>
    </div>
  </form>;
}
