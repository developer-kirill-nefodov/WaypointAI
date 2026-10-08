export interface Coordinate { lat: number; lon: number }

export function polygonCenter(points: Coordinate[]): Coordinate | null {
  if (!points.length) return null;
  const vertices = points.length > 3 && points[0]!.lat === points.at(-1)!.lat && points[0]!.lon === points.at(-1)!.lon
    ? points.slice(0, -1)
    : points;
  let areaTwice = 0;
  let centerLonTimesArea = 0;
  let centerLatTimesArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index]!;
    const next = vertices[(index + 1) % vertices.length]!;
    const cross = current.lon * next.lat - next.lon * current.lat;
    areaTwice += cross;
    centerLonTimesArea += (current.lon + next.lon) * cross;
    centerLatTimesArea += (current.lat + next.lat) * cross;
  }
  if (Math.abs(areaTwice) > 1e-12) return { lon: centerLonTimesArea / (3 * areaTwice), lat: centerLatTimesArea / (3 * areaTwice) };
  return {
    lon: vertices.reduce((sum, point) => sum + point.lon, 0) / vertices.length,
    lat: vertices.reduce((sum, point) => sum + point.lat, 0) / vertices.length,
  };
}
