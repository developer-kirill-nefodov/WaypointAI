import type { Citation } from "@waypoint-ai/shared";
import { ArrowUpRight, MapPin } from "lucide-react";
import { makeT, type Language } from "../../shared/i18n";
import { formatEventTime } from "../investigation/format";

interface CitationListProps {
  citations: Citation[];
  mode?: "cited" | "shown_to_model";
  language: Language;
  sourceLabels: Record<string, string>;
  /** True when the cited row is among the results on the map. */
  isOnMap: (citation: Citation) => boolean;
  onShow: (citation: Citation) => void;
}

/** The rows an answer is based on, each with its source, date, and the source's own page. Collapsed by default. */
export default function CitationList({ citations, mode, language, sourceLabels, isOnMap, onShow }: CitationListProps) {
  const t = makeT(language);
  const shownOnly = mode === "shown_to_model";
  return (
    <details className="citation-list">
      <summary>
        {shownOnly ? t("Данные, показанные модели", "Data shown to the model") : t("Источники ответа", "Sources of this answer")}
        <span className="citation-count">{citations.length}</span>
      </summary>
      {shownOnly && <p className="citation-note">{t("Модель не указала, на какие записи опирается ответ; ниже всё, что она получила.", "The model did not cite the rows behind its answer; below is everything it was given.")}</p>}
      <ul>
        {citations.map((citation) => {
          const onMap = isOnMap(citation);
          return (
            <li key={citation.ref}>
              <span className="citation-ref">{citation.ref}</span>
              <span className="citation-copy">
                <strong>{citation.label}</strong>
                <small>{[sourceLabels[citation.sourceId] ?? citation.sourceId, citation.observedAt ? formatEventTime(citation.observedAt, language) : null].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="citation-actions">
                {onMap && <button type="button" onClick={() => onShow(citation)} title={t("Показать на карте", "Show on the map")} aria-label={t("Показать на карте", "Show on the map")}><MapPin size={13} /></button>}
                {citation.url && <a href={citation.url} target="_blank" rel="noopener noreferrer" title={t("Открыть в источнике", "Open at the source")} aria-label={t("Открыть в источнике", "Open at the source")}><ArrowUpRight size={13} /></a>}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
