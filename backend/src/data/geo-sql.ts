/** Mean Earth radius used by every haversine distance in the backend. */
export const EARTH_RADIUS_METERS = 6_371_000;
/** Length of one degree of latitude; also one degree of longitude at the equator. */
export const METERS_PER_DEGREE_LAT = 111_320;
// Near the poles cos(lat) approaches zero; the floor keeps the longitude delta finite.
const MIN_LATITUDE_COSINE = 0.01;
// A numeric literal, so a bound integer radius is not divided as an integer.
const METERS_PER_DEGREE_LAT_SQL = `${METERS_PER_DEGREE_LAT}.0`;

export interface Coordinates {
  lat: number;
  lon: number;
}

/** SQL expressions (columns or bind placeholders) for a point's latitude and longitude. */
export interface SqlPoint {
  lat: string;
  lon: string;
}

/** Half-size in degrees of a box that contains a circle of radiusMeters around latitude lat. */
export function degreeDeltas(lat: number, radiusMeters: number): Coordinates {
  return {
    lat: radiusMeters / METERS_PER_DEGREE_LAT,
    lon: radiusMeters / (METERS_PER_DEGREE_LAT * Math.max(MIN_LATITUDE_COSINE, Math.cos(lat * Math.PI / 180))),
  };
}

/** SQL counterpart of degreeDeltas for a latitude and radius given as SQL expressions. */
export function degreeDeltasSql(lat: string, radiusMeters: string): SqlPoint {
  return {
    lat: `${radiusMeters} / ${METERS_PER_DEGREE_LAT_SQL}`,
    lon: `${radiusMeters} / (${METERS_PER_DEGREE_LAT_SQL} * greatest(${MIN_LATITUDE_COSINE}, cos(radians(${lat}))))`,
  };
}

/** Great-circle distance in meters between two points given as SQL expressions. */
export function haversineSql(point: SqlPoint, center: SqlPoint): string {
  const latitudeTerm = `power(sin(radians(${point.lat} - ${center.lat}) / 2), 2)`;
  const longitudeTerm = `cos(radians(${center.lat})) * cos(radians(${point.lat}))`
    + ` * power(sin(radians(${point.lon} - ${center.lon}) / 2), 2)`;
  return `2 * ${EARTH_RADIUS_METERS} * asin(sqrt(${latitudeTerm} + ${longitudeTerm}))`;
}

/** JavaScript counterpart of haversineSql. */
export function haversineDistanceMeters(from: Coordinates, to: Coordinates): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (to.lat - from.lat) * radians;
  const longitudeDelta = (to.lon - from.lon) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(from.lat * radians) * Math.cos(to.lat * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}
