import { makeT, type Language } from "../../shared/i18n";
import { pick } from "./format";
import type { QueryErrorState } from "./types";

const REJECTED_PARAMETER_CODES = new Set([
  "invalid_time_window",
  "invalid_query",
  "invalid_radius_query",
  "invalid_area_filter",
  "invalid_magnitude_range",
  "invalid_cursor",
  "invalid_bbox",
  "invalid_id",
  "invalid_query_request",
]);

export function errorMessage(code: string, language: Language): string {
  const t = makeT(language);
  if (code === "network_error") {
    return t(
      "Сервер недоступен. Проверьте, что бэкенд запущен.",
      "The server is unreachable. Check that the backend is running.",
    );
  }
  if (code === "rate_limited") {
    return t("Слишком много запросов. Подождите минуту.", "Too many requests. Wait a minute and try again.");
  }
  if (REJECTED_PARAMETER_CODES.has(code)) {
    return t("Сервер отклонил параметры запроса.", "The server rejected the query parameters.");
  }
  if (code === "not_found") {
    return t(
      "Событие не найдено. Возможно, оно было удалено при обновлении данных.",
      "Event not found. It may have been removed by a data update.",
    );
  }
  return t("Не удалось загрузить данные.", "Could not load data.");
}

/**
 * @param placeCoverage labels of the OpenStreetMap snapshots, used to explain where places can be resolved.
 */
export function queryErrorMessage(error: QueryErrorState, language: Language, placeCoverage: string[]): string {
  const t = makeT(language);
  if (error.code === "place_not_found") return placeNotFoundMessage(error.place ?? "", language, placeCoverage);
  if (error.code === "selection_required") {
    return t("Сначала выберите событие в таблице или на карте.", "Select an event in the table or on the map first.");
  }
  if (error.code === "query_not_understood") {
    const message = t(
      "Не удалось понять запрос. Укажите место, радиус, период или магнитуду.",
      "Could not interpret the request. Mention a place, radius, period, or magnitude.",
    );
    return error.fallbackReason ? `${message} (${error.fallbackReason})` : message;
  }
  return errorMessage(error.code, language);
}

function placeNotFoundMessage(place: string, language: Language, placeCoverage: string[]): string {
  const notFound = pick(language, {
    ru: `Населённый пункт «${place}» не найден в импортированных данных OSM.`,
    en: `The settlement "${place}" was not found in the imported OSM data.`,
    de: `Der Ort „${place}“ wurde in den importierten OSM-Daten nicht gefunden.`,
  });
  // Events can exist outside the imported OSM regions; say why the place could not be used.
  const coverage = placeCoverage.length
    ? ` ${coveragePrefix(language)} ${placeCoverage.map(regionName).join("; ")}.`
    : "";
  const hint = pick(language, {
    ru: " Без места можно искать по периоду и магнитуде.",
    en: " Without a place you can still search by period and magnitude.",
    de: " Ohne Ort können Sie weiterhin nach Zeitraum und Magnitude suchen.",
  });
  return notFound + coverage + hint;
}

function coveragePrefix(language: Language): string {
  return pick(language, {
    ru: "Места есть только в регионах:",
    en: "Places are available only for:",
    de: "Orte gibt es nur für:",
  });
}

/** "OpenStreetMap: Italy regional extract" -> "Italy". */
function regionName(sourceLabel: string): string {
  return sourceLabel
    .replace(/^OpenStreetMap:\s*/, "")
    .replace(/ regional extract$/, "");
}
