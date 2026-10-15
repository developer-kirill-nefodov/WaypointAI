import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ImportJobRunner, MAX_ACTIVE_JOBS_PER_WORKSPACE } from "../src/services/import-jobs.ts";
import { importOsmArea, osmAreaSourceId } from "../src/services/osm-area-import.ts";
import { overpassQuery, parseOverpassElements, tilesFor } from "../src/sources/osm/osm-area.ts";
import { ImportCooldownError } from "../src/services/event-import.ts";
import { createInvestigationsRouter } from "../src/api/investigations.ts";
import { deleteDataset, isDeletableDataset } from "../src/services/dataset-delete.ts";
import { errorHandler } from "../src/api/error-handler.ts";

function memoryStore() {
  const jobs = new Map();
  return {
    jobs,
    async save(job) { jobs.set(job.id, structuredClone(job)); },
    async get(id, workspaceId) { const job = jobs.get(id); return job?.workspaceId === workspaceId ? structuredClone(job) : null; },
    async list(workspaceId, { active, limit }) {
      return [...jobs.values()].filter((job) => job.workspaceId === workspaceId && (!active || job.status === "running")).slice(0, limit);
    },
    async failInterrupted() { return 0; },
    async clearFinished(workspaceId) {
      const finished = [...jobs.values()].filter((job) => job.workspaceId === workspaceId && job.status !== "running");
      for (const job of finished) jobs.delete(job.id);
      return finished.length;
    },
  };
}
const outcome = (sourceId) => ({ runId: `run-${sourceId}`, fetched: 4, inserted: 3, updated: 1, linkedPlaces: 2, warning: null });
/** Event jobs whose sources run through `run`; labels are the upper-cased IDs. */
const kinds = (run, extra = {}) => ({
  events: { sources: ({ sourceIds }) => sourceIds.map((sourceId) => ({ sourceId, label: sourceId.toUpperCase() })), run: (params, sourceId, context) => run(sourceId, context) },
  osm_area: { exclusive: true, sources: ({ label }) => [{ sourceId: `osm-area-${label}`, label }], run: extra.osm ?? (async (params, sourceId) => outcome(sourceId)) },
  osm_region: { exclusive: true, sources: ({ regionId, label }) => [{ sourceId: `osm-region-${regionId}`, label }], run: async (params, sourceId) => outcome(sourceId) },
  dataset_delete: { sources: ({ datasetId, label }) => [{ sourceId: datasetId, label }], run: extra.remove ?? (async (params, sourceId) => outcome(sourceId)) },
});
const events = (sourceIds, days = 1) => ({ kind: "events", sourceIds, days });
const settle = (store, id) => new Promise((resolve) => {
  const check = () => (store.jobs.get(id)?.status !== "running" ? resolve(store.jobs.get(id)) : setTimeout(check, 5));
  check();
});

test("runs the sources of a job in order, reports progress, and keeps per-source results", async () => {
  const store = memoryStore();
  const published = [];
  const order = [];
  const runner = new ImportJobRunner({
    store,
    publish: (job) => published.push(job),
    kinds: kinds(async (sourceId, { onProgress }) => {
      order.push(sourceId);
      onProgress({ phase: "fetching", fraction: 0.4, fetched: 2, stepsDone: 2, stepsTotal: 5, windowStart: new Date("2026-10-10T00:00:00Z") });
      onProgress({ phase: "done", fraction: 1, fetched: 4, stepsDone: 5, stepsTotal: 5 });
      return outcome(sourceId);
    }),
  });
  const job = await runner.start("demo", events(["a", "b"], 5));
  assert.equal(job.status, "running");
  assert.deepEqual(job.sources.map((source) => [source.sourceId, source.label, source.status]), [["a", "A", "pending"], ["b", "B", "pending"]]);
  const finished = await settle(store, job.id);
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.progress, 1);
  assert.deepEqual(finished.sources.map((source) => [source.status, source.inserted, source.linkedPlaces, source.runId]), [["succeeded", 3, 2, "run-a"], ["succeeded", 3, 2, "run-b"]]);
  // Fetch-window updates are throttled; the day being fetched is still kept on the source.
  assert.equal(finished.sources[0].windowStart, "2026-10-10T00:00:00.000Z");
  assert.deepEqual([finished.sources[0].stepsDone, finished.sources[0].stepsTotal], [5, 5]);
  assert.ok(published.some((update) => update.sources[0].status === "running"));
  assert.equal(published.at(-1).status, "succeeded");
});

test("a failing source makes the job partial and keeps its error and retry time", async () => {
  const store = memoryStore();
  const runner = new ImportJobRunner({
    store,
    publish: () => {},
    kinds: kinds(async (sourceId) => {
      if (sourceId === "b") throw new ImportCooldownError(120);
      return outcome(sourceId);
    }),
  });
  const job = await runner.start("demo", events(["a", "b"]));
  const finished = await settle(store, job.id);
  assert.equal(finished.status, "partial");
  assert.deepEqual([finished.sources[1].status, finished.sources[1].errorCode, finished.sources[1].retryAfterSeconds], ["failed", "import_cooldown", 120]);
});

test("cancelling stops the running source and skips the rest", async () => {
  const store = memoryStore();
  const runner = new ImportJobRunner({
    store,
    publish: () => {},
    kinds: kinds((sourceId, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError"))))),
  });
  const job = await runner.start("demo", events(["a", "b"]));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runner.cancel(job.id), true);
  const finished = await settle(store, job.id);
  assert.equal(finished.status, "cancelled");
  assert.deepEqual(finished.sources.map((source) => source.status), ["cancelled", "cancelled"]);
  assert.equal(runner.cancel(job.id), false);
});

test("limits the number of active jobs per workspace", async () => {
  const store = memoryStore();
  const never = () => new Promise(() => {});
  const runner = new ImportJobRunner({ store, publish: () => {}, kinds: kinds(never, { osm: never }) });
  for (let index = 0; index < MAX_ACTIVE_JOBS_PER_WORKSPACE; index += 1) await runner.start("demo", events([`s${index}`]));
  await assert.rejects(runner.start("demo", events(["s9"])), { code: "too_many_import_jobs" });
  await assert.rejects(runner.start("other", events(["s0"])), { code: "dataset_busy" });
  // An exclusive kind runs once at a time across workspaces.
  await runner.start("other", { kind: "osm_area", label: "x", bbox: [1, 1, 2, 2], countryCode: null, categories: ["museum"] });
  await assert.rejects(runner.start("third", { kind: "osm_area", label: "y", bbox: [1, 1, 2, 2], countryCode: null, categories: ["museum"] }), { code: "import_kind_busy" });
  // A dataset that a running job imports into cannot be deleted meanwhile.
  assert.equal(runner.isSourceBusy("osm-area-x"), true);
  await assert.rejects(runner.start("third", { kind: "dataset_delete", datasetId: "osm-area-x", label: "x" }), { code: "dataset_busy" });
});

test("only datasets imported from the app can be deleted", () => {
  for (const id of ["osm-area-krakow", "osm-region-liechtenstein"]) assert.equal(isDeletableDataset(id), true, id);
  for (const id of ["osm-de-berlin", "osm-it-centro", "ingv-fdsn", "demo-seismic-synthetic", "osm-area-", "osm-area-x; drop"]) assert.equal(isDeletableDataset(id), false, id);
});

test("a deletion reports progress per batch, and a cancel rolls it back", async () => {
  const batches = (store) => ({
    async countPlaces() { return 12; },
    async deleteDataset(datasetId, onBatch) {
      // A transaction: rows are removed only when every batch went through.
      for (const done of [5, 10, 12]) onBatch(done);
      store.deleted.push(datasetId);
      return 12;
    },
  });
  const removed = { deleted: [] };
  const progress = [];
  const outcome = await deleteDataset({ datasetId: "osm-area-wien", store: batches(removed), signal: new AbortController().signal, onProgress: (value) => progress.push(value) });
  assert.deepEqual(removed.deleted, ["osm-area-wien"]);
  assert.equal(outcome.fetched, 12);
  assert.equal(outcome.runId, null);
  assert.deepEqual(progress.map((value) => value.stepsDone), [0, 5, 10, 12]);
  assert.ok(progress.every((value) => value.fraction <= 0.95));

  const cancelled = { deleted: [] };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(deleteDataset({ datasetId: "osm-area-wien", store: batches(cancelled), signal: controller.signal, onProgress: () => {} }), /import_cancelled/);
  assert.deepEqual(cancelled.deleted, []);
  await assert.rejects(deleteDataset({ datasetId: "osm-de-berlin", store: batches(cancelled), signal: new AbortController().signal, onProgress: () => {} }), { code: "dataset_not_deletable" });
});

test("the imports API validates requests, scopes jobs to a workspace, and stays off when imports are disabled", async () => {
  const store = memoryStore();
  const started = [];
  const runner = { start: async (workspaceId, params) => { started.push([workspaceId, params]); const job = { id: "8b0e7c1e-5f0a-4a51-9a51-0c6a39a5e002", workspaceId, status: "running", params, progress: 0, sources: [], createdAt: "", updatedAt: "", finishedAt: null }; await store.save(job); return job; }, cancel: () => true };
  const listen = (importEnabled) => {
    const app = express();
    app.use(express.json());
    app.use("/inv", createInvestigationsRouter({ searchEvents: async () => ({}), getEventDetails: async () => null, getEntityDetails: async () => null, getSources: async () => [], importEnabled, startImport: async () => "run", runQuery: async () => ({}), imports: { runner, store, cooldowns: async () => ({ "ingv-fdsn": 120 }), findRegion: async (id) => (id === "malopolskie" ? { id, name: "Małopolskie", path: [], countryCode: "PL", pbfUrl: "https://download.geofabrik.de/x.pbf" } : null), findDataset: async (id) => (id === "osm-area-wien" ? { id, label: "OpenStreetMap: Wien (Overpass)" } : null), clearHistory: (workspaceId) => store.clearFinished(workspaceId) } }));
    app.use(errorHandler);
    return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  };
  const server = await listen(true);
  const url = `http://127.0.0.1:${server.address().port}/inv`;
  const post = (path, body) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/imports", { sourceIds: ["ingv-fdsn", "ingv-fdsn"] })).status, 400);
    assert.equal((await post("/imports", { sourceIds: ["https://evil.example"] })).status, 400);
    assert.equal((await post("/imports", { sourceIds: ["ingv-fdsn"], days: 31 })).status, 400);
    assert.equal((await post("/imports", { sourceIds: ["ingv-fdsn"], sql: "x" })).status, 400);
    const accepted = await post("/imports", { sourceIds: ["ingv-fdsn", "demo-seismic-synthetic"], days: 3 });
    assert.equal(accepted.status, 202);
    assert.deepEqual(started, [["demo", { kind: "events", sourceIds: ["ingv-fdsn", "demo-seismic-synthetic"], days: 3 }]]);
    const area = { kind: "osm_area", label: "Kraków", bbox: [19.79, 49.97, 20.22, 50.13], countryCode: "PL", categories: ["museum", "park", "museum"] };
    assert.equal((await post("/imports", area)).status, 202);
    assert.deepEqual(started.at(-1), ["demo", { kind: "osm_area", label: "Kraków", bbox: [19.79, 49.97, 20.22, 50.13], countryCode: "PL", categories: ["museum", "park"] }]);
    const tooLarge = await post("/imports", { ...area, bbox: [10, 40, 13, 43] });
    assert.deepEqual([tooLarge.status, (await tooLarge.json()).error], [400, "area_too_large"]);
    assert.equal((await post("/imports", { ...area, categories: ["casino"] })).status, 400);
    assert.equal((await post("/imports", { ...area, url: "https://evil.example" })).status, 400);
    // A region comes from the catalogue: its name and country are not taken from the request.
    assert.equal((await post("/imports", { kind: "osm_region", regionId: "malopolskie" })).status, 202);
    assert.deepEqual(started.at(-1), ["demo", { kind: "osm_region", regionId: "malopolskie", label: "Małopolskie", countryCode: "PL" }]);
    assert.equal((await post("/imports", { kind: "osm_region", regionId: "nowhere" })).status, 400);
    assert.equal((await post("/imports", { kind: "osm_region", regionId: "malopolskie", label: "Spoofed" })).status, 400);
    assert.equal((await post("/imports", { kind: "osm_region", regionId: "../../etc" })).status, 400);
    // A deletion names only an imported dataset; its label comes from the database, and built-in datasets are refused.
    assert.equal((await post("/imports", { kind: "dataset_delete", datasetId: "osm-area-wien" })).status, 202);
    assert.deepEqual(started.at(-1), ["demo", { kind: "dataset_delete", datasetId: "osm-area-wien", label: "OpenStreetMap: Wien (Overpass)" }]);
    assert.deepEqual([(await post("/imports", { kind: "dataset_delete", datasetId: "osm-de-berlin" })).status], [403]);
    assert.equal((await post("/imports", { kind: "dataset_delete", datasetId: "osm-area-nowhere" })).status, 404);
    assert.equal((await post("/imports", { kind: "dataset_delete", datasetId: "osm-area-wien", label: "x" })).status, 400);
    const { job } = await accepted.json();
    const listed = await (await fetch(`${url}/imports?active=true`)).json();
    assert.equal(listed.jobs.length, 1);
    assert.deepEqual(listed.cooldowns, { "ingv-fdsn": 120 });
    assert.equal((await fetch(`${url}/imports/${job.id}`)).status, 200);
    assert.equal((await fetch(`${url}/imports/${job.id}?workspaceId=other`)).status, 404);
    assert.deepEqual(await (await post(`/imports/${job.id}/cancel`, {})).json(), { cancelled: true });
    assert.equal((await fetch(`${url}/imports?limit=500`)).status, 400);
    // Clearing the history removes finished jobs only.
    await store.save({ ...job, id: "8b0e7c1e-5f0a-4a51-9a51-0c6a39a5e003", status: "succeeded" });
    assert.deepEqual(await (await post("/imports/history/clear", {})).json(), { removed: 1 });
    assert.equal(store.jobs.size, 1);
  } finally { server.close(); }
  const disabled = await listen(false);
  try {
    const response = await fetch(`http://127.0.0.1:${disabled.address().port}/inv/imports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceIds: ["ingv-fdsn"] }) });
    assert.equal(response.status, 403);
  } finally { disabled.close(); }
});

test("Overpass areas are fetched in tiles and parsed into named places of the chosen kinds", () => {
  assert.equal(tilesFor([19.8, 49.95, 20.25, 50.1]).length, 2);
  const query = overpassQuery([19.8, 49.95, 20.05, 50.1], ["museum", "park"]);
  assert.match(query, /nwr\["tourism"~"\^\(museum\)\$"\]\["name"\]\(49.95,19.8,50.1,20.05\);/);
  assert.match(query, /nwr\["place"~"\^\(city\|town\|village\|suburb\)\$"\]/);
  // Synthetic elements in the Overpass JSON shape.
  const places = parseOverpassElements(JSON.stringify({ elements: [
    { type: "node", id: 1, lat: 50.06, lon: 19.94, tags: { name: "Synthetic Museum", tourism: "museum", "addr:city": "Testopolis" } },
    { type: "way", id: 2, center: { lat: 50.05, lon: 19.93 }, tags: { name: "Synthetic Park", leisure: "park" } },
    { type: "node", id: 3, lat: 50.06, lon: 19.94, tags: { name: "Testopolis", place: "city" } },
    { type: "node", id: 4, lat: 50.0, lon: 19.9, tags: { tourism: "museum" } },
    { type: "way", id: 5, tags: { name: "No center", tourism: "museum" } },
  ] }), "PL");
  assert.deepEqual(places.map((place) => [place.id, place.category, place.countryCode]), [["osm:node:1", "tourism:museum", "PL"], ["osm:way:2", "leisure:park", "PL"], ["osm:node:3", "place:city", "PL"]]);
  assert.throws(() => parseOverpassElements("<html>", null), { code: "upstream_malformed" });
});

test("an area import fetches every tile before writing and audits the run", async () => {
  const calls = [];
  const store = {
    registerAreaSource: async (input) => calls.push(["register", input.sourceId, input.label]),
    startRun: async (sourceId) => { calls.push(["start", sourceId]); return "run-1"; },
    upsertPlaces: async (sourceId, places) => { calls.push(["upsert", places.length]); return { inserted: places.length, updated: 0 }; },
    finishRun: async (runId, outcome) => calls.push(["finish", outcome.status, outcome.errorCode]),
  };
  const progress = [];
  const place = (id) => ({ id: `osm:node:${id}`, osmType: "node", osmId: String(id), name: `Synthetic ${id}`, category: "tourism:museum", countryCode: "PL", region: null, city: null, postcode: null, street: null, houseNumber: null, lat: 50, lon: 20, tags: {} });
  const base = { sourceId: osmAreaSourceId("Kraków"), label: "Kraków", bbox: [19.8, 49.95, 20.25, 50.1], countryCode: "PL", categories: ["museum"], sourceUrl: "https://overpass-api.de/api/interpreter", store, sleep: async () => {}, onProgress: (item) => progress.push(item) };
  assert.equal(base.sourceId, "osm-area-krakow");
  const result = await importOsmArea({ ...base, signal: new AbortController().signal, fetchTile: async (tile) => [place(1), place(tile[0] > 20 ? 2 : 1)] });
  assert.deepEqual([result.fetched, result.inserted], [2, 2]);
  assert.deepEqual(calls.map((call) => call[0]), ["start", "register", "upsert", "finish"]);
  assert.deepEqual(progress.map((item) => item.phase), ["fetching", "fetching", "saving", "done"]);

  calls.length = 0;
  const controller = new AbortController();
  await assert.rejects(importOsmArea({ ...base, signal: controller.signal, fetchTile: async () => { controller.abort(); return [place(1)]; } }));
  assert.deepEqual(calls, [["start", "osm-area-krakow"], ["finish", "failed", "import_cancelled"]]);
});

test("the Geofabrik catalogue gives plain names, parent paths, and inherited country codes", async () => {
  const { parseGeofabrikIndex, searchRegions, isGeofabrikUrl, childRegions, regionsForPlace } = await import("../src/sources/osm/geofabrik.ts");
  const index = JSON.stringify({ features: [
    { properties: { id: "europe", name: "Europe", urls: { pbf: "https://download.geofabrik.de/europe-latest.osm.pbf" } } },
    { properties: { id: "poland", parent: "europe", name: "Poland", "iso3166-1:alpha2": ["PL"], urls: { pbf: "https://download.geofabrik.de/europe/poland-latest.osm.pbf" } } },
    { properties: { id: "malopolskie", parent: "poland", name: "Województwo małopolskie<br />(Lesser Poland Voivodeship)", urls: { pbf: "https://download.geofabrik.de/europe/poland/malopolskie-latest.osm.pbf" } } },
    { properties: { id: "italy", parent: "europe", name: "Italy", "iso3166-1:alpha2": ["IT"], urls: { pbf: "https://download.geofabrik.de/europe/italy-latest.osm.pbf" } } },
    { properties: { id: "nord-ovest", parent: "italy", name: "Nord-Ovest", "iso3166-2": ["IT-25", "IT-42", "IT-21", "IT-23"], urls: { pbf: "https://download.geofabrik.de/europe/italy/nord-ovest-latest.osm.pbf" } } },
    { properties: { id: "evil", name: "Evil", urls: { pbf: "https://evil.example/x.osm.pbf" } } },
  ] });
  const regions = parseGeofabrikIndex(index);
  assert.deepEqual(regions.map((region) => region.id).sort(), ["europe", "italy", "malopolskie", "nord-ovest", "poland"]);
  const malopolskie = regions.find((region) => region.id === "malopolskie");
  assert.equal(malopolskie.name, "Województwo małopolskie (Lesser Poland Voivodeship)");
  assert.deepEqual(malopolskie.path, ["Europe", "Poland"]);
  assert.equal(malopolskie.countryCode, "PL");
  assert.deepEqual(searchRegions(regions, "lesser poland").map((region) => region.id), ["malopolskie"]);
  assert.deepEqual(searchRegions(regions, "malopolskie").map((region) => region.id), ["malopolskie"]);
  // A country is found by its name in other languages; its subregions are not.
  for (const name of ["Polska", "Польша", "polen"]) assert.deepEqual(searchRegions(regions, name).map((region) => region.id), ["poland"], name);
  assert.deepEqual(searchRegions(regions, "Italia").map((region) => region.id), ["italy"]);
  // Browsing: Europe's countries, then a country's regions.
  assert.deepEqual(childRegions(regions, null).map((region) => [region.id, region.hasChildren]), [["italy", true], ["poland", true]]);
  assert.deepEqual(childRegions(regions, "italy").map((region) => region.id), ["nord-ovest"]);
  // A place's ISO codes, then its local names within the country, then the country.
  assert.deepEqual(regionsForPlace(regions, { codes: ["IT-25", "IT"], names: [] }).map((region) => region.id), ["nord-ovest"]);
  assert.deepEqual(regionsForPlace(regions, { codes: ["PL-12", "PL"], names: ["Kraków", "województwo małopolskie"] }).map((region) => region.id), ["malopolskie"]);
  assert.deepEqual(regionsForPlace(regions, { codes: ["IT-82", "IT"], names: ["Sicilia"] }).map((region) => region.id), ["italy"]);
  const bavaria = parseGeofabrikIndex(JSON.stringify({ features: [
    { properties: { id: "europe", name: "Europe", urls: { pbf: "https://download.geofabrik.de/europe-latest.osm.pbf" } } },
    { properties: { id: "germany", parent: "europe", name: "Germany", "iso3166-1:alpha2": ["DE"], urls: { pbf: "https://download.geofabrik.de/europe/germany-latest.osm.pbf" } } },
    { properties: { id: "bayern", parent: "germany", name: "Bayern", urls: { pbf: "https://download.geofabrik.de/europe/germany/bayern-latest.osm.pbf" } } },
    { properties: { id: "niederbayern", parent: "bayern", name: "Niederbayern", urls: { pbf: "https://download.geofabrik.de/europe/germany/bayern/niederbayern-latest.osm.pbf" } } },
    { properties: { id: "oberbayern", parent: "bayern", name: "Oberbayern", urls: { pbf: "https://download.geofabrik.de/europe/germany/bayern/oberbayern-latest.osm.pbf" } } },
  ] }));
  assert.deepEqual(regionsForPlace(bavaria, { codes: ["DE-BY", "DE"], names: ["Bayern"] }).map((region) => region.id), ["bayern", "niederbayern", "oberbayern"]);
  assert.deepEqual(regionsForPlace(bavaria, { codes: ["DE-BY", "DE"], names: ["München", "Oberbayern", "Bayern"] }).map((region) => region.id)[0], "oberbayern");
  assert.deepEqual(regionsForPlace(regions, { codes: ["XX-1"], names: ["Nowhere"] }), []);
  assert.equal(isGeofabrikUrl("https://download.geofabrik.de/a.pbf"), true);
  assert.equal(isGeofabrikUrl("http://download.geofabrik.de/a.pbf"), false);
  assert.equal(isGeofabrikUrl("https://download.geofabrik.de.evil.example/a.pbf"), false);
});

test("a region import downloads, parses in steps, and audits the run; a cancel records it", async () => {
  const { importOsmRegion, osmRegionSourceId } = await import("../src/services/osm-region-import.ts");
  const runs = [];
  const store = { startRun: async () => "run-r", finishRun: async (runId, outcome) => runs.push([outcome.status, outcome.inserted, outcome.errorCode]) };
  const region = { id: "malopolskie", name: "Małopolskie", path: [], countryCode: "PL", pbfUrl: "https://download.geofabrik.de/europe/poland/malopolskie-latest.osm.pbf" };
  const progress = [];
  const result = await importOsmRegion({
    region, sourceId: osmRegionSourceId(region.id), file: "/tmp/never-written.pbf", store, signal: new AbortController().signal,
    onProgress: (item) => progress.push([item.phase, Math.round(item.fraction * 100)]),
    download: async (onBytes) => { onBytes(50, 100); onBytes(100, 100); return { bytes: 100 }; },
    parse: async (onParse) => { onParse({ phase: "parsing", bytesRead: 50, totalBytes: 100, imported: 10 }); return { imported: 20, skipped: 3, snapshotDate: "2026-10-14" }; },
  });
  assert.equal(osmRegionSourceId("malopolskie"), "osm-region-malopolskie");
  assert.deepEqual([result.inserted, result.fetched], [20, 20]);
  assert.deepEqual(progress.map(([phase]) => phase), ["fetching", "fetching", "fetching", "saving", "done"]);
  assert.ok(progress.every(([, fraction], index) => index === 0 || fraction >= progress[index - 1][1]), "progress never goes back");
  assert.deepEqual(runs, [["succeeded", 20, null]]);

  const controller = new AbortController();
  await assert.rejects(importOsmRegion({
    region, sourceId: "osm-region-malopolskie", file: "/tmp/x.pbf", store, signal: controller.signal, onProgress: () => {},
    download: async () => { controller.abort(); throw new DOMException("cancelled", "AbortError"); },
    parse: async () => ({ imported: 0, skipped: 0, snapshotDate: null }),
  }));
  assert.deepEqual(runs.at(-1), ["failed", 0, "import_cancelled"]);
});
