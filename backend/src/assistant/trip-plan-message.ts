import type { PlaceView, TripPlan } from "@waypoint-ai/shared";

export function formatTripPlanMessage(plan: TripPlan, places: PlaceView[], language: "en" | "ru" | "de"): string {
  const placeById = new Map(places.map((place) => [place.id, place]));
  const lines = language === "ru"
    ? [`План на ${plan.totalDays} ${plan.totalDays === 1 ? "день" : plan.totalDays < 5 ? "дня" : "дней"} по городу ${plan.city}, ${plan.countryCode}. Точки выбраны из локального снимка OpenStreetMap; это найденные объекты, не рейтинг рекомендаций.`]
    : language === "de" ? [`Ein ${plan.totalDays}-Tage-Plan für ${plan.city}, ${plan.countryCode}. Die Orte stammen aus dem lokalen OpenStreetMap-Datenstand und sind Suchtreffer, keine Empfehlungen.`]
      : [`A ${plan.totalDays}-day plan for ${plan.city}, ${plan.countryCode}. Stops come from the local OpenStreetMap snapshot; these are matched places, not ranked recommendations.`];

  for (const day of plan.days) {
    const dayTitle = language === "ru" ? `\n### День ${day.day} · ${day.area === "airport_radius" ? `район аэропорта ${plan.airport?.code ?? ""}` : plan.city}` : language === "de" ? `\n### Tag ${day.day} · ${day.area === "airport_radius" ? `Flughafengebiet ${plan.airport?.code ?? ""}` : plan.city}` : `\n### Day ${day.day} · ${day.area === "airport_radius" ? `airport area ${plan.airport?.code ?? ""}` : plan.city}`;
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
