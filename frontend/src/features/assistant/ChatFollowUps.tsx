import { ArrowUpRight, Check, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import type { ClarificationAnswer, ClarificationField, ClarificationFieldKey, SuggestedRequest } from "@waypoint-ai/shared";
import { makeT, type Language } from "../../shared/i18n";

/**
 * What follows an answer in the chat: the follow-up requests under the latest answer, and the one-time filters of a
 * clarification. The filters are answered once; their labels stay on the user's message.
 */

export function SuggestionChips({ items, loading, language, disabled, onChoose }: { items: SuggestedRequest[]; loading: boolean; language: Language; disabled: boolean; onChoose(prompt: string): void }) {
  const t = makeT(language);
  if (loading) {
    return <div className="follow-ups loading" role="status" aria-label={t("Подбираю подсказки", "Writing suggestions")}>
      {[0, 1, 2].map((index) => <span key={index} className="follow-up-skeleton" aria-hidden="true" />)}
    </div>;
  }
  if (!items.length) return null;
  return <div className="follow-ups" aria-label={t("Что спросить дальше", "What to ask next")}>
    {items.map((item) => <button key={item.prompt} type="button" className="follow-up" disabled={disabled} title={item.prompt} onClick={() => onChoose(item.prompt)}>
      <span>{item.label}</span><ArrowUpRight size={12} aria-hidden="true" />
    </button>)}
  </div>;
}

/** The option chosen before the user touches a field, so one click answers the usual case. */
const DEFAULTS: Partial<Record<ClarificationFieldKey, string>> = { period: "168", magnitude: "any", days: "3", travel: "driving" };

export function ClarificationForm({ fields, language, disabled, onSubmit }: {
  fields: ClarificationField[];
  language: Language;
  disabled: boolean;
  onSubmit(answers: ClarificationAnswer[], tags: string[], text: string): void;
}) {
  const t = makeT(language);
  const [chosen, setChosen] = useState<Partial<Record<ClarificationFieldKey, string[]>>>(() => Object.fromEntries(fields.flatMap((field) => {
    const preset = DEFAULTS[field.key];
    return preset && field.options.some((option) => option.id === preset) ? [[field.key, [preset]]] : [];
  })));
  const toggle = (field: ClarificationField, id: string) => setChosen((current) => {
    const values = current[field.key] ?? [];
    if (!field.multiple) return { ...current, [field.key]: [id] };
    return { ...current, [field.key]: values.includes(id) ? values.filter((value) => value !== id) : [...values, id] };
  });
  const submit = () => {
    const answers: ClarificationAnswer[] = [];
    const tags: string[] = [];
    for (const field of fields) {
      const values = chosen[field.key] ?? [];
      if (!values.length) continue;
      answers.push({ key: field.key, values });
      tags.push(`${field.label}: ${field.options.filter((option) => values.includes(option.id)).map((option) => option.label).join(", ")}`);
    }
    onSubmit(answers, tags, tags.join(" · ") || t("Как обычно", "As usual"));
  };
  return <div className="clarify-form" role="group" aria-label={t("Уточнение", "Clarification")}>
    {fields.map((field) => <div key={field.key} className="clarify-field">
      <span className="clarify-label">{field.label}{field.multiple && <small>{t("все, если не выбрано", "all if none chosen")}</small>}</span>
      <div className="clarify-options" role={field.multiple ? "group" : "radiogroup"} aria-label={field.label}>
        {field.options.map((option) => {
          const on = chosen[field.key]?.includes(option.id) ?? false;
          return <button key={option.id} type="button" role={field.multiple ? undefined : "radio"} aria-checked={field.multiple ? undefined : on} aria-pressed={field.multiple ? on : undefined} className={on ? "on" : ""} disabled={disabled} onClick={() => toggle(field, option.id)}>
            {on && <Check size={11} aria-hidden="true" />}{option.label}
          </button>;
        })}
      </div>
    </div>)}
    <button type="button" className="clarify-submit" disabled={disabled} onClick={submit}><SlidersHorizontal size={13} aria-hidden="true" />{t("Ответить", "Send the answer")}</button>
  </div>;
}
