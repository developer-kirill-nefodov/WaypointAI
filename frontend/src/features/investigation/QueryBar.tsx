import { Send } from "lucide-react";
import { useState, type FormEvent } from "react";
import { makeT, type Language } from "../../shared/i18n";
import ElapsedSeconds from "./ElapsedSeconds";

const INPUT_ID = "investigation-query-input";

type QueryBarProps = {
  language: Language;
  running: boolean;
  hasSelection: boolean;
  onSubmit: (text: string) => void;
};

export default function QueryBar({ language, running, hasSelection, onSubmit }: QueryBarProps) {
  const t = makeT(language);
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const examples = [
    t("События в радиусе 30 км от Norcia за 3 дня", "Events within 30 km of Norcia in the last 3 days"),
    t("Магнитуда больше 2 около Рима за неделю", "Magnitude above 2 near Rome this week"),
  ];
  if (hasSelection) {
    examples.push(t(
      "События в 5 км от этой точки за 24 часа",
      "Events within 5 km of this location in the last 24 hours",
    ));
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed && !running) onSubmit(trimmed);
  };

  return (
    <form className="investigation-query" onSubmit={submit}>
      <label htmlFor={INPUT_ID}>{t("Запрос на естественном языке", "Natural-language query")}</label>
      <div className="investigation-query-input">
        <input
          id={INPUT_ID}
          value={text}
          maxLength={300}
          readOnly={running}
          aria-busy={running}
          placeholder={t(
            "Например: землетрясения M2+ в 50 км от Norcia за неделю",
            "For example: M2+ earthquakes within 50 km of Norcia this week",
          )}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" disabled={running || !trimmed} aria-label={t("Выполнить запрос", "Run query")}>
          <Send size={14} />
        </button>
      </div>
      {running ? (
        <small role="status" className="investigation-timer">
          {t(
            "Локальная модель интерпретирует запрос (обычно 5–15 с)…",
            "The local model is interpreting the request (usually 5–15 s)…",
          )}
          {" "}
          <strong><ElapsedSeconds running language={language} /></strong>
        </small>
      ) : (
        <div className="investigation-query-examples">
          {examples.map((example) => (
            <button key={example} type="button" onClick={() => setText(example)}>{example}</button>
          ))}
        </div>
      )}
    </form>
  );
}
