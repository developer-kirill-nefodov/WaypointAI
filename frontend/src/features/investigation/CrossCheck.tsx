import type { CrossCheckMatch, CrossCheckSummary, EventDetailsResponse, InvestigationEvent, SourceView } from "@waypoint-ai/shared";
import { AlertTriangle, CheckCircle2, ExternalLink, MapPin } from "lucide-react";
import { makeT, type Language } from "../../shared/i18n";
import { formatDistance, formatKm, formatUtc, numberAttribute, pick, safeSourceEventUrl, sourceShortName, textAttribute } from "./format";
import type { MapFocusTarget } from "./types";

/** Compact mark in the event list: confirmed by another catalogue, or the catalogues disagree. */
export function CrossCheckBadge({ language, crossCheck }: { language: Language; crossCheck?: CrossCheckSummary }) {
  if (!crossCheck || (crossCheck.status !== "confirmed" && crossCheck.status !== "conflict")) return null;
  const others = crossCheck.matchedSourceIds.map((id) => sourceShortName(id)).join(", ");
  if (crossCheck.status === "confirmed") {
    return <span className="cross-check-badge confirmed" title={pick(language, { ru: `Подтверждено каталогом ${others}`, en: `Confirmed by ${others}`, de: `Bestätigt durch ${others}` })}><CheckCircle2 size={11} />{others}</span>;
  }
  return <span className="cross-check-badge conflict" title={pick(language, { ru: `${others} даёт другую магнитуду или глубину`, en: `${others} gives a different magnitude or depth`, de: `${others} nennt eine andere Magnitude oder Tiefe` })}><AlertTriangle size={11} />{others}</span>;
}

type CrossCheckSectionProps = {
  language: Language;
  details: EventDetailsResponse;
  onShowOnMap: (target: MapFocusTarget) => void;
};

/**
 * The event next to its copies in other catalogues: time, place, magnitude, depth, and how far apart they are.
 * Explains a missing copy instead of hiding it, since an absent USGS event is normal for small earthquakes.
 */
export function CrossCheckSection({ language, details, onShowOnMap }: CrossCheckSectionProps) {
  const t = makeT(language);
  const { event, crossCheck, sources } = details;
  const sourceOf = (id: string) => sources.find((source) => source.id === id);
  const status = crossCheck.status;
  const checked = crossCheck.checkedSourceIds.map((id) => sourceShortName(id, sourceOf(id))).join(", ");
  const summary = status === "confirmed"
    ? t("Событие есть и в другом каталоге, описания согласуются.", "Another catalogue reports this event, and the descriptions agree.")
    : status === "conflict"
      ? t("Событие есть в другом каталоге, но магнитуда или глубина заметно отличаются.", "Another catalogue reports this event, but the magnitude or depth differ noticeably.")
      : status === "single"
        ? pick(language, {
          ru: `${checked} загружен за это время, но события не содержит.${weak(event) ? " Для слабых толчков (до M2.5) это обычно: USGS их почти не фиксирует." : ""}`,
          en: `${checked} was imported for this time but does not list this event.${weak(event) ? " That is usual for small events (below M2.5): USGS rarely lists them." : ""}`,
          de: `${checked} wurde für diesen Zeitraum importiert, enthält das Ereignis aber nicht.${weak(event) ? " Bei schwachen Beben (unter M2.5) ist das üblich: USGS erfasst sie selten." : ""}`,
        })
        : sourceOf(event.sourceId)?.mode === "synthetic_local"
          ? t("Синтетические события не сверяются с каталогами.", "Synthetic events are not compared with catalogues.")
          : t("Не с чем сравнить: другой каталог за это время не загружен. Импортируйте USGS за тот же период.", "Nothing to compare with: no other catalogue was imported for this time. Import USGS for the same period.");

  return (
    <section className={`cross-check ${status}`} aria-label={t("Перекрёстная проверка", "Cross-check")}>
      <h4>{status === "confirmed" ? <CheckCircle2 size={13} /> : status === "conflict" ? <AlertTriangle size={13} /> : null}{t("Перекрёстная проверка", "Cross-check")}</h4>
      <p className="investigation-note">{summary}</p>
      {crossCheck.matches.length > 0 && (
        <div className="cross-check-table-wrap">
          <table className="cross-check-table">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">{sourceShortName(event.sourceId, sourceOf(event.sourceId))}</th>
                {crossCheck.matches.map((match) => <th scope="col" key={match.event.id}>{sourceShortName(match.event.sourceId, sourceOf(match.event.sourceId))}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t("Время", "Time")}</th>
                <td>{formatUtc(event.observedAt).slice(11)}</td>
                {crossCheck.matches.map((match) => <td key={match.event.id}>{formatUtc(match.event.observedAt).slice(11)}<Delta>{`Δ ${(match.timeDeltaMs / 1000).toLocaleString(language, { maximumFractionDigits: 1 })} ${language === "ru" ? "с" : "s"}`}</Delta></td>)}
              </tr>
              <tr>
                <th scope="row">{t("Магнитуда", "Magnitude")}</th>
                <td>{magnitudeText(event)}</td>
                {crossCheck.matches.map((match) => <td key={match.event.id} className={match.magnitudeDelta !== null && match.magnitudeDelta > 0.5 ? "differs" : undefined}>{magnitudeText(match.event)}{match.magnitudeDelta !== null && <Delta>{`Δ ${match.magnitudeDelta.toFixed(1)}`}</Delta>}</td>)}
              </tr>
              <tr>
                <th scope="row">{t("Глубина", "Depth")}</th>
                <td>{depthText(event, language)}</td>
                {crossCheck.matches.map((match) => <td key={match.event.id} className={match.consistent || match.depthDeltaKm === null || (match.magnitudeDelta ?? 0) > 0.5 ? undefined : "differs"}>{depthText(match.event, language)}{match.depthDeltaKm !== null && <Delta>{`Δ ${formatKm(match.depthDeltaKm.toFixed(1), language)}`}</Delta>}</td>)}
              </tr>
              <tr>
                <th scope="row">{t("Эпицентр", "Epicentre")}</th>
                <td>{event.lat.toFixed(3)}, {event.lon.toFixed(3)}</td>
                {crossCheck.matches.map((match) => <td key={match.event.id}>{match.event.lat.toFixed(3)}, {match.event.lon.toFixed(3)}<Delta>{`↔ ${formatDistance(match.distanceMeters, language)}`}</Delta></td>)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {crossCheck.matches.map((match) => <MatchLinks key={match.event.id} language={language} match={match} source={sourceOf(match.event.sourceId)} onShowOnMap={onShowOnMap} />)}
      <p className="investigation-note">
        {t(
          "Совпадением считается событие другого каталога в пределах 30 с и 50 км. Агентства считают магнитуду разными методами (ML, mb, Mw), поэтому небольшая разница нормальна. Сравнение вычислено WaypointAI при импорте.",
          "A match is another catalogue's event within 30 s and 50 km. Agencies compute magnitude by different methods (ML, mb, Mw), so a small difference is normal. Computed by WaypointAI at import.",
        )}
      </p>
    </section>
  );
}

function MatchLinks({ language, match, source, onShowOnMap }: { language: Language; match: CrossCheckMatch; source?: SourceView; onShowOnMap: (target: MapFocusTarget) => void }) {
  const url = safeSourceEventUrl(match.event);
  const name = sourceShortName(match.event.sourceId, source);
  return (
    <div className="cross-check-links">
      <button type="button" onClick={() => onShowOnMap({ kind: "record", id: match.event.id, lat: match.event.lat, lon: match.event.lon })}>
        <MapPin size={12} />{pick(language, { ru: `Точка ${name} на карте`, en: `${name} location on the map`, de: `${name}-Position auf der Karte` })}
      </button>
      {url && <a href={url} target="_blank" rel="noreferrer noopener">{pick(language, { ru: `Страница в ${name}`, en: `Page at ${name}`, de: `Seite bei ${name}` })} <ExternalLink size={11} /></a>}
      {source?.attribution && <small>{source.attribution}</small>}
    </div>
  );
}

function Delta({ children }: { children: string }) {
  return <small className="cross-check-delta">{children}</small>;
}

function magnitudeText(event: InvestigationEvent): string {
  const magnitude = numberAttribute(event, "magnitude");
  return magnitude === null ? "—" : `${magnitude.toFixed(1)} ${textAttribute(event, "magnitudeType") ?? ""}`.trim();
}

function depthText(event: InvestigationEvent, language: Language): string {
  const depth = numberAttribute(event, "depthKm");
  return depth === null ? "—" : formatKm(depth.toFixed(1), language);
}

function weak(event: InvestigationEvent): boolean {
  const magnitude = numberAttribute(event, "magnitude");
  return magnitude !== null && magnitude < 2.5;
}
