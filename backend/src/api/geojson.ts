/** GeoJSON point collection for map layers; properties are chosen by the caller. */
export function toPointFeatureCollection<T extends { lat: number; lon: number }>(
  items: T[],
  properties: (item: T) => Record<string, unknown>,
) {
  return {
    type: "FeatureCollection",
    features: items.map((item) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [item.lon, item.lat] },
      properties: properties(item),
    })),
  };
}
