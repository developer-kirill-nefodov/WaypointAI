import { AlertTriangle, Check, Copy, CircleSlash, MapPinned, RotateCcw, Sparkles, WifiOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { makeT, type Language } from "../../shared/i18n";
import { pick } from "../investigation/format";
import type { Message, TurnStep } from "./chat-storage";
import { formatClock, formatDuration } from "./format-duration";
import TurnSteps, { useNow } from "./TurnSteps";

/**
 * The chat's message cards: the user's bubble, the assistant's answer card (header with model and time, the text,
 * what it put on the map, sources, and one line of actions), the cards for an error, a stop, or a lost connection,
 * and the live card of a running turn, which the answer later replaces in place.
 */

/** Silence from the model (no token yet) longer than this shows a hint that a CPU model is slow to start. */
const SLOW_HINT_MS = 10_000;

export function UserBubble({ message, language }: { message: Message; language: Language }) {
  return <article className="message user">
    {message.tagsOnly ? <span className="message-tags-label">{makeT(language)("Уточнение", "Details")}</span> : <p>{message.text}</p>}
    {message.tags?.length ? <div className="message-tags">{message.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
    {message.at && <time className="message-time" dateTime={new Date(message.at).toISOString()}>{formatClock(message.at, language)}</time>}
  </article>;
}

function CardHead({ language, models, at, live }: { language: Language; models?: string[]; at?: number; live?: ReactNode }) {
  const t = makeT(language);
  // A fine-tuned router is named apart from the main model; the main model is the last one used.
  const model = models?.at(-1)?.replace(/-instruct.*$|:latest$/, "");
  const router = models && models.length > 1 ? models[0]!.replace(/:.*$/, "") : null;
  return <header className="answer-head">
    <span className="answer-avatar" aria-hidden="true"><Sparkles size={13} /></span>
    <strong>{t("Ассистент", "Assistant")}</strong>
    {live ?? <>
      {model && <span className="answer-model" title={models!.join(" → ")}>{router ? `${router} → ` : ""}{model}</span>}
      {at && <time className="answer-time" dateTime={new Date(at).toISOString()}>{formatClock(at, language)}</time>}
    </>}
  </header>;
}

/**
 * What this answer put on the map. Events come first: a conversation that shows a trip plan keeps it on the map
 * while later answers find events, so the plan is named only when the answer found nothing else.
 */
function resultText(result: NonNullable<Message["result"]>, language: Language): string | null {
  if (result.records) return pick(language, { ru: `событий: ${result.records}`, en: `${result.records} events`, de: `${result.records} Ereignisse` });
  if (result.tripDays) return pick(language, { ru: `план на ${result.tripDays} дн.`, en: `a ${result.tripDays}-day plan`, de: `ein Plan für ${result.tripDays} Tage` });
  if (result.places) return pick(language, { ru: `мест: ${result.places}`, en: `${result.places} places`, de: `${result.places} Orte` });
  return null;
}

export interface AnswerCardProps {
  message: Message;
  language: Language;
  /** The rendered text (Markdown with citations). */
  body: ReactNode;
  /** Sources of the answer, rendered by the caller. */
  sources?: ReactNode;
  /** Rating buttons for answers the journal keeps. */
  feedback?: ReactNode;
  /** The one-time filters of a clarification, while it waits for its answer. */
  form?: ReactNode;
  /** Follow-up requests under the latest answer. */
  followUps?: ReactNode;
  pending: boolean;
  /** Fits the map to this answer's result; only the latest answer's result is on the map. */
  onShowOnMap?: () => void;
  onChoice(label: string): void;
  onRetry?: (query: string) => void;
}

export function AnswerCard({ message, language, body, sources, feedback, form, followUps, pending, onShowOnMap, onChoice, onRetry }: AnswerCardProps) {
  const t = makeT(language);
  const [copied, setCopied] = useState(false);
  const kind = message.kind ?? "answer";
  const problem = kind === "error" || kind === "cancelled" || kind === "lost";
  const copy = async () => {
    // Citation refs ([E1], [P2]) belong to the chat, not to a pasted text.
    await navigator.clipboard?.writeText(message.text.replace(/\s?\[[EP]\d+\]/g, "")).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const summary = message.result ? resultText(message.result, language) : null;
  if (problem) {
    const icon = kind === "error" ? <AlertTriangle size={14} /> : kind === "lost" ? <WifiOff size={14} /> : <CircleSlash size={14} />;
    return <article className={`message assistant answer-card answer-${kind}`} role={kind === "error" ? "alert" : undefined}>
      <div className="answer-problem">
        <span className="answer-problem-icon" aria-hidden="true">{icon}</span>
        <p>{message.text}</p>
      </div>
      {message.steps?.length ? <TurnSteps steps={message.steps} language={language} collapsed /> : null}
      <footer className="answer-actions">
        {message.durationMs !== undefined && <span className="answer-duration">{formatDuration(message.durationMs, language)}</span>}
        {message.query && onRetry && <button type="button" className="answer-action" disabled={pending} onClick={() => onRetry(message.query!)}><RotateCcw size={12} />{t("Отправить снова", "Send again")}</button>}
      </footer>
    </article>;
  }
  return <article className={`message assistant answer-card${kind === "clarification" ? " answer-clarification" : ""}`}>
    <CardHead language={language} models={message.models} at={message.at} />
    <div className="message-content">{body}</div>
    {form}
    {message.choices?.length ? <div className="clarification-choices">{message.choices.map((choice) => <button key={choice.id} type="button" disabled={pending} onClick={() => onChoice(choice.label)}>{choice.label}</button>)}</div> : null}
    {summary && (onShowOnMap
      ? <button type="button" className="answer-result" onClick={onShowOnMap}><MapPinned size={13} />{t("На карте", "On the map")}: {summary}<span aria-hidden="true">›</span></button>
      : <span className="answer-result static"><MapPinned size={13} />{summary}</span>)}
    {sources}
    <footer className="answer-actions">
      {message.durationMs !== undefined && <span className="answer-duration" title={t("Время ответа", "Response time")}>{formatDuration(message.durationMs, language)}</span>}
      {message.steps?.length ? <TurnSteps steps={message.steps} language={language} collapsed /> : null}
      <span className="answer-actions-end">
        {message.text && message.durationMs !== undefined && <button type="button" className="answer-icon-button" onClick={copy} title={t("Копировать ответ", "Copy the answer")} aria-label={t("Копировать ответ", "Copy the answer")}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>}
        {feedback}
      </span>
    </footer>
    {followUps}
  </article>;
}

/** The running turn: live steps with timers and token counts, then the streamed text in the same card. */
export function LiveTurnCard({ steps, startedAt, label, text, language, body }: { steps: TurnStep[]; startedAt: number; label: string; text: string; language: Language; body: ReactNode }) {
  const t = makeT(language);
  const now = useNow(true, 100);
  const running = [...steps].reverse().find((step) => step.state === "running");
  const silent = running && (!running.progress || running.progress.tokens === 0) && running.startedAt && now - running.startedAt > SLOW_HINT_MS;
  return <article className="message assistant answer-card answer-live" aria-busy="true">
    <CardHead language={language} live={<span className="answer-live-status" role="status" aria-live="polite"><span className="progress-dot" aria-hidden="true" />{running?.label ?? label}<span className="answer-live-timer">{formatDuration(now - startedAt, language)}</span></span>} />
    {steps.length > 0 && <TurnSteps steps={steps} language={language} now={now} />}
    {silent && <p className="answer-hint">{t("Модель работает на процессоре: первый ответ может занять до минуты.", "The model runs on the CPU: the first answer can take up to a minute.")}</p>}
    {text ? <div className="message-content streaming">{body}</div> : <div className="answer-skeleton" aria-hidden="true"><span /><span /><span /></div>}
  </article>;
}
