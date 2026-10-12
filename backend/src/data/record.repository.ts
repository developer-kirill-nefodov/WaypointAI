import type { RecordView } from "@waypoint-ai/shared";
import { Op } from "sequelize";
import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Place } from "../models/place.js";
import { RecordModel } from "../models/record.js";
import { Source } from "../models/source.js";
import type { Bbox } from "../services/geometry.js";
import { degreeDeltas, haversineDistanceMeters } from "./geo-sql.js";

export { haversineDistanceMeters };

initModels();

/** Record columns every RecordView is built from. */
export const RECORD_VIEW_ATTRIBUTES = [
  "id",
  "sourceId",
  "observedAt",
  "lat",
  "lon",
  "accuracyMeters",
  "category",
  "attributes",
];
const RECORD_PLACE_ATTRIBUTES = ["id", "name", "category", "city", "street", "houseNumber", "postcode"];
const PLACE_VIEW_ATTRIBUTES = [
  "id",
  "sourceId",
  "osmType",
  "osmId",
  "name",
  "category",
  "countryCode",
  "region",
  "city",
  "postcode",
  "street",
  "houseNumber",
  "lat",
  "lon",
  "tags",
];

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
    where,
    limit: Math.min(Math.max(input.limit ?? 30, 1), 50),
    order: [["observedAt", "DESC"]],
    attributes: RECORD_VIEW_ATTRIBUTES,
    include: [{ model: Place, as: "place", attributes: RECORD_PLACE_ATTRIBUTES, required: false }],
  });
  return { total: count, records: rows.map(toView) };
}

export async function getRecordDetails(id: string) {
  await database.authenticate();
  const row = await RecordModel.findByPk(id, {
    attributes: RECORD_VIEW_ATTRIBUTES,
    include: [{ model: Place, as: "place", attributes: RECORD_PLACE_ATTRIBUTES, required: false }],
  });
  return row ? toView(row) : null;
}

export async function getPlaceDetails(id: string) {
  await database.authenticate();
  const row = await Place.findByPk(id, { attributes: PLACE_VIEW_ATTRIBUTES });
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
  bbox?: Bbox;
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
    where,
    limit: Math.min(Math.max(input.limit ?? 20, 1), 500),
    order: input.preferCity ? [[database.col("city"), "ASC"], ["name", "ASC"]] : [["name", "ASC"]],
    attributes: PLACE_VIEW_ATTRIBUTES,
  });
  return { total: count, places: rows.map(toPlaceView) };
}

export async function searchNearbyPlaces(input: Omit<SearchPlacesInput, "bbox" | "airportCode" | "limit"> & {
  center: { lat: number; lon: number };
  radiusMeters: number;
  limit?: number;
}) {
  const { center, radiusMeters } = input;
  const validCenter = Number.isFinite(center.lat)
    && center.lat >= -90
    && center.lat <= 90
    && Number.isFinite(center.lon)
    && center.lon >= -180
    && center.lon <= 180;
  if (!validCenter) throw new Error("Invalid search center");
  if (!Number.isFinite(radiusMeters) || radiusMeters < 100 || radiusMeters > 20_000) {
    throw new Error("Invalid search radius");
  }
  const delta = degreeDeltas(center.lat, radiusMeters);
  const bounds: Bbox = [
    Math.max(-180, center.lon - delta.lon),
    Math.max(-90, center.lat - delta.lat),
    Math.min(180, center.lon + delta.lon),
    Math.min(90, center.lat + delta.lat),
  ];
  const result = await searchPlaces({ ...input, bbox: bounds, limit: 500 });
  const withinRadius = result.places
    .map((place) => ({ place, distanceMeters: haversineDistanceMeters(center, place) }))
    .filter((item) => item.distanceMeters <= radiusMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters
      || left.place.name.localeCompare(right.place.name)
      || left.place.id.localeCompare(right.place.id));
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
  const nearest = withinRadius.slice(0, limit);
  return {
    total: withinRadius.length,
    partial: result.total > result.places.length,
    places: nearest.map(({ place }) => place),
    distancesMeters: Object.fromEntries(
      nearest.map(({ place, distanceMeters }) => [place.id, Math.round(distanceMeters)]),
    ),
  };
}

export async function getSources(ids: string[]) {
  const rows = await Source.findAll({
    where: ids.length ? { id: { [Op.in]: ids } } : {},
    attributes: ["id", "label", "mode", "status", "attribution", "snapshotDate", "sourceUrl", "license"],
    order: [["label", "ASC"]],
    raw: true,
  });
  return rows;
}

/** Record columns as read from a model or a raw query, before they become a RecordView. */
export interface RecordFields {
  id: string;
  sourceId: string;
  observedAt: Date | string;
  lat: number | string;
  lon: number | string;
  accuracyMeters: number | string | null;
  category: string;
  attributes: Record<string, unknown>;
}

/** Single RecordView mapping for model rows and raw SQL rows; category is copied into attributes. */
export function toRecordView(fields: RecordFields, place?: Record<string, unknown> | null): RecordView {
  const attributes: Record<string, unknown> = { ...fields.attributes, category: fields.category };
  if (place) {
    attributes.place = {
      id: place.id,
      name: place.name,
      category: place.category,
      city: place.city,
      street: place.street,
      houseNumber: place.houseNumber,
      postcode: place.postcode,
    };
  }
  return {
    id: fields.id,
    sourceId: fields.sourceId,
    observedAt: new Date(fields.observedAt).toISOString(),
    label: typeof attributes.label === "string" ? attributes.label : fields.category,
    lat: Number(fields.lat),
    lon: Number(fields.lon),
    accuracyMeters: fields.accuracyMeters === null ? null : Number(fields.accuracyMeters),
    attributes,
  };
}

export function toView(row: RecordModel): RecordView {
  const value = row.get({ plain: true });
  return toRecordView({
    id: value.id as string,
    sourceId: value.sourceId as string,
    observedAt: value.observedAt as Date,
    lat: value.lat as number,
    lon: value.lon as number,
    accuracyMeters: value.accuracyMeters as number | null,
    category: value.category as string,
    attributes: value.attributes as Record<string, unknown>,
  }, value.place as Record<string, unknown> | null);
}

export function toPlaceView(row: Place) {
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

const PLACE_DETAIL_TAGS = [
  "tourism",
  "historic",
  "aeroway",
  "iata",
  "icao",
  "cuisine",
  "opening_hours",
  "wheelchair",
  "website",
  "description",
  "fee",
  "internet_access",
  "wikidata",
];

function extractPlaceDetails(tags: Record<string, unknown> | null | undefined): Record<string, string> {
  const details: Record<string, string> = {};
  for (const key of PLACE_DETAIL_TAGS) {
    const value = tags?.[key];
    if (typeof value === "string" && value.trim()) details[key] = value.trim().slice(0, 300);
  }
  return details;
}

function escapeLike(text: string) { return text.replace(/[\\%_]/g, "\\$&"); }
