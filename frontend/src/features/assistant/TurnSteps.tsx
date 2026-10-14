import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import { translate, type Language } from "../../shared/i18n";
import type { TurnStep } from "./chat-storage";

/** The progress feed of a turn: live while it runs, folded under the answer once it is done. */
export default function TurnSteps({ steps, language, collapsed = false }: { steps: TurnStep[]; language: Language; collapsed?: boolean }) {
  const list = <ol className="turn-steps">
    {steps.map((step) => <li key={step.id} className={`turn-step turn-step-${step.state}`}>
      <span className="turn-step-icon" aria-hidden="true">{step.state === "done" ? <Check size={11} /> : step.state === "failed" ? <X size={11} /> : <LoaderCircle size={11} />}</span>
      <span className="turn-step-label">{step.label}</span>
      {step.detail && <span className="turn-step-detail">{step.detail}</span>}
    </li>)}
  </ol>;
  if (!collapsed) return list;
  return <details className="turn-steps-summary">
    <summary><ChevronDown size={12} aria-hidden="true" />{translate(language, "Ход выполнения", "How this was answered")} · {steps.length}</summary>
    {list}
  </details>;
}
