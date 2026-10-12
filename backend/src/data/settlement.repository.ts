import { database } from "../database/client.js";

export interface ResolvedPlace {
  /** "approximate" when no exact name matched and a close spelling was used instead. */
  match: "exact" | "approximate";
  id: string;
  sourceId: string;
  name: string;
  category: string;
  countryCode: string | null;
  lat: number;
  lon: number;
}

interface SettlementRow {
  id: string;
  source_id: string;
  name: string;
  category: string;
  country_code: string | null;
  lat: number;
  lon: number;
}

const SETTLEMENT_CATEGORIES = ["place:city", "place:town", "place:village", "place:suburb", "place:hamlet"];
const APPROXIMATE_SETTLEMENT_CATEGORIES = ["place:city", "place:town"];
// Literal lists (not bind parameters) so the planner can match the partial indexes
// from the settlement-lookup migration.
const SETTLEMENT_CATEGORY_SQL = toSqlList(SETTLEMENT_CATEGORIES);
const APPROXIMATE_SETTLEMENT_CATEGORY_SQL = toSqlList(APPROXIMATE_SETTLEMENT_CATEGORIES);

/** Shorter names are too ambiguous for a fuzzy match. */
const MIN_APPROXIMATE_NAME_LENGTH = 5;
/** Names up to this length allow one edit; longer names allow two. */
const SHORT_NAME_LENGTH = 5;
const SHORT_NAME_MAX_EDITS = 1;
const LONG_NAME_MAX_EDITS = 2;

/**
 * Resolves a settlement name to one verified OSM row: exact (case-insensitive) local or English name,
 * larger settlement types first. If nothing matches exactly, a close spelling with the same first three
 * letters is accepted and reported as "approximate". Returns null instead of guessing further.
 */
export async function resolveSettlement(name: string): Promise<ResolvedPlace | null> {
  await database.authenticate();
  const term = name.trim().slice(0, 100);
  const exact = await findSettlement(term);
  if (exact) return { match: "exact", ...exact };
  if (term.length < MIN_APPROXIMATE_NAME_LENGTH) return null;
  const approximate = await findSettlementApproximately(term);
  return approximate ? { match: "approximate", ...approximate } : null;
}

async function findSettlement(name: string): Promise<Omit<ResolvedPlace, "match"> | null> {
  const [rows] = await database.query(
    `SELECT id, source_id, name, category, country_code, lat, lon
     FROM places
     WHERE category IN (${SETTLEMENT_CATEGORY_SQL})
       AND (lower(name) = lower($2) OR lower(tags->>'name:en') = lower($2))
     ORDER BY array_position($1::varchar[], category::varchar), id
     LIMIT 1`,
    { bind: [SETTLEMENT_CATEGORIES, name] },
  );
  return toResolvedPlace((rows as SettlementRow[])[0]);
}

/**
 * Levenshtein distance via the fuzzystrmatch extension. Limited to cities and towns: among thousands of
 * villages a near-miss spelling too often lands on an unrelated place (seen: "Florenz" → a Romanian village).
 */
async function findSettlementApproximately(name: string): Promise<Omit<ResolvedPlace, "match"> | null> {
  const maxDistance = name.length <= SHORT_NAME_LENGTH ? SHORT_NAME_MAX_EDITS : LONG_NAME_MAX_EDITS;
  const [rows] = await database.query(
    `SELECT id, source_id, name, category, country_code, lat, lon
     FROM places
     WHERE category IN (${APPROXIMATE_SETTLEMENT_CATEGORY_SQL})
       AND length(name) BETWEEN $3 AND $4
       AND left(lower(name), 3) = left(lower($2), 3)
       AND levenshtein(lower(name), lower($2)) <= $5
     ORDER BY array_position($1::varchar[], category::varchar), levenshtein(lower(name), lower($2)), id
     LIMIT 1`,
    {
      bind: [
        SETTLEMENT_CATEGORIES,
        name,
        name.length - maxDistance,
        name.length + maxDistance,
        maxDistance,
      ],
    },
  );
  return toResolvedPlace((rows as SettlementRow[])[0]);
}

function toResolvedPlace(row: SettlementRow | undefined): Omit<ResolvedPlace, "match"> | null {
  if (!row) return null;
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    name: String(row.name),
    category: String(row.category),
    countryCode: row.country_code ?? null,
    lat: Number(row.lat),
    lon: Number(row.lon),
  };
}

function toSqlList(values: string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}
