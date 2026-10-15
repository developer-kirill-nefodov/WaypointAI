import type { ImportJob, ImportJobParams } from "@waypoint-ai/shared";

const apiBase = import.meta.env.VITE_API_BASE ?? "";
const base = `${apiBase}/api/v1/investigations/imports`;

export class ImportRequestError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

async function readError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new ImportRequestError(body.error ?? "import_failed", response.status);
}

export type ImportList = { importEnabled: boolean; jobs: ImportJob[]; cooldowns: Record<string, number>; osmAreaMaxSquareDegrees: number };

export async function listImports(active: boolean, signal?: AbortSignal, limit = 10): Promise<ImportList> {
  const response = await fetch(`${base}?active=${active}&limit=${limit}`, { signal });
  if (!response.ok) return readError(response);
  return response.json() as Promise<ImportList>;
}

export async function getImport(id: string, signal?: AbortSignal): Promise<ImportJob> {
  const response = await fetch(`${base}/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) return readError(response);
  return (await response.json() as { job: ImportJob }).job;
}

/**
 * What the app sends; a region is named only by its catalogue ID and a deletion only by the dataset ID, and the
 * server fills in names and countries.
 */
export type ImportJobRequest = Exclude<ImportJobParams, { kind: "osm_region" | "dataset_delete" }>
  | { kind: "osm_region"; regionId: string }
  | { kind: "dataset_delete"; datasetId: string };

/** The request that repeats a job, for retry. */
export function repeatRequest(params: ImportJobParams): ImportJobRequest {
  if (params.kind === "osm_region") return { kind: "osm_region", regionId: params.regionId };
  if (params.kind === "dataset_delete") return { kind: "dataset_delete", datasetId: params.datasetId };
  return params;
}

/** Removes finished jobs from the history; the imported data stays. */
export async function clearImportHistory(): Promise<number> {
  const response = await fetch(`${base}/history/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!response.ok) return readError(response);
  return (await response.json() as { removed: number }).removed;
}

export async function startImport(params: ImportJobRequest): Promise<ImportJob> {
  const response = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  if (!response.ok) return readError(response);
  return (await response.json() as { job: ImportJob }).job;
}

export async function cancelImport(id: string): Promise<boolean> {
  const response = await fetch(`${base}/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!response.ok) return readError(response);
  return (await response.json() as { cancelled: boolean }).cancelled;
}

/** A settlement found by name, with its extent, for choosing an import area. */
export interface GeocodeResult { label: string; name: string; localizedName: string; type: string; countryCode: string | null; lat: number; lon: number; bbox: [number, number, number, number] }

export async function geocode(query: string, language: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const response = await fetch(`${apiBase}/api/v1/data/geocode?q=${encodeURIComponent(query)}&language=${language}`, { signal });
  if (!response.ok) return readError(response);
  return (await response.json() as { results: GeocodeResult[] }).results;
}

export interface Dataset {
  id: string; label: string; kind: "places" | "events"; mode: string; license: string | null; attribution: string | null; sourceUrl: string | null;
  snapshotDate: string | null; places: number; events: number; bbox: [number, number, number, number] | null; countries: string[];
  lastImportAt: string | null; deletable: boolean;
}

export interface CountryCoverage { countryCode: string; places: number; cities: number; towns: number; villages: number; datasets: string[] }

/** All countries, or one dataset's countries with its own counts. */
export async function listCountries(fresh: boolean, signal?: AbortSignal, datasetId?: string): Promise<CountryCoverage[]> {
  const params = new URLSearchParams();
  if (fresh) params.set("fresh", "true");
  if (datasetId) params.set("dataset", datasetId);
  const response = await fetch(`${apiBase}/api/v1/data/countries${params.size ? `?${params}` : ""}`, { signal });
  if (!response.ok) return readError(response);
  return (await response.json() as { countries: CountryCoverage[] }).countries;
}

export type SettlementType = "city" | "town" | "village";
export interface Settlement { id: string; name: string; nameEn: string | null; type: SettlementType; countryCode: string | null; datasetId: string; lat: number; lon: number; places: number }

export async function listSettlements(query: { country: string; dataset?: string; q?: string; types: SettlementType[]; limit: number; offset: number }, signal?: AbortSignal): Promise<{ total: number; settlements: Settlement[] }> {
  const params = new URLSearchParams({ country: query.country, types: query.types.join(","), limit: String(query.limit), offset: String(query.offset) });
  if (query.dataset) params.set("dataset", query.dataset);
  if (query.q?.trim()) params.set("q", query.q.trim());
  const response = await fetch(`${apiBase}/api/v1/data/settlements?${params}`, { signal });
  if (!response.ok) return readError(response);
  return response.json() as Promise<{ total: number; settlements: Settlement[] }>;
}

export async function listDatasets(fresh: boolean, signal?: AbortSignal): Promise<Dataset[]> {
  const response = await fetch(`${apiBase}/api/v1/data/datasets${fresh ? "?fresh=true" : ""}`, { signal });
  if (!response.ok) return readError(response);
  return (await response.json() as { datasets: Dataset[] }).datasets;
}

export interface GeofabrikRegion { id: string; name: string; path: string[]; countryCode: string | null; pbfUrl: string; parentId: string | null; hasChildren: boolean; isoCodes: string[] }
export interface GeofabrikFile { url: string; bytes: number | null; lastModified: string | null }

/**
 * Regions by name (also a country's name in other languages); when the catalogue does not know the name, the
 * server looks the place up and returns the regions that contain it, with `via` naming the place.
 */
export async function searchRegions(query: string, language: string, signal?: AbortSignal): Promise<{ regions: GeofabrikRegion[]; via?: string }> {
  const response = await fetch(`${apiBase}/api/v1/data/regions?q=${encodeURIComponent(query)}&language=${language}`, { signal });
  if (!response.ok) return readError(response);
  return response.json() as Promise<{ regions: GeofabrikRegion[]; via?: string }>;
}

/** Regions directly inside a region, or Europe's countries. */
export async function browseRegions(parentId: string | null, signal?: AbortSignal): Promise<GeofabrikRegion[]> {
  const response = await fetch(`${apiBase}/api/v1/data/regions${parentId ? `?parent=${encodeURIComponent(parentId)}` : ""}`, { signal });
  if (!response.ok) return readError(response);
  return (await response.json() as { regions: GeofabrikRegion[] }).regions;
}

export async function regionInfo(id: string, signal?: AbortSignal): Promise<{ region: GeofabrikRegion; file: GeofabrikFile }> {
  const response = await fetch(`${apiBase}/api/v1/data/regions/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) return readError(response);
  return response.json() as Promise<{ region: GeofabrikRegion; file: GeofabrikFile }>;
}

export interface CatalogPlace {
  id: string; datasetId: string; name: string; category: string | null; countryCode: string | null; city: string | null; street: string | null;
  houseNumber: string | null; postcode: string | null; lat: number; lon: number; details: Record<string, string>;
}
export interface DatasetEvent { id: string; label: string; category: string; observedAt: string; lat: number; lon: number; magnitude: number | null }
export type Page<K extends string, T> = { total: number | null; nextCursor: string | null } & Record<K, T[]>;

/** Filters of the data explorer; a dataset or a country is required. */
export interface CatalogFilter { dataset?: string; country?: string; city?: string; category?: string; q?: string; bbox?: [number, number, number, number] | null }

function catalogParams(filter: CatalogFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.dataset) params.set("dataset", filter.dataset);
  if (filter.country) params.set("country", filter.country);
  if (filter.city) params.set("city", filter.city);
  if (filter.category) params.set("category", filter.category);
  if (filter.q?.trim()) params.set("q", filter.q.trim());
  if (filter.bbox) params.set("bbox", filter.bbox.map((value) => value.toFixed(5)).join(","));
  return params;
}

export async function listCatalogPlaces(filter: CatalogFilter, cursor: string | null, limit = 50, signal?: AbortSignal): Promise<Page<"places", CatalogPlace>> {
  const params = catalogParams(filter);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${apiBase}/api/v1/data/catalog/places?${params}`, { signal });
  if (!response.ok) return readError(response);
  return response.json() as Promise<Page<"places", CatalogPlace>>;
}

/** Category counts under the other filters (the category filter itself is ignored). */
export async function listCatalogCategories(filter: CatalogFilter, signal?: AbortSignal): Promise<Array<{ category: string; places: number }>> {
  const params = catalogParams({ ...filter, category: undefined });
  const response = await fetch(`${apiBase}/api/v1/data/catalog/categories?${params}`, { signal });
  if (!response.ok) return readError(response);
  return (await response.json() as { categories: Array<{ category: string; places: number }> }).categories;
}

export async function listDatasetEvents(datasetId: string, cursor: string | null, signal?: AbortSignal): Promise<Page<"events", DatasetEvent>> {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${apiBase}/api/v1/data/datasets/${encodeURIComponent(datasetId)}/events?${params}`, { signal });
  if (!response.ok) return readError(response);
  return response.json() as Promise<Page<"events", DatasetEvent>>;
}
