import { makeT, type Language } from "../../shared/i18n";

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
