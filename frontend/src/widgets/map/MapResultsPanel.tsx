import { ChevronUp, Layers3 } from "lucide-react";
import type { ReactNode } from "react";
import { translate, type Language } from "../../shared/i18n";

/**
 * The results of a query laid over the map in its top right corner: the trip plan with its days and stops, or the
 * found places and events with the route through them. It folds into a chip so the whole map stays visible.
 */
export default function MapResultsPanel({ language, title, count, open, onToggle, children }: {
  language: Language;
  title: string;
  /** A short count shown beside the title and on the folded chip ("2 days", "10"). */
  count?: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const t = (ru: string, en: string) => translate(language, ru, en);
  if (!open) {
    return <button type="button" className="map-results-chip" aria-expanded={false} aria-controls="map-results-panel" onClick={onToggle}>
      <Layers3 size={13} aria-hidden="true" />{title}{count && <span>{count}</span>}
    </button>;
  }
  return <section id="map-results-panel" className="map-results-panel" aria-label={title}>
    <header className="map-results-bar">
      <Layers3 size={13} aria-hidden="true" />
      <strong>{title}</strong>
      {count && <span className="map-results-count">{count}</span>}
      <button type="button" className="map-results-fold" aria-expanded onClick={onToggle} aria-label={t("Свернуть", "Fold")} title={t("Свернуть, чтобы видеть всю карту", "Fold to see the whole map")}><ChevronUp size={14} /></button>
    </header>
    <div className="map-results-body">{children}</div>
  </section>;
}
