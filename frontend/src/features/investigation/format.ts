import type { InvestigationEvent, SourceView } from "@waypoint-ai/shared";
import { formatKm, makeT, type Language } from "../../shared/i18n";

export { formatKm };

/** For strings with numbers inside, which the English-keyed German dictionary cannot translate. */
export function pick(language: Language, text: { ru: string; en: string; de: string }): string {
  return text[language];
}

export function locale(language: Language): string {
  if (language === "ru") return "ru-RU";
  if (language === "de") return "de-DE";
  return "en-GB";
}

export function formatSeconds(milliseconds: number, language: Language): string {
  const seconds = (milliseconds / 1000).toLocaleString(locale(language), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return language === "ru" ? `${seconds} с` : `${seconds} s`;
}

/** Local time for scanning the table; the UTC value is shown in details and tooltips. */
export function formatEventTime(iso: string, language: Language): string {
  return new Date(iso).toLocaleString(locale(language), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatUtc(iso: string): string {
  return `${iso.slice(0, 19).replace("T", " ")} UTC`;
}

export function formatDistance(meters: number, language: Language): string {
  if (meters < 1000) return `${meters.toLocaleString(locale(language))} m`;
  const kilometers = (meters / 1000).toLocaleString(locale(language), { maximumFractionDigits: 1 });
  return formatKm(kilometers, language);
}

export function numberAttribute(event: InvestigationEvent, key: string): number | null {
  const value = event.attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function textAttribute(event: InvestigationEvent, key: string): string | null {
  const value = event.attributes[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Only links to the source's own event pages are rendered, never arbitrary URLs from data. */
export function safeSourceEventUrl(event: InvestigationEvent): string | null {
  const url = textAttribute(event, "sourceEventUrl");
  return url && SOURCE_EVENT_PAGE.test(url) ? url : null;
}

/** Event pages of the live catalogues: INGV by numeric ID, USGS by network and event code. */
const SOURCE_EVENT_PAGE = /^https:\/\/(?:terremoti\.ingv\.it\/en\/event\/\d+|earthquake\.usgs\.gov\/earthquakes\/eventpage\/[a-z0-9]{2,40})$/;

/** Short catalogue name for badges and comparison columns. */
export function sourceShortName(sourceId: string, source?: SourceView): string {
  if (sourceId === "ingv-fdsn") return "INGV";
  if (sourceId === "usgs-fdsn") return "USGS";
  return source?.label.split(" (")[0] ?? sourceId;
}

export function isEventSource(source: SourceView): boolean {
  // Place datasets imported from the app also have sync runs, so the mode alone decides.
  return source.mode === "approved_live" || source.mode === "synthetic_local";
}

export function sourceModeLabel(mode: SourceView["mode"], language: Language): string {
  const t = makeT(language);
  if (mode === "synthetic_local") return t("Синтетические данные", "Synthetic data");
  if (mode === "approved_live") return t("Публичный API", "Public API");
  if (mode === "public_snapshot") return t("Публичный снимок", "Public snapshot");
  return t("API клиента", "Client API");
}

/** "Mode · license", shown next to a source label in filters and details. */
export function sourceDescription(source: SourceView, language: Language): string {
  const license = source.license ? ` · ${source.license}` : "";
  return `${sourceModeLabel(source.mode, language)}${license}`;
}
