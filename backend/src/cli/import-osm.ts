import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOSMStream } from "osm-pbf-parser-node";
import { Op, type Transaction } from "sequelize";
import { database } from "../database/client.js";
import { initModels } from "../models/index.js";
import { Place } from "../models/place.js";
import { Source } from "../models/source.js";
import { polygonCenter } from "../services/geometry.js";

initModels();

const argv = process.argv.slice(2);
const option = (name: string, fallback: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");
const file = resolve(workspaceRoot, option("--file", "data/local/europe/germany-latest.osm.pbf"));
const sourceId = option("--source-id", "osm-de");
const sourceName = option("--source-name", "OpenStreetMap — Germany");
const sourceUrl = option("--source-url", "https://download.geofabrik.de/europe/germany-latest.osm.pbf");
const fallbackCountryCode = option("--country-code", "DE").toUpperCase();
const bbox = option("--bbox", "-180,-90,180,90").split(",").map(Number);
if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) throw new Error("--bbox must be minLon,minLat,maxLon,maxLat");
const [minLon, minLat, maxLon, maxLat] = bbox as [number, number, number, number];
const fileStat = await stat(file);
const fileHash = await sha256File(file);
const importToken = createHash("sha256").update(`${fileHash}:${bbox.join(",")}`).digest("hex").slice(0, 32);
const relevantTagKeys = ["name", "name:en", "amenity", "shop", "tourism", "leisure", "office", "public_transport", "railway", "historic", "healthcare", "education", "natural", "place", "aeroway", "iata", "icao", "cuisine", "opening_hours", "wheelchair", "website", "description", "fee", "internet_access", "wikidata", "addr:country", "addr:state", "addr:city", "addr:postcode", "addr:street", "addr:housenumber", "addr:unit", "addr:suburb", "addr:district", "entrance"];
const airportTagKeys = ["name", "name:en", "aeroway", "iata", "icao", "addr:country", "addr:state", "addr:city"];
const includedCategoryKeys = ["amenity", "shop", "tourism", "leisure", "office", "public_transport", "railway", "historic", "healthcare", "education", "natural", "place"];
const COUNTRY_CODES: Record<string, string> = {
  germany: "DE", deutschland: "DE", de: "DE",
  poland: "PL", polska: "PL", pl: "PL",
  romania: "RO", "românia": "RO", ro: "RO",
  france: "FR", fr: "FR",
  italy: "IT", italia: "IT", it: "IT",
  spain: "ES", "españa": "ES", es: "ES",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : null; }
function categoryFor(tags: Record<string, unknown>): string | null {
  for (const key of includedCategoryKeys) {
    const value = stringValue(tags[key]);
    if (value) return `${key}:${value}`.slice(0, 120);
  }
  return null;
}
function countryCode(tags: Record<string, unknown>) {
  const country = stringValue(tags["addr:country"]);
  if (!country) return fallbackCountryCode;
  const normalized = country.toLowerCase();
  const code = COUNTRY_CODES[normalized] ?? COUNTRY_CODES[normalized.toUpperCase().toLowerCase()];
  return code ?? fallbackCountryCode;
}
function isPlace(entity: Record<string, unknown>) {
  if (entity.type !== "node" || typeof entity.id !== "number" || typeof entity.lat !== "number" || typeof entity.lon !== "number") return false;
  if (entity.lon < minLon || entity.lon > maxLon || entity.lat < minLat || entity.lat > maxLat) return false;
  const tags = asRecord(entity.tags);
  const hasAddress = Boolean(tags["addr:housenumber"] && tags["addr:street"]);
  const hasPoiCategory = includedCategoryKeys.some((key) => stringValue(tags[key]));
  return hasAddress || (Boolean(stringValue(tags.name) || stringValue(tags["name:en"])) && hasPoiCategory);
}

await database.authenticate();
let imported = 0;
let skipped = 0;
let batch: Array<Record<string, unknown>> = [];
const airportWays = new Map<number, { refs: number[]; tags: Record<string, unknown> }>();
let snapshotDate: string | null = null;
let hasHeader = false;

try {
  await database.transaction(async (transaction) => {
    for await (const raw of createOSMStream(file, { withTags: { node: relevantTagKeys, way: airportTagKeys, relation: false }, withInfo: false })) {
      const entity = asRecord(raw);
      if (!hasHeader && !entity.type) {
        hasHeader = true;
        const replicationTime = entity.osmosis_replication_timestamp;
        if (typeof replicationTime === "number") snapshotDate = new Date(replicationTime * 1000).toISOString().slice(0, 10);
        await Source.upsert({
          id: sourceId, label: sourceName, mode: "public_snapshot", status: "ready",
          attribution: "© OpenStreetMap contributors",
          sourceUrl,
          license: "ODbL-1.0", snapshotDate,
        }, { transaction });
        continue;
      }
      if (entity.type === "way") {
        const tags = asRecord(entity.tags);
        if (tags.aeroway === "aerodrome" && (stringValue(tags.name) || stringValue(tags["name:en"])) && Array.isArray(entity.refs)) {
          airportWays.set(Number(entity.id), { refs: entity.refs.map(Number).filter(Number.isSafeInteger), tags });
        }
        continue;
      }
      if (entity.type !== "node") continue;
      if (typeof entity.lat !== "number" || typeof entity.lon !== "number" || entity.lon < minLon || entity.lon > maxLon || entity.lat < minLat || entity.lat > maxLat) continue;
      if (!isPlace(entity)) { skipped += 1; continue; }
      const tags = asRecord(entity.tags);
      const name = (stringValue(tags.name) ?? stringValue(tags["name:en"]) ?? [tags["addr:housenumber"], tags["addr:street"]].map(stringValue).filter(Boolean).join(" ")).slice(0, 240);
      if (!name) { skipped += 1; continue; }
      const placeId = `osm:node:${entity.id}`;
      const rawTags: Record<string, string> = {};
      for (const key of relevantTagKeys) {
        const value = stringValue(tags[key]);
        if (value) rawTags[key] = value;
      }
      batch.push({
        id: placeId, sourceId, osmType: "node", osmId: String(entity.id), name,
        category: categoryFor(tags) ?? (tags["addr:housenumber"] ? "address" : null),
        countryCode: countryCode(tags),
        region: stringValue(tags["addr:state"])?.slice(0, 160) ?? null, city: stringValue(tags["addr:city"])?.slice(0, 160) ?? null,
        postcode: stringValue(tags["addr:postcode"])?.slice(0, 32) ?? null, street: stringValue(tags["addr:street"])?.slice(0, 200) ?? null,
        houseNumber: stringValue(tags["addr:housenumber"])?.slice(0, 80) ?? null, lat: entity.lat, lon: entity.lon,
        tags: rawTags, importToken,
      });
      if (batch.length >= 1000) {
        await saveBatch(batch, transaction);
        imported += batch.length;
        batch = [];
        if (imported % 10_000 === 0) console.log(`Imported ${imported.toLocaleString()} places…`);
      }
    }
    if (!hasHeader) throw new Error("Input is not a readable OSM PBF file (header missing).");
    if (airportWays.size) {
      const requiredNodeIds = new Set([...airportWays.values()].flatMap((way) => way.refs));
      const airportCoordinates = new Map<number, { lat: number; lon: number }>();
      for await (const raw of createOSMStream(file, { withTags: { node: ["__coordinates_only__"], way: false, relation: false }, withInfo: false })) {
        const entity = asRecord(raw);
        if (entity.type === "node" && requiredNodeIds.has(Number(entity.id)) && typeof entity.lat === "number" && typeof entity.lon === "number") {
          airportCoordinates.set(Number(entity.id), { lat: entity.lat, lon: entity.lon });
        }
      }
      for (const [osmId, way] of airportWays) {
        const points = way.refs.map((ref) => airportCoordinates.get(ref)).filter((point): point is { lat: number; lon: number } => Boolean(point));
        const center = polygonCenter(points);
        if (!center || center.lon < minLon || center.lon > maxLon || center.lat < minLat || center.lat > maxLat) continue;
        const name = (stringValue(way.tags.name) ?? stringValue(way.tags["name:en"]))!;
        const rawTags: Record<string, string> = {};
        for (const key of airportTagKeys) {
          const value = stringValue(way.tags[key]);
          if (value) rawTags[key] = value;
        }
        batch.push({
          id: `osm:way:${osmId}`, sourceId, osmType: "way", osmId: String(osmId), name,
          category: "aeroway:aerodrome", countryCode: countryCode(way.tags),
          region: stringValue(way.tags["addr:state"])?.slice(0, 160) ?? null,
          city: stringValue(way.tags["addr:city"])?.slice(0, 160) ?? null,
          postcode: null, street: null, houseNumber: null, lat: center.lat, lon: center.lon,
          tags: rawTags, importToken,
        });
      }
    }
    if (batch.length) {
      await saveBatch(batch, transaction);
      imported += batch.length;
    }
    await Place.destroy({ where: { sourceId, importToken: { [Op.ne]: importToken } }, transaction });
  });
  const manifestDirectory = resolve(workspaceRoot, "data/local/europe");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(resolve(manifestDirectory, `${sourceId}-import-manifest.json`), `${JSON.stringify({ sourceId, sourceName, sourceUrl, license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", file, fileSizeBytes: fileStat.size, sha256: fileHash, snapshotDate, bbox: { minLon, minLat, maxLon, maxLat }, importedPlaces: imported, importToken }, null, 2)}\n`);
  console.log(JSON.stringify({ sourceId, file, snapshotDate, imported, skipped, importToken }, null, 2));
} finally {
  await database.close();
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function saveBatch(rows: Array<Record<string, unknown>>, transaction: Transaction) {
  await Place.bulkCreate(rows as never[], {
    transaction,
    updateOnDuplicate: ["name", "category", "countryCode", "region", "city", "postcode", "street", "houseNumber", "lat", "lon", "tags", "importToken", "updatedAt"],
  });
}
