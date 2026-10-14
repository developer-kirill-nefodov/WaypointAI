import type { PlaceView } from "@waypoint-ai/shared";

type Language = "en" | "ru" | "de";
type PlaceSearch = { kind: string | null; city: string | null; query: string | null; category: string | null };

const KIND_LABELS: Record<string, [ru: string, en: string, de: string]> = {
  attraction: ["достопримечательности", "attractions", "Sehenswürdigkeiten"],
  museum: ["музеи", "museums", "Museen"],
  gallery: ["галереи", "galleries", "Galerien"],
  viewpoint: ["смотровые площадки", "viewpoints", "Aussichtspunkte"],
  monument: ["памятники", "monuments", "Denkmäler"],
  castle: ["замки", "castles", "Burgen und Schlösser"],
  church: ["храмы", "churches", "Kirchen"],
  theatre: ["театры", "theatres", "Theater"],
  park: ["парки", "parks", "Parks"],
  restaurant: ["рестораны", "restaurants", "Restaurants"],
  cafe: ["кафе", "cafés", "Cafés"],
  bar: ["бары", "bars", "Bars"],
  hotel: ["отели", "hotels", "Hotels"],
  any: ["места", "places", "Orte"],
};
const SIGHTS: [string, string, string] = ["достопримечательности и музеи", "attractions and museums", "Sehenswürdigkeiten und Museen"];

/**
 * The reply to a place search, built from the request and the returned rows only. The model chose the search; it
 * does not retell the results, so it cannot add places that the database did not return.
 */
export function formatPlaceResultsMessage(search: PlaceSearch, places: PlaceView[], total: number, language: Language): string {
  const pick = ([ru, en, de]: [string, string, string]) => (language === "ru" ? ru : language === "de" ? de : en);
  const what = search.category ?? (search.kind ? pick(KIND_LABELS[search.kind] ?? KIND_LABELS.any!) : search.city && !search.query ? pick(SIGHTS) : pick(KIND_LABELS.any!));
  const scope = [what, search.query ? `«${search.query}»` : null, search.city].filter(Boolean).join(", ");
  if (!places.length) {
    return language === "ru" ? `В локальном снимке OpenStreetMap ничего не нашлось (${scope}). Это не значит, что таких мест нет: выгрузка может быть неполной.`
      : language === "de" ? `Im lokalen OpenStreetMap-Datenstand wurde nichts gefunden (${scope}). Das heißt nicht, dass es solche Orte nicht gibt; der Auszug kann unvollständig sein.`
        : `Nothing was found in the local OpenStreetMap snapshot (${scope}). That does not mean such places do not exist; the extract may be incomplete.`;
  }
  const header = language === "ru" ? `Нашёл в локальном снимке OpenStreetMap (${scope}): ${places.length}${total > places.length ? ` из ${total}` : ""}. Это найденные объекты, не рейтинг рекомендаций; они отмечены на карте.`
    : language === "de" ? `Im lokalen OpenStreetMap-Datenstand gefunden (${scope}): ${places.length}${total > places.length ? ` von ${total}` : ""}. Das sind Suchtreffer, keine Empfehlungen; sie sind auf der Karte markiert.`
      : `Found in the local OpenStreetMap snapshot (${scope}): ${places.length}${total > places.length ? ` of ${total}` : ""}. These are matches, not ranked recommendations; they are marked on the map.`;
  const lines = places.map((place, index) => {
    const address = [place.street && [place.street, place.houseNumber].filter(Boolean).join(" "), place.postcode, place.city].filter(Boolean).join(", ");
    return `${index + 1}. ${place.name}${address ? ` — ${address}` : ""}`;
  });
  return [header, lines.join("\n")].join("\n\n");
}
