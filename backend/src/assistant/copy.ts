import type { ToolName } from "@waypoint-ai/shared";

const germanText: Record<string, string> = {
  "Area filtering is not connected to the server data yet.": "Die Gebietsfilterung ist noch nicht mit den Serverdaten verbunden.",
  "The start date must be before the end date.": "Das Startdatum muss vor dem Enddatum liegen.",
  "The assistant is already handling another request. Please try again shortly.": "Der Assistent verarbeitet bereits eine andere Anfrage. Bitte versuchen Sie es gleich noch einmal.",
  "Choose a country for the new plan or name a city. The local data covers Germany, Poland, Romania, France, Italy, and Spain.": "Wählen Sie ein Land für den neuen Plan oder nennen Sie eine Stadt. Die lokalen Daten decken Deutschland, Polen, Rumänien, Frankreich, Italien und Spanien ab.",
  "The local model interrupted generation. Try again or split the request into smaller parts.": "Die lokale Modellgenerierung wurde unterbrochen. Versuchen Sie es erneut oder teilen Sie die Anfrage in kleinere Teile auf.",
  "Could not connect to the local model. Check that Ollama is running and the selected model is installed.": "Verbindung zum lokalen Modell fehlgeschlagen. Prüfen Sie, ob Ollama läuft und das ausgewählte Modell installiert ist.",
  "The server could not prepare a reply. Try again; if it happens again, share error code ": "Der Server konnte keine Antwort vorbereiten. Versuchen Sie es erneut. Falls der Fehler wieder auftritt, teilen Sie diesen Fehlercode mit: ",
  "Searching records": "Einträge werden gesucht", "Loading record": "Eintrag wird geladen", "Searching places": "Orte werden gesucht", "Listing sources": "Quellen werden aufgelistet", "Updating the trip plan": "Reiseplan wird geändert", "Routing the found places": "Route durch die gefundenen Orte", "Building a route through the found places": "Route durch die gefundenen Orte wird erstellt", "Planning the trip": "Reise wird geplant", "I could not process this request. Please try rephrasing it.": "Die Anfrage konnte nicht verarbeitet werden. Bitte formulieren Sie sie anders.", "Yes, use a driving route": "Ja, eine Autoroute", "No, places only": "Nein, nur Orte",
  "Trip planning stopped.": "Reiseplanung wurde angehalten.", "Searching cities and places in the local extract": "Städte und Orte werden im lokalen Datensatz gesucht", "Searching": "Suche läuft", "Building a plan from verified places": "Reiseplan wird aus bestätigten Orten erstellt", "Understanding your request": "Anfrage wird analysiert", "Searching the local database": "Lokale Datenbank wird durchsucht", "Writing the answer": "Antwort wird erstellt",
  "Response language: ": "Antwortsprache: ",
  "Searching events by place and radius": "Ereignisse nach Ort und Radius werden gesucht",
  "Local assistant is ready.": "Der lokale Assistent ist bereit.",
};
export function text(language: "en" | "ru" | "de", ru: string, en: string): string { return language === "ru" ? ru : language === "de" ? germanText[en] ?? en : en; }

export function toolLabel(tool: ToolName, language: "en" | "ru" | "de"): string {
  const labels = {
    search_records: text(language, "Поиск по записям", "Searching records"),
    search_events: text(language, "Поиск событий по месту и радиусу", "Searching events by place and radius"),
    get_record_details: text(language, "Загрузка записи", "Loading record"),
    search_places: text(language, "Поиск мест", "Searching places"),
    list_sources: text(language, "Список источников", "Listing sources"),
    plan_trip: text(language, "Составление плана поездки", "Planning the trip"),
    edit_trip_plan: text(language, "Изменение плана поездки", "Updating the trip plan"),
    route_places: text(language, "Маршрут по найденным местам", "Routing the found places"),
  };
  switch (tool) {
    case "search_records": return labels.search_records;
    case "get_record_details": return labels.get_record_details;
    case "search_places": return labels.search_places;
    case "list_sources": return labels.list_sources;
    case "search_events": return labels.search_events;
    case "plan_trip": return labels.plan_trip;
    case "edit_trip_plan": return labels.edit_trip_plan;
    case "route_places": return labels.route_places;
  }
}
