import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { pick } from "../investigation/format";
import { translate, type Language } from "../../shared/i18n";
import type { TurnStep } from "./chat-storage";
import { formatDuration } from "./format-duration";

/** The current time, refreshed every interval while active: drives the live timers without re-rendering the chat. */
export function useNow(active: boolean, intervalMs = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** What a running step's model call is doing: reading the prompt, or the tokens written so far and their rate. */
function progressText(step: TurnStep, language: Language): string | null {
  if (step.state !== "running" || !step.progress) return null;
  if (step.progress.phase === "reading" || step.progress.tokens === 0) return translate(language, "модель читает запрос", "the model reads the prompt");
  const { tokens, tokensPerSecond } = step.progress;
  const rate = tokensPerSecond ? ` · ${String(tokensPerSecond).replace(".", language === "en" ? "." : ",")} ${pick(language, { ru: "ток/с", en: "tok/s", de: "Tok/s" })}` : "";
  return `${tokens} ${pick(language, { ru: "ток.", en: "tokens", de: "Tokens" })}${rate}`;
}

/** The progress feed of a turn: live while it runs (with timers), folded under the answer once it is done. */
export default function TurnSteps({ steps, language, collapsed = false, now }: { steps: TurnStep[]; language: Language; collapsed?: boolean; now?: number }) {
  const list = <ol className="turn-steps">
    {steps.map((step) => {
      const time = step.durationMs !== undefined ? formatDuration(step.durationMs, language)
        : step.state === "running" && step.startedAt && now ? formatDuration(now - step.startedAt, language) : null;
      const progress = progressText(step, language);
      return <li key={step.id} className={`turn-step turn-step-${step.state}`}>
        <span className="turn-step-icon" aria-hidden="true">{step.state === "done" ? <Check size={11} /> : step.state === "failed" ? <X size={11} /> : <LoaderCircle size={11} />}</span>
        <span className="turn-step-copy">
          <span className="turn-step-label">{step.label}</span>
          {(step.detail || progress) && <span className="turn-step-detail">{[step.detail, progress].filter(Boolean).join(" · ")}</span>}
        </span>
        {time && <span className="turn-step-time">{time}</span>}
      </li>;
    })}
  </ol>;
  if (!collapsed) return list;
  return <details className="turn-steps-summary">
    <summary><ChevronDown size={12} aria-hidden="true" />{translate(language, "Ход выполнения", "How this was answered")} · {steps.length}</summary>
    {list}
  </details>;
}
