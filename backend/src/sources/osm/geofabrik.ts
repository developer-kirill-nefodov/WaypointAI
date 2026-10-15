import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SourceFetchError } from "../source-adapter.js";

export const GEOFABRIK_HOST = "download.geofabrik.de";
const INDEX_URL = `https://${GEOFABRIK_HOST}/index-v1-nogeom.json`;
const INDEX_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 3;

/** A region of the Geofabrik catalogue that can be imported as a whole. */
export interface GeofabrikRegion {
  id: string;
  name: string;
  /** Names of the parent regions, outermost first ("Europe › Poland"). */
  path: string[];
  countryCode: string | null;
  pbfUrl: string;
  parentId: string | null;
  /** Whether the catalogue lists smaller regions inside this one. */
  hasChildren: boolean;
  /** ISO 3166 codes the catalogue gives the region itself: a country code, or subdivision codes such as "IT-25". */
  isoCodes: string[];
}

export interface GeofabrikFile {
  url: string;
  bytes: number | null;
  lastModified: string | null;
}

type IndexFeature = { properties: { id: string; parent?: string; name: string; "iso3166-1:alpha2"?: string[]; "iso3166-2"?: string[]; urls?: { pbf?: string } } };

let cachedIndex: { at: number; regions: GeofabrikRegion[] } | null = null;

/** Only https URLs on the Geofabrik download host are fetched; region IDs come from the catalogue, never from a URL. */
export function isGeofabrikUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === GEOFABRIK_HOST;
  } catch {
    return false;
  }
}

/** Plain text of a catalogue name such as "Województwo małopolskie<br />(Lesser Poland Voivodeship)". */
function cleanName(name: string): string {
  return name.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export function parseGeofabrikIndex(body: string): GeofabrikRegion[] {
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new SourceFetchError("upstream_malformed", false); }
  const features = payload && typeof payload === "object" && Array.isArray((payload as { features?: unknown }).features) ? (payload as { features: IndexFeature[] }).features : null;
  if (!features) throw new SourceFetchError("upstream_malformed", false);
  const byId = new Map(features.filter((feature) => feature?.properties?.id).map((feature) => [feature.properties.id, feature.properties]));
  const regions: GeofabrikRegion[] = [];
  for (const properties of byId.values()) {
    const pbfUrl = properties.urls?.pbf;
    if (!pbfUrl || !isGeofabrikUrl(pbfUrl) || !/^[a-z0-9-]{1,80}$/.test(properties.id)) continue;
    const path: string[] = [];
    let parent = properties.parent ? byId.get(properties.parent) : undefined;
    const seen = new Set<string>();
    while (parent && !seen.has(parent.id) && path.length < 6) {
      seen.add(parent.id);
      path.unshift(cleanName(parent.name));
      parent = parent.parent ? byId.get(parent.parent) : undefined;
    }
    const alpha2 = properties["iso3166-1:alpha2"]?.[0] ?? properties["iso3166-2"]?.[0]?.slice(0, 2);
    let countryCode = alpha2 && /^[A-Z]{2}$/.test(alpha2) ? alpha2 : null;
    // Subregions such as "malopolskie" carry no code; the nearest parent's code applies.
    for (let ancestor = properties.parent ? byId.get(properties.parent) : undefined; !countryCode && ancestor; ancestor = ancestor.parent ? byId.get(ancestor.parent) : undefined) {
      const code = ancestor["iso3166-1:alpha2"]?.[0];
      if (code && /^[A-Z]{2}$/.test(code)) countryCode = code;
    }
    const isoCodes = [...(properties["iso3166-1:alpha2"] ?? []), ...(properties["iso3166-2"] ?? [])].filter((code) => /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code));
    regions.push({ id: properties.id, name: cleanName(properties.name), path, countryCode, pbfUrl, parentId: properties.parent && byId.has(properties.parent) ? properties.parent : null, hasChildren: false, isoCodes });
  }
  const parents = new Set(regions.map((region) => region.parentId));
  for (const region of regions) region.hasChildren = parents.has(region.id);
  return regions.sort((left, right) => left.name.localeCompare(right.name));
}

export async function geofabrikRegions(userAgent: string, fetchImpl: typeof fetch = fetch): Promise<GeofabrikRegion[]> {
  if (cachedIndex && Date.now() - cachedIndex.at < INDEX_CACHE_MS) return cachedIndex.regions;
  const response = await fetchImpl(INDEX_URL, { headers: { "user-agent": userAgent }, redirect: "error", signal: AbortSignal.timeout(30_000) })
    .catch(() => { throw new SourceFetchError("upstream_unavailable", true); });
  if (!response.ok) throw new SourceFetchError("upstream_unavailable", true);
  const regions = parseGeofabrikIndex(await response.text());
  cachedIndex = { at: Date.now(), regions };
  return regions;
}

/** Languages whose country names are searched too ("Polska", "Italia", "Польша", "Österreich"). */
const NAME_LANGUAGES = ["en", "ru", "uk", "de", "fr", "it", "es", "pt", "pl", "cs", "sk", "sl", "hr", "sr", "hu", "ro", "bg", "el", "nl", "da", "sv", "nb", "fi", "et", "lv", "lt", "tr"];
const countryNames = new Map<string, string>();

/** A country's name in every searched language, from the runtime's CLDR data; no dictionary is kept here. */
function namesOfCountry(code: string): string {
  let names = countryNames.get(code);
  if (names === undefined) {
    names = NAME_LANGUAGES.map((language) => {
      try { return new Intl.DisplayNames([language], { type: "region" }).of(code) ?? ""; } catch { return ""; }
    }).join(" ");
    countryNames.set(code, names);
  }
  return names;
}

const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** Regions whose name, ID, parent path, or (for a country) name in another language matches every word of the query. */
export function searchRegions(regions: GeofabrikRegion[], query: string, limit = 12): GeofabrikRegion[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return regions
    .filter((region) => {
      // Only a country's own entry carries its names in other languages, so "Polska" finds Poland, not every voivodeship.
      const ownCountry = region.isoCodes.find((code) => /^[A-Z]{2}$/.test(code));
      const text = fold([region.name, region.id, ...region.path, ownCountry ? namesOfCountry(ownCountry) : ""].join(" "));
      return words.every((word) => text.includes(word));
    })
    .sort((left, right) => left.path.length - right.path.length || left.name.localeCompare(right.name))
    .slice(0, limit);
}

/** Follows redirects only within the Geofabrik host, as its "-latest" links point to dated files. */
async function fetchFollowingSameHost(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isGeofabrikUrl(current)) throw new SourceFetchError("upstream_bad_request", false);
    const response = await fetchImpl(current, { ...init, redirect: "manual" }).catch((error: unknown) => {
      if (init.signal?.aborted) throw error;
      throw new SourceFetchError("upstream_unavailable", true);
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SourceFetchError("upstream_malformed", false);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new SourceFetchError(response.status === 404 ? "upstream_bad_request" : "upstream_unavailable", response.status >= 500);
    return response;
  }
  throw new SourceFetchError("upstream_malformed", false);
}

/** Size and date of a region's file, for the dialog. */
export async function geofabrikFileInfo(region: GeofabrikRegion, userAgent: string, fetchImpl: typeof fetch = fetch): Promise<GeofabrikFile> {
  const response = await fetchFollowingSameHost(region.pbfUrl, { method: "HEAD", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(20_000) }, fetchImpl);
  const length = Number(response.headers.get("content-length"));
  const modified = response.headers.get("last-modified");
  return { url: response.url || region.pbfUrl, bytes: Number.isFinite(length) && length > 0 ? length : null, lastModified: modified ? new Date(modified).toISOString() : null };
}

/**
 * Downloads a region's file to `destination` with progress, through a ".part" file that is renamed only when the
 * download is complete. Larger files than `maxBytes` are refused before and during the download.
 */
export async function downloadGeofabrikFile(region: GeofabrikRegion, destination: string, options: {
  userAgent: string;
  maxBytes: number;
  signal: AbortSignal;
  onProgress(bytes: number, total: number | null): void;
  fetchImpl?: typeof fetch;
}): Promise<{ bytes: number }> {
  const response = await fetchFollowingSameHost(region.pbfUrl, { headers: { "user-agent": options.userAgent }, signal: options.signal }, options.fetchImpl ?? fetch);
  const total = Number(response.headers.get("content-length")) || null;
  if (total && total > options.maxBytes) throw new SourceFetchError("file_too_large", false);
  if (!response.body) throw new SourceFetchError("upstream_malformed", false);
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  let bytes = 0;
  let reportedAt = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) return callback(new SourceFetchError("file_too_large", false));
      const now = Date.now();
      if (now - reportedAt >= 500) {
        reportedAt = now;
        options.onProgress(bytes, total);
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(partial), { signal: options.signal });
    if (total && bytes !== total) throw new SourceFetchError("upstream_malformed", true);
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  options.onProgress(bytes, total);
  return { bytes: (await stat(destination)).size };
}

/** Regions directly inside a region, or the top level of Europe when no parent is given. */
export function childRegions(regions: GeofabrikRegion[], parentId: string | null): GeofabrikRegion[] {
  return regions.filter((region) => region.parentId === (parentId ?? "europe"));
}

/**
 * The catalogue regions that contain a place: a region with one of its ISO 3166 codes (most specific first), else a
 * region of its country whose name contains one of its local names ("Bayern", "Województwo małopolskie"), else the
 * country. Wien has no region of its own, so it gives Austria.
 */
export function regionsForPlace(regions: GeofabrikRegion[], place: { codes: string[]; names: string[] }): GeofabrikRegion[] {
  const deepestFirst = (list: GeofabrikRegion[]) => list.sort((left, right) => right.path.length - left.path.length).slice(0, 3);
  for (const code of place.codes.filter((value) => value.includes("-"))) {
    const matches = regions.filter((region) => region.isoCodes.includes(code));
    if (matches.length) return deepestFirst(matches);
  }
  const country = place.codes.find((code) => /^[A-Z]{2}$/.test(code));
  const names = place.names.map(fold).filter((name) => name.length >= 3);
  if (country && names.length) {
    const candidates = regions.filter((region) => region.countryCode === country && !region.isoCodes.includes(country));
    // A region named exactly like the place or its state ("Bayern", "Oberbayern") comes before one that only contains it ("Niederbayern").
    const exact = candidates.filter((region) => names.includes(fold(region.name)));
    const partial = candidates.filter((region) => !exact.includes(region) && names.some((name) => fold(region.name).includes(name)));
    if (exact.length || partial.length) return [...deepestFirst(exact), ...deepestFirst(partial)].slice(0, 3);
  }
  return country ? regions.filter((region) => region.isoCodes.includes(country)).slice(0, 3) : [];
}
