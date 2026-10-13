import { SEARCH_LIMITS } from "../config/search-limits.js";
import type { EventSearchInput } from "../data/investigation.repository.js";
import type { ResolvedPlace } from "../data/settlement.repository.js";
import { HOUR_MS } from "../services/time.js";
import type { SearchEventsArgs } from "../tools/search-events.js";
import { interpretWithRules } from "./investigation-rules.js";

/** Shared by the investigation query endpoint and the chat assistant's search_events tool. */

// Countries and regions the small model sometimes passes as place despite the prompt; the catalogue covers them anyway.
// Lowercase; compared with the trimmed, lowercased place.
const NOT_A_SETTLEMENT = new Set([
  // Countries and Europe.
  "italy", "italia", "italien", "италия",
  "europe", "европа", "europa",
  "germany", "deutschland", "германия",
  "poland", "polska", "polen", "польша",
  "romania", "românia", "rumänien", "румыния",
  "france", "frankreich", "франция",
  "spain", "españa", "spanien", "испания",
  // Italian regions and islands.
  "sicily", "sicilia", "sizilien", "сицилия",
  "sardinia", "sardegna",
  "umbria", "marche",
  "lazio", "latium",
  "abruzzo", "abruzzen",
  "toscana", "tuscany", "toskana",
  "campania", "kampanien",
  "calabria", "kalabrien",
  "molise", "basilicata",
  "puglia", "apulia",
  "emilia-romagna", "liguria", "piemonte", "lombardia", "veneto",
  "friuli", "friuli-venezia giulia",
  "trentino", "trentino-alto adige",
  "central italy", "southern italy", "northern italy",
]);

export type GeoPoint = { lat: number; lon: number };

export type SearchCenter =
  | { ok: true; point: GeoPoint | null; resolvedPlace: ResolvedPlace | null }
  | { ok: false; error: "place_not_found" | "selection_required" };

/** Drops a country or region passed as place (and its radius), so the search covers the whole catalogue. */
export function dropNonSettlementPlace(args: SearchEventsArgs): { args: SearchEventsArgs; ignoredPlace?: string } {
  const place = args.place?.trim();
  if (!place || !NOT_A_SETTLEMENT.has(place.toLowerCase())) return { args };
  const { place: _place, radiusKm: _radius, ...rest } = args;
  return { args: rest, ignoredPlace: place };
}

/** Center of a radius search: the selected map item, a verified settlement, or none. Never model coordinates. */
export async function resolveSearchCenter(
  args: SearchEventsArgs,
  selection: GeoPoint | null,
  resolveSettlement: (name: string) => Promise<ResolvedPlace | null>,
): Promise<SearchCenter> {
  if (args.nearSelection) {
    if (!selection) return { ok: false, error: "selection_required" };
    return { ok: true, point: { lat: selection.lat, lon: selection.lon }, resolvedPlace: null };
  }
  if (!args.place) return { ok: true, point: null, resolvedPlace: null };
  const resolvedPlace = await resolveSettlement(args.place);
  if (!resolvedPlace) return { ok: false, error: "place_not_found" };
  return { ok: true, point: { lat: resolvedPlace.lat, lon: resolvedPlace.lon }, resolvedPlace };
}

export function buildEventSearch(args: SearchEventsArgs, center: GeoPoint | null, now: Date): EventSearchInput {
  const hours = args.hours ?? SEARCH_LIMITS.hours.default;
  const radiusKm = args.radiusKm ?? SEARCH_LIMITS.radiusKm.default;
  return {
    from: new Date(now.getTime() - hours * HOUR_MS),
    to: now,
    near: center ? { ...center, radiusMeters: radiusKm * 1000 } : undefined,
    minMagnitude: args.minMagnitude,
    maxMagnitude: args.maxMagnitude,
    limit: SEARCH_LIMITS.queryResultLimit,
  };
}

/**
 * Fills numeric constraints the model left out but the user stated explicitly ("within 20 km", "last 3 days",
 * "M2+"), using the deterministic parser. The model's own values always win; places are never added.
 */
export function complementFromText(args: SearchEventsArgs, text: string): SearchEventsArgs {
  const stated = interpretWithRules(text);
  if (!stated) return args;
  return {
    ...args,
    ...(args.radiusKm === undefined && stated.radiusKm !== undefined && /\d\s*(?:km|км|kilomet)/i.test(text) ? { radiusKm: stated.radiusKm } : {}),
    ...(args.hours === undefined && stated.hours !== undefined ? { hours: stated.hours } : {}),
    ...(args.minMagnitude === undefined && stated.minMagnitude !== undefined ? { minMagnitude: stated.minMagnitude } : {}),
  };
}
