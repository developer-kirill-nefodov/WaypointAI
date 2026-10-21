import type { PlaceView, RecordView } from "@waypoint-ai/shared";
import { text } from "./copy.js";

type Language = "en" | "ru" | "de";

/** The fallback answer when the model's text cannot be shown. */
export const notProcessedText = (language: Language) => text(language, "Не получилось обработать запрос. Попробуйте сформулировать его иначе.", "I could not process this request. Please try rephrasing it.");

export const toolFailedDetail = (language: Language) => text(language, "не получилось, уточняю", "did not work, checking");

export function placeFeature(place: PlaceView) {
  return { type: "Feature", geometry: { type: "Point", coordinates: [place.lon, place.lat] }, properties: { entityType: "place", id: place.id, sourceId: place.sourceId, label: place.name, category: place.category } };
}

export function recordFeature(record: RecordView) {
  const place = record.attributes.place;
  return { type: "Feature", geometry: { type: "Point", coordinates: [record.lon, record.lat] }, properties: { entityType: "record", id: record.id, sourceId: record.sourceId, label: record.label, placeName: typeof place === "object" && place && "name" in place ? place.name : null, observedAt: record.observedAt, category: typeof record.attributes.category === "string" ? record.attributes.category : record.label } };
}

export function mapFeatures(records: RecordView[], places: PlaceView[]) {
  return { type: "FeatureCollection", features: [...records.map(recordFeature), ...places.map(placeFeature)] };
}

/** plan_trip asked how to travel between cities; only driving routes exist. */
export function routeModeQuestion(cities: string[], language: Language) {
  const list = cities.join(", ");
  const message = language === "ru" ? `Сейчас приложение умеет строить только автомобильный маршрут. Построить его по дням (${list})?`
    : language === "de" ? `Die App kann nur Autorouten berechnen. Soll ich für jeden Tag eine Autoroute hinzufügen (${list})?`
      : `The app can calculate driving routes only. Should I add a driving route for each day (${list})?`;
  return {
    message,
    choices: [
      { id: "route-driving", label: text(language, "Да, автомобильный маршрут", "Yes, use a driving route") },
      { id: "route-none", label: text(language, "Нет, только список мест", "No, places only") },
    ],
  };
}

/** The error frame's code and text for a failed turn. */
export function turnFailure(kind: "timeout" | "model_unavailable" | "internal_error", requestId: string, language: Language): string {
  if (kind === "timeout") return text(language, "Локальная модель прервала обработку. Попробуйте повторить запрос или разделить его на части.", "The local model interrupted generation. Try again or split the request into smaller parts.");
  if (kind === "model_unavailable") return text(language, "Не удалось подключиться к локальной модели. Проверьте, запущен ли Ollama и загружена ли выбранная модель.", "Could not connect to the local model. Check that Ollama is running and the selected model is installed.");
  return language === "de" ? `Der Server konnte keine Antwort vorbereiten. Versuchen Sie es erneut. Fehlercode: ${requestId}.` : text(language, `Сервер не смог подготовить ответ. Повторите запрос; если ошибка повторится, передайте разработчику код ${requestId}.`, `The server could not prepare a reply. Try again; if it happens again, share error code ${requestId} with the developer.`);
}
