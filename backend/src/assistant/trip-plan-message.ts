import type { PlaceView, TripPlan } from "@waypoint-ai/shared";
import type { TripPlanChange } from "./trip-plan-edit.js";

export function formatTripPlanMessage(plan: TripPlan, places: PlaceView[], language: "en" | "ru" | "de"): string {
  const placeById = new Map(places.map((place) => [place.id, place]));
  const multiCity = (plan.cities?.length ?? 0) > 1;
  const lines = language === "ru"
    ? [`План на ${plan.totalDays} ${plan.totalDays === 1 ? "день" : plan.totalDays < 5 ? "дня" : "дней"} ${multiCity ? "по городам" : "по городу"} ${plan.city}${multiCity ? "" : `, ${plan.countryCode}`}. Точки выбраны из локального снимка OpenStreetMap; это найденные объекты, не рейтинг рекомендаций.`]
    : language === "de" ? [`Ein ${plan.totalDays}-Tage-Plan für ${plan.city}${multiCity ? "" : `, ${plan.countryCode}`}. Die Orte stammen aus dem lokalen OpenStreetMap-Datenstand und sind Suchtreffer, keine Empfehlungen.`]
      : [`A ${plan.totalDays}-day plan ${multiCity ? "across" : "for"} ${plan.city}${multiCity ? "" : `, ${plan.countryCode}`}. Stops come from the local OpenStreetMap snapshot; these are matched places, not ranked recommendations.`];

  for (const day of plan.days) {
    const dayTitle = language === "ru" ? `\n### День ${day.day} · ${day.area === "airport_radius" ? `район аэропорта ${plan.airport?.code ?? ""}` : day.city ?? plan.city}` : language === "de" ? `\n### Tag ${day.day} · ${day.area === "airport_radius" ? `Flughafengebiet ${plan.airport?.code ?? ""}` : day.city ?? plan.city}` : `\n### Day ${day.day} · ${day.area === "airport_radius" ? `airport area ${plan.airport?.code ?? ""}` : day.city ?? plan.city}`;
    lines.push(dayTitle);
    if (day.area === "airport_radius" && plan.airport) {
      lines.push(language === "ru" ? `Начальная точка: ${plan.airport.name} (${plan.airport.code}).` : language === "de" ? `Startpunkt: ${plan.airport.name} (${plan.airport.code}).` : `Starting point: ${plan.airport.name} (${plan.airport.code}).`);
    }
    const dayPlaces = day.stopPlaceIds.map((id) => placeById.get(id)).filter((place): place is PlaceView => Boolean(place));
    if (!dayPlaces.length) {
      lines.push(language === "ru" ? "В локальном снимке нет найденных точек для этого дня." : language === "de" ? "Im lokalen Datenstand wurden für diesen Tag keine passenden Orte gefunden." : "No matching places were found in the local snapshot for this day.");
      continue;
    }
    dayPlaces.forEach((place, index) => {
      const address = [place.street && [place.street, place.houseNumber].filter(Boolean).join(" "), place.postcode, place.city].filter(Boolean).join(", ");
      const airportDistance = day.straightLineDistanceMetersFromAirport[place.id];
      const distanceLabel = airportDistance === undefined ? "" : language === "ru"
        ? ` · ${(airportDistance / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км по прямой от аэропорта`
        : language === "de" ? ` · ${(airportDistance / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km Luftlinie vom Flughafen`
          : ` · ${(airportDistance / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} km straight-line from the airport`;
      lines.push(`${index + 1}. ${place.name}${address ? ` — ${address}` : ""}${distanceLabel}`);
    });
    if (plan.travelMode === "driving" && day.routeStatus === "pending") {
      lines.push(language === "ru" ? "Дорожный маршрут для этого дня рассчитывается отдельно; статус показан в плане на карте." : language === "de" ? "Die Straßenroute für diesen Tag wird separat berechnet. Ihr Status wird im Reiseplan auf der Karte angezeigt." : "The road route for this day is calculated separately; its status is shown in the map plan.");
    } else if (plan.travelMode === "driving" && day.routeStatus === "unavailable") {
      lines.push(language === "ru" ? "Для этого дня недостаточно точек, чтобы запросить дорожный маршрут." : language === "de" ? "Für diesen Tag gibt es nicht genügend Orte, um eine Straßenroute anzufragen." : "There are not enough points to request a road route for this day.");
    }
  }

  if (plan.status === "partial") {
    lines.push(language === "ru"
      ? `В локальном снимке есть точки для ${plan.supportedDays} из ${plan.totalDays} дней либо поиск достиг ограничения выдачи.`
      : language === "de" ? `Der lokale Datenstand enthält passende Orte für ${plan.supportedDays} von ${plan.totalDays} Tagen oder die Suche hat ihr Ergebnislimit erreicht.`
        : `The local snapshot supports ${plan.supportedDays} of ${plan.totalDays} days, or the search reached its result limit.`);
  }
  return lines.join("\n\n");
}

/** What an edit changed, in plain words, followed by the whole updated plan. Built only from verified rows. */
export function formatTripPlanEditMessage(changes: TripPlanChange[], plan: TripPlan, places: PlaceView[], language: "en" | "ru" | "de"): string {
  const list = (names: string[]) => names.length ? names.join(", ") : language === "ru" ? "новых мест не найдено" : language === "de" ? "keine neuen Orte gefunden" : "no new places found";
  const lines = changes.map((change) => {
    switch (change.kind) {
      case "stops_added": return language === "ru" ? `Добавил в день ${change.day}: ${list(change.names)}.` : language === "de" ? `Zu Tag ${change.day} hinzugefügt: ${list(change.names)}.` : `Added to day ${change.day}: ${list(change.names)}.`;
      case "stops_removed": return language === "ru" ? `Убрал: ${change.names.join(", ")}.` : language === "de" ? `Entfernt: ${change.names.join(", ")}.` : `Removed: ${change.names.join(", ")}.`;
      case "stop_moved": return language === "ru" ? `Перенёс ${change.name} на день ${change.toDay}.` : language === "de" ? `${change.name} auf Tag ${change.toDay} verschoben.` : `Moved ${change.name} to day ${change.toDay}.`;
      case "day_added": return language === "ru" ? `Добавил день ${change.day}: ${list(change.names)}.` : language === "de" ? `Tag ${change.day} hinzugefügt: ${list(change.names)}.` : `Added day ${change.day}: ${list(change.names)}.`;
      case "day_removed": return language === "ru" ? `Убрал день ${change.day}${change.renumbered ? "; следующие дни сдвинуты" : ""}.` : language === "de" ? `Tag ${change.day} entfernt${change.renumbered ? "; die folgenden Tage wurden nachgerückt" : ""}.` : `Removed day ${change.day}${change.renumbered ? "; later days moved up" : ""}.`;
      case "days_set": return language === "ru" ? `Теперь в плане ${change.totalDays} ${dayWordRu(change.totalDays)}.` : language === "de" ? `Der Plan hat jetzt ${change.totalDays} ${change.totalDays === 1 ? "Tag" : "Tage"}.` : `The plan now has ${change.totalDays} ${change.totalDays === 1 ? "day" : "days"}.`;
      case "day_replaced": return language === "ru" ? `Новые точки для дня ${change.day}: ${list(change.names)}.` : language === "de" ? `Neue Haltepunkte für Tag ${change.day}: ${list(change.names)}.` : `New stops for day ${change.day}: ${list(change.names)}.`;
      case "route_mode": return change.mode === "none"
        ? language === "ru" ? "Маршрут отключён, показываю только точки." : language === "de" ? "Route ausgeschaltet; nur die Orte werden angezeigt." : "Route turned off; showing the places only."
        : language === "ru" ? "Включил автомобильный маршрут." : language === "de" ? "Autoroute eingeschaltet." : "Driving route turned on.";
    }
  });
  return [lines.join(" "), formatTripPlanMessage(plan, places, language)].join("\n\n");
}

function dayWordRu(count: number): string {
  return count === 1 ? "день" : count < 5 ? "дня" : "дней";
}
