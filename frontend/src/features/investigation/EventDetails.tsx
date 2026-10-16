import type { EventDetailsResponse, SourceView } from "@waypoint-ai/shared";
import { Crosshair, ExternalLink, MapPin, MessageSquare } from "lucide-react";
import type { RefObject } from "react";
import { makeT, type Language } from "../../shared/i18n";
import {
  formatDistance,
  formatKm,
  formatUtc,
  numberAttribute,
  safeSourceEventUrl,
  sourceDescription,
  textAttribute,
} from "./format";
import type { MapFocusTarget } from "./types";
import Warning from "./Warning";
import { CrossCheckSection } from "./CrossCheck";

const RADIUS_OPTIONS = [10, 25, 50, 100];

type EventDetailsProps = {
  language: Language;
  details: EventDetailsResponse;
  onSearchNearby: (radiusKm: number) => void;
  onShowOnMap: (target: MapFocusTarget) => void;
  /** Hands the event to the assistant as the selected map point. */
  onAsk?: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
};

export default function EventDetails({
  language,
  details,
  onSearchNearby,
  onShowOnMap,
  onAsk,
  headingRef,
}: EventDetailsProps) {
  const t = makeT(language);
  const { event, linkedPlaces, sources } = details;
  const source = sources.find((item) => item.id === event.sourceId);
  const magnitude = numberAttribute(event, "magnitude");
  const magnitudeText = magnitude === null
    ? "—"
    : `${magnitude.toFixed(1)} ${textAttribute(event, "magnitudeType") ?? ""}`;
  const depthKm = numberAttribute(event, "depthKm");
  const category = textAttribute(event, "category") ?? t("категория не указана", "no category");
  const showEvent = () => onShowOnMap({ kind: "record", id: event.id, lat: event.lat, lon: event.lon });

  return (
    <section className="investigation-details" aria-label={t("Детали события", "Event details")}>
      <span className="eyebrow">{t("СОБЫТИЕ", "EVENT")} · {category}</span>
      <h3 ref={headingRef} tabIndex={-1}>{textAttribute(event, "placeDescription") ?? event.label}</h3>
      {!source && (
        <Warning>
          {t(
            "Метаданные источника не найдены: происхождение события не подтверждено.",
            "Source metadata not found: the event's origin is unverified.",
          )}
        </Warning>
      )}
      {source?.mode === "synthetic_local" && (
        <Warning>
          {t(
            "Синтетическое событие для офлайн-демо. Это не наблюдение.",
            "Synthetic event for the offline demo. This is not an observation.",
          )}
        </Warning>
      )}
      <dl>
        <div><dt>{t("Время", "Time")}</dt><dd>{formatUtc(event.observedAt)}</dd></div>
        <div><dt>{t("Магнитуда", "Magnitude")}</dt><dd>{magnitudeText}</dd></div>
        <div><dt>{t("Глубина", "Depth")}</dt><dd>{depthKm === null ? "—" : formatKm(depthKm, language)}</dd></div>
        <div><dt>{t("Координаты", "Coordinates")}</dt><dd>{event.lat.toFixed(4)}, {event.lon.toFixed(4)}</dd></div>
        <div className="wide">
          <dt>{t("Источник", "Source")}</dt>
          <dd><SourceProvenance language={language} details={details} source={source} /></dd>
        </div>
      </dl>

      <div className="investigation-actions">
        <button type="button" className="investigation-show-on-map" onClick={showEvent}>
          <MapPin size={13} />{t("Показать на карте", "Show on the map")}
        </button>
        {onAsk && (
          <button type="button" className="investigation-show-on-map ask" onClick={onAsk}>
            <MessageSquare size={13} />{t("Спросить ассистента", "Ask the assistant")}
          </button>
        )}
      </div>

      {details.crossCheck && <CrossCheckSection language={language} details={details} onShowOnMap={onShowOnMap} />}

      <div className="investigation-pivot">
        <Crosshair size={13} />
        <span>{t("События в радиусе", "Events within")}</span>
        {RADIUS_OPTIONS.map((radius) => (
          <button key={radius} type="button" onClick={() => onSearchNearby(radius)}>
            {formatKm(radius, language)}
          </button>
        ))}
      </div>

      <h4>{t("Места рядом (OpenStreetMap)", "Nearby places (OpenStreetMap)")}</h4>
      <p className="investigation-note">
        {t(
          "Связи вычислены при импорте: до 5 ближайших мест в радиусе 5 км, расстояние по прямой.",
          "Links are computed at import: up to 5 nearest places within 5 km, straight-line distance.",
        )}
      </p>
      {linkedPlaces.length ? (
        <ul className="investigation-linked">
          {linkedPlaces.map(({ place, distanceMeters }) => (
            <li key={place.id}>
              <button
                type="button"
                title={t("Показать на карте", "Show on the map")}
                onClick={() => onShowOnMap({ kind: "place", id: place.id, lat: place.lat, lon: place.lon })}
              >
                <span>
                  <strong>{place.name}</strong>
                  <small>{[place.category, place.city].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="investigation-linked-distance">
                  {formatDistance(distanceMeters, language)}<MapPin size={12} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="investigation-empty">
          {t("В импортированных OSM-регионах рядом нет мест.", "No places nearby in the imported OSM regions.")}
        </p>
      )}
    </section>
  );
}

type SourceProvenanceProps = {
  language: Language;
  details: EventDetailsResponse;
  source: SourceView | undefined;
};

/** Where the event came from: source, license, attribution, when the data was updated, and the source's own page. Import runs and failures are on the data page. */
function SourceProvenance({ language, details, source }: SourceProvenanceProps) {
  const t = makeT(language);
  const { event, lastSync } = details;
  const sourceUrl = safeSourceEventUrl(event);
  const lastSucceeded = lastSync?.lastSucceededAt
    ? formatUtc(lastSync.lastSucceededAt)
    : t("нет успешных", "none succeeded");

  return (
    <>
      {source ? <>{source.label} · {sourceDescription(source, language)}</> : event.sourceId}
      {source?.attribution && <small>{source.attribution}</small>}
      {lastSync && (
        <small>{t("Данные обновлены", "Data updated")}: {lastSucceeded}</small>
      )}
      {sourceUrl && (
        <a href={sourceUrl} target="_blank" rel="noreferrer noopener">
          {t("Страница события у источника", "Event page at the source")} <ExternalLink size={11} />
        </a>
      )}
    </>
  );
}
