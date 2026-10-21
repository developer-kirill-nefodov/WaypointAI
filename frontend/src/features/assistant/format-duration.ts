import type { Language } from "../../shared/i18n";

/** A duration to a tenth of a second: "3.4 с", "1 мин 14.2 с" (decimal comma in Russian and German). */
export function formatDuration(milliseconds: number, language: Language): string {
  const tenths = Math.max(0, Math.round(milliseconds / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  const decimal = language === "en" ? "." : ",";
  const secondsText = seconds.toFixed(1).replace(".", decimal);
  const [second, minute] = language === "ru" ? ["с", "мин"] : language === "de" ? ["s", "min"] : ["s", "min"];
  return minutes ? `${minutes} ${minute} ${secondsText} ${second}` : `${secondsText} ${second}`;
}

/** Wall-clock time of a message: 14:32. */
export function formatClock(at: number, language: Language): string {
  return new Date(at).toLocaleTimeString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-GB", { hour: "2-digit", minute: "2-digit" });
}
