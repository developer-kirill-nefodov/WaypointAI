import type { InvestigationEvent, SourceView } from "@waypoint-ai/shared";
import type { MouseEvent, ReactNode } from "react";
import { makeT, type Language } from "../../shared/i18n";
import { CrossCheckBadge } from "./CrossCheck";
import { formatDistance, formatEventTime, formatUtc, numberAttribute, textAttribute } from "./format";

type EventTableProps = {
  language: Language;
  events: InvestigationEvent[];
  sourcesById: Map<string, SourceView>;
  selectedId: string | null;
  showDistance: boolean;
  onSelect: (id: string) => void;
  /** Rendered after the rows inside the scroll area, for "Show more". */
  footer?: ReactNode;
};

export default function EventTable({
  language,
  events,
  sourcesById,
  selectedId,
  showDistance,
  onSelect,
  footer,
}: EventTableProps) {
  const t = makeT(language);
  return (
    <div className="investigation-table-wrap">
      <table className="investigation-table">
        <thead>
          <tr>
            <th scope="col">{t("Время", "Time")}</th>
            <th scope="col">M</th>
            <th scope="col">{t("Описание", "Description")}</th>
            {showDistance && <th scope="col">{t("Расст.", "Dist.")}</th>}
            <th scope="col">{t("Источник", "Source")}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <EventRow
              key={event.id}
              language={language}
              event={event}
              source={sourcesById.get(event.sourceId)}
              selected={event.id === selectedId}
              showDistance={showDistance}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
      {footer && <div className="investigation-table-footer">{footer}</div>}
    </div>
  );
}

type EventRowProps = {
  language: Language;
  event: InvestigationEvent;
  source: SourceView | undefined;
  selected: boolean;
  showDistance: boolean;
  onSelect: (id: string) => void;
};

function EventRow({ language, event, source, selected, showDistance, onSelect }: EventRowProps) {
  const t = makeT(language);
  const magnitude = numberAttribute(event, "magnitude");
  const distance = event.distanceMeters === undefined ? "—" : formatDistance(event.distanceMeters, language);
  // Missing source metadata is labelled, never shown as ordinary data.
  const flagged = !source || source.mode === "synthetic_local";
  const sourceTag = !source
    ? t("Не проверено", "Unverified")
    : source.mode === "synthetic_local" ? t("Синтетика", "Synthetic") : event.sourceId;
  const select = (clickEvent: MouseEvent) => {
    // The row handles clicks too; one selection per click.
    clickEvent.stopPropagation();
    onSelect(event.id);
  };

  return (
    <tr className={selected ? "selected" : undefined} onClick={() => onSelect(event.id)}>
      <td title={formatUtc(event.observedAt)}>{formatEventTime(event.observedAt, language)}</td>
      <td className="magnitude">{magnitude === null ? "—" : magnitude.toFixed(1)}</td>
      <td>
        <button type="button" aria-current={selected ? "true" : undefined} onClick={select}>
          {textAttribute(event, "placeDescription") ?? event.label}
        </button>
      </td>
      {showDistance && <td>{distance}</td>}
      <td>
        <span className={`investigation-source-tag${flagged ? " synthetic" : ""}`}>{sourceTag}</span>
        <CrossCheckBadge language={language} crossCheck={event.crossCheck} />
      </td>
    </tr>
  );
}
