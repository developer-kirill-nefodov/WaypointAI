import { Op } from "sequelize";
import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Place } from "../models/place.js";
import { RecordModel } from "../models/record.js";
import { Source } from "../models/source.js";

initModels();

export interface SearchInput {
  query?: string;
  category?: string;
  sourceIds?: string[];
  from?: string;
  to?: string;
  limit?: number;
}

export async function searchRecords(input: SearchInput) {
  await database.authenticate();
  const where: Record<string | symbol, unknown> = {};
  if (input.category) where.category = input.category;
  if (input.sourceIds?.length) where.sourceId = { [Op.in]: input.sourceIds };
  if (input.from || input.to) {
    const observedAt: Record<symbol, Date> = {};
    if (input.from) observedAt[Op.gte] = new Date(input.from);
    if (input.to) observedAt[Op.lte] = new Date(input.to);
    where.observedAt = observedAt;
  }
  if (input.query) {
    const term = input.query.trim().slice(0, 100);
    where[Op.or] = [
      { category: { [Op.iLike]: `%${escapeLike(term)}%` } },
      database.where(database.cast(database.col("attributes"), "text"), { [Op.iLike]: `%${escapeLike(term)}%` }),
    ];
  }
  const { rows, count } = await RecordModel.findAndCountAll({
    where, limit: Math.min(Math.max(input.limit ?? 30, 1), 50), order: [["observedAt", "DESC"]],
    attributes: ["id", "sourceId", "observedAt", "lat", "lon", "accuracyMeters", "category", "attributes"],
    include: [{ model: Place, as: "place", attributes: ["id", "name", "category", "city", "street", "houseNumber", "postcode"], required: false }],
  });
  return { total: count, records: rows.map(toView) };
}

export async function getRecordDetails(id: string) {
  await database.authenticate();
  const row = await RecordModel.findByPk(id, { attributes: ["id", "sourceId", "observedAt", "lat", "lon", "accuracyMeters", "category", "attributes"], include: [{ model: Place, as: "place", attributes: ["id", "name", "category", "city", "street", "houseNumber", "postcode"], required: false }] });
  return row ? toView(row) : null;
}

export async function getPlaceDetails(id: string) {
  await database.authenticate();
  const row = await Place.findByPk(id, { attributes: ["id", "sourceId", "osmType", "osmId", "name", "category", "countryCode", "region", "city", "postcode", "street", "houseNumber", "lat", "lon", "tags"] });
  return row ? toPlaceView(row) : null;
}

export interface SearchPlacesInput {
  query?: string;
  category?: string;
  countryCode?: string;
  sourceIds?: string[];
  city?: string;
  preferCity?: boolean;
  airportCode?: string;
  limit?: number;
  bbox?: [number, number, number, number];
}

export async function searchPlaces(input: SearchPlacesInput) {
  await database.authenticate();
  const where: Record<string | symbol, unknown> = {};
  if (input.sourceIds?.length) where.sourceId = { [Op.in]: input.sourceIds };
  if (input.countryCode) where.countryCode = input.countryCode.toUpperCase();
  if (input.category) where.category = { [Op.iLike]: `%${escapeLike(input.category)}%` };
  if (input.city) where.city = { [Op.iLike]: `%${escapeLike(input.city)}%` };
  if (input.airportCode) {
    const airportCode = input.airportCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{3}$/.test(airportCode)) throw new Error("Invalid airport code");
    where.tags = { [Op.contains]: { iata: airportCode } };
  }
  if (input.bbox) {
    const [minLon, minLat, maxLon, maxLat] = input.bbox;
    where.lat = { [Op.between]: [minLat, maxLat] };
    where.lon = { [Op.between]: [minLon, maxLon] };
  }
  if (input.query) {
    const term = `%${escapeLike(input.query.trim().slice(0, 100))}%`;
    where[Op.or] = ["name", "street", "city", "postcode"].map((field) => ({ [field]: { [Op.iLike]: term } }));
  }
  const { rows, count } = await Place.findAndCountAll({
    where, limit: Math.min(Math.max(input.limit ?? 20, 1), 500),
    order: input.preferCity ? [[database.col("city"), "ASC"], ["name", "ASC"]] : [["name", "ASC"]],
    attributes: ["id", "sourceId", "osmType", "osmId", "name", "category", "countryCode", "region", "city", "postcode", "street", "houseNumber", "lat", "lon", "tags"],
  });
  return { total: count, places: rows.map(toPlaceView) };
}

export async function searchNearbyPlaces(input: Omit<SearchPlacesInput, "bbox" | "airportCode" | "limit"> & {
  center: { lat: number; lon: number };
  radiusMeters: number;
  limit?: number;
}) {
  const { center, radiusMeters } = input;
  if (!Number.isFinite(center.lat) || center.lat < -90 || center.lat > 90 || !Number.isFinite(center.lon) || center.lon < -180 || center.lon > 180) {
    throw new Error("Invalid search center");
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters < 100 || radiusMeters > 20_000) throw new Error("Invalid search radius");
  const latitudeDelta = radiusMeters / 111_320;
  const longitudeDelta = radiusMeters / (111_320 * Math.max(0.01, Math.cos(center.lat * Math.PI / 180)));
  const bounds: [number, number, number, number] = [
    Math.max(-180, center.lon - longitudeDelta), Math.max(-90, center.lat - latitudeDelta),
    Math.min(180, center.lon + longitudeDelta), Math.min(90, center.lat + latitudeDelta),
  ];
  const result = await searchPlaces({ ...input, bbox: bounds, limit: 500 });
  const withinRadius = result.places
    .map((place) => ({ place, distanceMeters: haversineDistanceMeters(center, place) }))
    .filter((item) => item.distanceMeters <= radiusMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters || left.place.name.localeCompare(right.place.name) || left.place.id.localeCompare(right.place.id));
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  return {
    total: withinRadius.length,
    partial: result.total > result.places.length,
    places: withinRadius.slice(0, limit).map(({ place }) => place),
    distancesMeters: Object.fromEntries(withinRadius.slice(0, limit).map(({ place, distanceMeters }) => [place.id, Math.round(distanceMeters)])),
  };
}

export function haversineDistanceMeters(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const radians = Math.PI / 180;
  const latitudeDelta = (to.lat - from.lat) * radians;
  const longitudeDelta = (to.lon - from.lon) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(from.lat * radians) * Math.cos(to.lat * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

export async function getSources(ids: string[]) {
  const rows = await Source.findAll({
    where: ids.length ? { id: { [Op.in]: ids } } : {},
    attributes: ["id", "label", "mode", "status", "attribution", "snapshotDate", "sourceUrl", "license"], order: [["label", "ASC"]], raw: true,
  });
  return rows;
}

function toView(row: RecordModel) {
  const value = row.get({ plain: true });
  const attrs = { ...(value.attributes as Record<string, unknown>) };
  attrs.category = value.category as string;
  const place = value.place as Record<string, unknown> | null;
  if (place) attrs.place = {
    id: place.id, name: place.name, category: place.category, city: place.city,
    street: place.street, houseNumber: place.houseNumber, postcode: place.postcode,
  };
  const label = typeof attrs.label === "string" ? attrs.label : value.category;
  return {
    id: value.id as string, sourceId: value.sourceId as string,
    observedAt: new Date(value.observedAt as Date).toISOString(), label,
    lat: Number(value.lat), lon: Number(value.lon),
    accuracyMeters: value.accuracyMeters === null ? null : Number(value.accuracyMeters), attributes: attrs,
  };
}

function toPlaceView(row: Place) {
  const value = row.get({ plain: true });
  return {
    id: value.id as string,
    sourceId: value.sourceId as string,
    name: value.name as string,
    category: value.category as string | null,
    countryCode: value.countryCode as string | null,
    city: value.city as string | null,
    street: value.street as string | null,
    houseNumber: value.houseNumber as string | null,
    postcode: value.postcode as string | null,
    details: extractPlaceDetails(value.tags as Record<string, unknown> | null),
    lat: Number(value.lat),
    lon: Number(value.lon),
  };
}

function extractPlaceDetails(tags: Record<string, unknown> | null | undefined): Record<string, string> {
  const fields = ["tourism", "historic", "aeroway", "iata", "icao", "cuisine", "opening_hours", "wheelchair", "website", "description", "fee", "internet_access", "wikidata"];
  const details: Record<string, string> = {};
  for (const key of fields) {
    const value = tags?.[key];
    if (typeof value === "string" && value.trim()) details[key] = value.trim().slice(0, 300);
  }
  return details;
}

function escapeLike(text: string) { return text.replace(/[\\%_]/g, "\\$&"); }
