import { database } from "../database/client.js";

const CACHE_MS = 60_000;
let cached: { at: number; value: string } | null = null;

/**
 * The OpenStreetMap areas with imported places, for the model's prompt ("Berlin, Germany; Kraków; …"), so an area
 * imported from the app is known to the assistant on its next turn.
 */
export async function placeCoverage(): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  // A cancelled or failed first import leaves a dataset row without places; it is not offered to the model.
  const [rows] = await database.query("SELECT s.label FROM data_sources s WHERE s.mode = 'public_snapshot' AND EXISTS (SELECT 1 FROM places p WHERE p.source_id = s.id) ORDER BY s.label");
  const labels = (rows as Array<{ label: string }>).map(({ label }) => label
    .replace(/^OpenStreetMap:\s*/i, "")
    .replace(/\s*regional extract$/i, "")
    .replace(/\s*\(Overpass\)$/i, ""));
  const value = labels.length ? labels.join("; ") : "no areas imported yet";
  cached = { at: Date.now(), value };
  return value;
}

/** Forgets the cached list, after an import added an area. */
export function invalidatePlaceCoverage(): void {
  cached = null;
}
