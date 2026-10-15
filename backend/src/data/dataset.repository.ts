import { database } from "../database/client.js";
import { extractPlaceDetails } from "./record.repository.js";
import { isDeletableDataset, type DatasetDeleteStore } from "../services/dataset-delete.js";

/** A dataset as the import dialog and the data page list it: a source with what it holds. */
export interface DatasetView {
  id: string;
  label: string;
  kind: "places" | "events";
  mode: string;
  license: string | null;
  attribution: string | null;
  sourceUrl: string | null;
  snapshotDate: string | null;
  places: number;
  events: number;
  /** Extent of the places, as minLon, minLat, maxLon, maxLat; null without places. */
  bbox: [number, number, number, number] | null;
  /** Country codes of the places, most places first. */
  countries: string[];
  lastImportAt: string | null;
  /** Only datasets imported from the app can be deleted; the built-in extracts and event sources cannot. */
  deletable: boolean;
}

type DatasetRow = {
  id: string; label: string; mode: string; license: string | null; attribution: string | null; source_url: string | null; snapshot_date: string | Date | null;
  places: string | number | null; events: string | number | null; min_lon: number | null; min_lat: number | null; max_lon: number | null; max_lat: number | null; last_import_at: Date | null; countries: string[] | null;
};

/** Datasets with counts; place counts scan the places table, so callers cache the result. */
export async function listDatasets(): Promise<DatasetView[]> {
  const [rows] = await database.query(`
    SELECT s.id, s.label, s.mode, s.license, s.attribution, s.source_url, s.snapshot_date,
           p.places, p.min_lon, p.min_lat, p.max_lon, p.max_lat, p.countries, r.events, runs.last_import_at
    FROM data_sources s
    LEFT JOIN (SELECT source_id, sum(n) AS places, min(min_lon) AS min_lon, min(min_lat) AS min_lat, max(max_lon) AS max_lon, max(max_lat) AS max_lat,
                      array_agg(country_code ORDER BY n DESC) FILTER (WHERE country_code IS NOT NULL) AS countries
               FROM (SELECT source_id, country_code, count(*) AS n, min(lon) AS min_lon, min(lat) AS min_lat, max(lon) AS max_lon, max(lat) AS max_lat
                     FROM places GROUP BY source_id, country_code) by_country
               GROUP BY source_id) p ON p.source_id = s.id
    LEFT JOIN (SELECT source_id, count(*) AS events FROM records GROUP BY source_id) r ON r.source_id = s.id
    LEFT JOIN (SELECT source_id, max(finished_at) AS last_import_at FROM source_sync_runs WHERE status = 'succeeded' GROUP BY source_id) runs ON runs.source_id = s.id
    -- A deleted dataset keeps its row for the import history, marked unavailable.
    WHERE s.status = 'ready'
    ORDER BY s.mode, s.label`);
  return (rows as DatasetRow[]).map((row) => {
    const places = Number(row.places ?? 0);
    const events = Number(row.events ?? 0);
    const bbox = places && row.min_lon !== null && row.min_lat !== null && row.max_lon !== null && row.max_lat !== null
      ? [Number(row.min_lon), Number(row.min_lat), Number(row.max_lon), Number(row.max_lat)] as [number, number, number, number]
      : null;
    return {
      id: row.id,
      label: row.label,
      kind: events > places || row.mode === "approved_live" || row.mode === "synthetic_local" ? "events" : "places",
      mode: row.mode,
      license: row.license,
      attribution: row.attribution,
      sourceUrl: row.source_url,
      snapshotDate: row.snapshot_date ? new Date(row.snapshot_date).toISOString().slice(0, 10) : null,
      places,
      events,
      bbox,
      countries: row.countries ?? [],
      lastImportAt: row.last_import_at ? new Date(row.last_import_at).toISOString() : null,
      deletable: isDeletableDataset(row.id),
    };
  });
}

export const SETTLEMENT_TYPES = ["city", "town", "village"] as const;
export type SettlementType = typeof SETTLEMENT_TYPES[number];

/** A country with the imported places in it, across datasets. */
export interface CountryView {
  countryCode: string;
  places: number;
  cities: number;
  towns: number;
  villages: number;
  datasets: string[];
}

type CountryRow = { country_code: string; source_id: string; places: string; cities: string; towns: string; villages: string };

/** Countries of all ready datasets, or of one dataset with its own counts; the full scan is cached by callers. */
export async function listCountries(datasetId?: string): Promise<CountryView[]> {
  const [rows] = await database.query(`
    SELECT p.country_code, p.source_id, count(*) AS places,
           count(*) FILTER (WHERE p.category = 'place:city') AS cities,
           count(*) FILTER (WHERE p.category = 'place:town') AS towns,
           count(*) FILTER (WHERE p.category = 'place:village') AS villages
    FROM places p JOIN data_sources s ON s.id = p.source_id AND s.status = 'ready'
    WHERE p.country_code IS NOT NULL ${datasetId ? "AND p.source_id = $1" : ""}
    GROUP BY p.country_code, p.source_id`, { bind: datasetId ? [datasetId] : [] });
  const countries = new Map<string, CountryView & { perDataset: Map<string, number> }>();
  for (const row of rows as CountryRow[]) {
    const country = countries.get(row.country_code) ?? { countryCode: row.country_code, places: 0, cities: 0, towns: 0, villages: 0, datasets: [], perDataset: new Map() };
    country.places += Number(row.places);
    country.cities += Number(row.cities);
    country.towns += Number(row.towns);
    country.villages += Number(row.villages);
    country.perDataset.set(row.source_id, Number(row.places));
    countries.set(row.country_code, country);
  }
  return [...countries.values()]
    .map(({ perDataset, ...country }) => ({ ...country, datasets: [...perDataset.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id) }))
    .sort((left, right) => right.places - left.places);
}

/** A city, town, or village of a dataset, with the number of places whose address names it. */
export interface SettlementView {
  id: string;
  name: string;
  nameEn: string | null;
  type: SettlementType;
  countryCode: string | null;
  datasetId: string;
  lat: number;
  lon: number;
  places: number;
}

export interface SettlementQuery {
  countryCode: string;
  datasetId?: string;
  query?: string;
  types: SettlementType[];
  limit: number;
  offset: number;
}

type SettlementRow = { id: string; name: string; name_en: string | null; category: string; country_code: string | null; source_id: string; lat: number; lon: number; places: string; total: string };

/** Settlements of one country, cities first and then by how many places name them; all values are bound parameters. */
export async function listSettlements(input: SettlementQuery): Promise<{ total: number; settlements: SettlementView[] }> {
  const categories = input.types.map((type) => `place:${type}`);
  const bind: unknown[] = [input.countryCode, categories, input.limit, input.offset];
  const datasetFilter = input.datasetId ? `AND source_id = $${bind.push(input.datasetId)}` : "";
  const nameFilter = input.query ? `AND (lower(name) LIKE $${bind.push(`%${escapeLike(input.query.toLowerCase())}%`)} OR lower(tags->>'name:en') LIKE $${bind.length})` : "";
  const [rows] = await database.query(`
    WITH s AS (
      SELECT id, name, tags->>'name:en' AS name_en, category, country_code, source_id, lat, lon FROM places
      WHERE country_code = $1 AND category = ANY($2::text[]) ${datasetFilter} ${nameFilter}
        AND source_id IN (SELECT id FROM data_sources WHERE status = 'ready')
    ), c AS (
      SELECT source_id, lower(city) AS city, count(*) AS n FROM places
      WHERE country_code = $1 AND city IS NOT NULL ${datasetFilter} GROUP BY source_id, lower(city)
    )
    SELECT s.*, COALESCE(c.n, 0) AS places, count(*) OVER () AS total
    FROM s LEFT JOIN c ON c.source_id = s.source_id AND c.city = lower(s.name)
    ORDER BY CASE s.category WHEN 'place:city' THEN 0 WHEN 'place:town' THEN 1 ELSE 2 END, places DESC, s.name
    LIMIT $3 OFFSET $4`, { bind });
  const list = rows as SettlementRow[];
  return {
    total: Number(list[0]?.total ?? 0),
    settlements: list.map((row) => ({
      id: row.id,
      name: row.name,
      nameEn: row.name_en && row.name_en !== row.name ? row.name_en : null,
      type: row.category.slice("place:".length) as SettlementType,
      countryCode: row.country_code,
      datasetId: row.source_id,
      lat: Number(row.lat),
      lon: Number(row.lon),
      places: Number(row.places),
    })),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const DELETE_BATCH = 5_000;

export const sqlDatasetDeleteStore: DatasetDeleteStore = {
  async countPlaces(datasetId) {
    const [rows] = await database.query("SELECT count(*) AS n FROM places WHERE source_id = $1", { bind: [datasetId] });
    return Number((rows as Array<{ n: string }>)[0]?.n ?? 0);
  },

  async deleteDataset(datasetId, onBatch) {
    // One transaction: a cancelled or failed deletion leaves the dataset as it was. Links of events to these places
    // are removed by their foreign key, and events keep their rows with the place reference cleared.
    return database.transaction(async (transaction) => {
      let deleted = 0;
      for (;;) {
        const [, result] = await database.query(
          "DELETE FROM places WHERE id IN (SELECT id FROM places WHERE source_id = $1 LIMIT $2)",
          { bind: [datasetId, DELETE_BATCH], transaction },
        );
        const count = (result as { rowCount?: number } | undefined)?.rowCount ?? 0;
        if (!count) break;
        deleted += count;
        onBatch(deleted);
      }
      // The dataset row stays for the sync history that references it; it is hidden as unavailable until re-imported.
      await database.query("UPDATE data_sources SET status = 'unavailable', updated_at = now() WHERE id = $1", { bind: [datasetId], transaction });
      return deleted;
    });
  },
};

/** One place as the data explorer lists it, with the tags its card shows. */
export interface CatalogPlace {
  id: string;
  datasetId: string;
  name: string;
  category: string | null;
  countryCode: string | null;
  city: string | null;
  street: string | null;
  houseNumber: string | null;
  postcode: string | null;
  lat: number;
  lon: number;
  details: Record<string, string>;
}

/** Filters of the data explorer; `datasetIds` is never empty, so every query is bounded to known datasets. */
export interface CatalogFilter {
  datasetIds: string[];
  countryCode?: string;
  city?: string;
  category?: string;
  query?: string;
  /** minLon, minLat, maxLon, maxLat */
  bbox?: [number, number, number, number];
}

export interface CatalogPlaceQuery extends CatalogFilter {
  limit: number;
  /** The last row of the previous page and its part of the list (see listCatalogPlaces). */
  after?: CatalogCursor;
}

/** Part 0 holds names that start with a letter, part 1 the rest ("#00095…", "1 Boulevard…", quotes). */
export interface CatalogCursor { part: 0 | 1; name: string; id: string }

type PlaceRow = {
  id: string; source_id: string; name: string; category: string | null; country_code: string | null; city: string | null; street: string | null;
  house_number: string | null; postcode: string | null; lat: number; lon: number; tags: Record<string, unknown> | null;
};

/** The WHERE clause of a catalog filter; every value is a bound parameter. */
function catalogWhere(filter: CatalogFilter, bind: unknown[], options: { category: boolean } = { category: true }): string {
  // Restricting by dataset first lets PostgreSQL use the (source_id, category) index even for a whole country.
  const clauses = [`source_id = ANY($${bind.push(filter.datasetIds)}::text[])`];
  if (filter.countryCode) clauses.push(`country_code = $${bind.push(filter.countryCode)}`);
  if (filter.city) clauses.push(`lower(city) = $${bind.push(filter.city.toLowerCase())}`);
  if (options.category && filter.category) clauses.push(`category = $${bind.push(filter.category)}`);
  if (filter.query) clauses.push(`(lower(name) LIKE $${bind.push(`%${escapeLike(filter.query.toLowerCase())}%`)} OR lower(street) LIKE $${bind.length})`);
  if (filter.bbox) {
    const [minLon, minLat, maxLon, maxLat] = filter.bbox;
    clauses.push(`lon BETWEEN $${bind.push(minLon)} AND $${bind.push(maxLon)} AND lat BETWEEN $${bind.push(minLat)} AND $${bind.push(maxLat)}`);
  }
  return clauses.join(" AND ");
}

/**
 * Names starting with a letter all sort at or after 'A' in the database collation, and almost nothing else does,
 * so splitting at 'A' lists real names first and house numbers or codes after them while every part still reads
 * the name index in order.
 */
const PARTS = ["name >= 'A'", "name < 'A'"] as const;

/** A page of places with a keyset cursor (letters first, then by name and ID); the total is counted only for the first page. */
export async function listCatalogPlaces(input: CatalogPlaceQuery): Promise<{ total: number | null; places: CatalogPlace[]; next: CatalogCursor | null }> {
  const bind: unknown[] = [];
  const where = catalogWhere(input, bind);
  const selective = Boolean(input.query || input.city || input.bbox);
  const rows: Array<PlaceRow & { part: 0 | 1 }> = [];
  for (const part of [0, 1] as const) {
    if (input.after && input.after.part > part) continue;
    const page = [...bind];
    const keyset = input.after?.part === part ? `AND (name, id) > ($${page.push(input.after.name)}, $${page.push(input.after.id)})` : "";
    const columns = "id, source_id, name, category, country_code, city, street, house_number, postcode, lat, lon, tags";
    const limit = `LIMIT $${page.push(input.limit + 1 - rows.length)}`;
    // A text, city, or area filter matches few rows; finding them first and sorting them is far faster than walking
    // the name index and testing every place (2 s → 50 ms for a word in a 73,000-place region).
    const sqlText = selective
      ? `WITH matched AS MATERIALIZED (SELECT ${columns} FROM places WHERE ${where})
         SELECT * FROM matched WHERE ${PARTS[part]} ${keyset} ORDER BY name, id ${limit}`
      : `SELECT ${columns} FROM places WHERE ${where} AND ${PARTS[part]} ${keyset} ORDER BY name, id ${limit}`;
    const [found] = await database.query(sqlText, { bind: page });
    rows.push(...(found as PlaceRow[]).map((row) => ({ ...row, part })));
    if (rows.length > input.limit) break;
  }
  let total: number | null = null;
  if (!input.after) {
    const [counted] = await database.query(`SELECT count(*) AS n FROM places WHERE ${where}`, { bind });
    total = Number((counted as Array<{ n: string }>)[0]?.n ?? 0);
  }
  const pageRows = rows.slice(0, input.limit);
  const last = pageRows.at(-1);
  return {
    total,
    places: pageRows.map((row) => ({
      id: row.id, datasetId: row.source_id, name: row.name, category: row.category, countryCode: row.country_code, city: row.city, street: row.street,
      houseNumber: row.house_number, postcode: row.postcode, lat: Number(row.lat), lon: Number(row.lon), details: extractPlaceDetails(row.tags),
    })),
    next: rows.length > input.limit && last ? { part: last.part, name: last.name, id: last.id } : null,
  };
}

/** Place counts per category under the other filters (the category filter itself is ignored), most first. */
export async function listCatalogCategories(filter: CatalogFilter, limit = 80): Promise<Array<{ category: string; places: number }>> {
  const bind: unknown[] = [];
  const where = catalogWhere(filter, bind, { category: false });
  const [rows] = await database.query(
    `SELECT category, count(*) AS n FROM places WHERE ${where} AND category IS NOT NULL GROUP BY category ORDER BY n DESC, category LIMIT $${bind.push(limit)}`,
    { bind },
  );
  return (rows as Array<{ category: string; n: string }>).map((row) => ({ category: row.category, places: Number(row.n) }));
}

/** One event of a dataset as the data page lists it. */
export interface DatasetEventRow { id: string; label: string; category: string; observedAt: string; lat: number; lon: number; magnitude: number | null }

type EventRow = { id: string; category: string; observed_at: Date; lat: number; lon: number; attributes: Record<string, unknown> | null };

/** A page of a dataset's events, newest first, with a keyset cursor. */
export async function listDatasetEvents(input: { datasetId: string; limit: number; after?: { observedAt: string; id: string } }): Promise<{ total: number | null; events: DatasetEventRow[]; next: { observedAt: string; id: string } | null }> {
  const bind: unknown[] = [input.datasetId];
  const keyset = input.after ? `AND (observed_at, id) < ($${bind.push(input.after.observedAt)}::timestamptz, $${bind.push(input.after.id)})` : "";
  const [rows] = await database.query(
    `SELECT id, category, observed_at, lat, lon, attributes FROM records WHERE source_id = $1 ${keyset}
     ORDER BY observed_at DESC, id DESC LIMIT $${bind.push(input.limit + 1)}`,
    { bind },
  );
  let total: number | null = null;
  if (!input.after) {
    const [counted] = await database.query("SELECT count(*) AS n FROM records WHERE source_id = $1", { bind: [input.datasetId] });
    total = Number((counted as Array<{ n: string }>)[0]?.n ?? 0);
  }
  const list = rows as EventRow[];
  const pageRows = list.slice(0, input.limit);
  const last = pageRows.at(-1);
  return {
    total,
    events: pageRows.map((row) => {
      const attributes = row.attributes ?? {};
      const magnitude = Number(attributes.magnitude);
      return {
        id: row.id,
        label: typeof attributes.label === "string" ? attributes.label : row.category,
        category: row.category,
        observedAt: new Date(row.observed_at).toISOString(),
        lat: Number(row.lat),
        lon: Number(row.lon),
        magnitude: Number.isFinite(magnitude) ? magnitude : null,
      };
    }),
    next: list.length > input.limit && last ? { observedAt: new Date(last.observed_at).toISOString(), id: last.id } : null,
  };
}
