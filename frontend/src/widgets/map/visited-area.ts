export type AreaPoint = { lat: number; lon: number };

const EARTH_RADIUS_METERS = 6_371_000;
const BUFFER_SAMPLES = 12;

/**
 * Outline around the places a trip visits in one city: the convex hull of the stops, each widened by a buffer.
 * It shows the visited area only; it is not an administrative boundary.
 */
export function visitedAreaOutline(points: AreaPoint[], bufferMeters = 600): [number, number][] {
  if (!points.length) return [];
  const samples = points.flatMap((point) => bufferAround(point, bufferMeters));
  return convexHull(samples).map((point) => [point.lat, point.lon]);
}

function bufferAround(point: AreaPoint, meters: number): AreaPoint[] {
  const latDelta = (meters / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const lonDelta = latDelta / Math.max(0.01, Math.cos((point.lat * Math.PI) / 180));
  return Array.from({ length: BUFFER_SAMPLES }, (_, index) => {
    const angle = (2 * Math.PI * index) / BUFFER_SAMPLES;
    return { lat: point.lat + latDelta * Math.sin(angle), lon: point.lon + lonDelta * Math.cos(angle) };
  });
}

/** Andrew's monotone chain; returns the hull counter-clockwise without repeating the first point. */
function convexHull(points: AreaPoint[]): AreaPoint[] {
  const sorted = [...points].sort((left, right) => left.lon - right.lon || left.lat - right.lat);
  if (sorted.length < 3) return sorted;
  const cross = (origin: AreaPoint, a: AreaPoint, b: AreaPoint) =>
    (a.lon - origin.lon) * (b.lat - origin.lat) - (a.lat - origin.lat) * (b.lon - origin.lon);
  const half = (input: AreaPoint[]) => {
    const hull: AreaPoint[] = [];
    for (const point of input) {
      while (hull.length >= 2 && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, point) <= 0) hull.pop();
      hull.push(point);
    }
    hull.pop();
    return hull;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}
