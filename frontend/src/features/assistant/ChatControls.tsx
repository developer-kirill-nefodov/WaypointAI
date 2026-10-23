import { ArrowUp, Clock3, Layers3, MoreHorizontal, Plus, Square, Trash2 } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { SourceView } from "@waypoint-ai/shared";
import { makeT, type Language } from "../../shared/i18n";
import type { SavedChat } from "./chat-storage";
import { conversationTitle, formatChatDate } from "./chat-utils";

/** The chat's controls around the messages: the header with the history, and the composer. */

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
