/**
 * PostgreSQL integration tests for the investigation data path. They need a disposable database:
 *   TEST_DATABASE_URL=postgres://waypoint:waypoint_dev@127.0.0.1:5433/waypoint_test npm run test:db
 * The suite creates the database if needed, applies migrations, and deletes rows only in that database.
 * Without TEST_DATABASE_URL every test is skipped. All fixtures are synthetic.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const testUrl = process.env.TEST_DATABASE_URL;
const skip = testUrl ? false : "TEST_DATABASE_URL is not set";
if (testUrl) {
  const name = new URL(testUrl).pathname.slice(1);
  // Refuse to run against anything that does not look like a disposable test database.
  if (!/test/i.test(name) || testUrl === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must name a separate *test* database");
  process.env.DATABASE_URL = testUrl;
}

let modules;
const SOURCE_ID = "test-seismic";
const PLACE_SOURCE_ID = "test-osm";
const now = new Date("2026-10-13T12:00:00Z");

before(async () => {
  if (skip) return;
  await ensureDatabase(testUrl);
  execFileSync("npx", ["sequelize-cli", "db:migrate", "--env", "test"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: "pipe",
  });
  modules = {
    store: (await import("../src/data/event-import.repository.ts")).sqlEventImportStore,
    importService: await import("../src/services/event-import.ts"),
    repo: await import("../src/data/investigation.repository.ts"),
    settlements: await import("../src/data/settlement.repository.ts"),
    database: (await import("../src/database/client.ts")).database,
    conversations: await import("../src/data/conversation.repository.ts"),
    places: await import("../src/data/record.repository.ts"),
    importJobs: (await import("../src/data/import-job.repository.ts")).sqlImportJobStore,
    datasets: await import("../src/data/dataset.repository.ts"),
    training: await import("../src/data/training.repository.ts"),
    teacher: await import("../src/data/teacher.repository.ts"),
  };
  await resetData();
});

after(async () => {
  if (modules) await modules.database.close();
});

async function ensureDatabase(url) {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  await client.end();
}

async function sql(query, bind = []) {
  const [rows] = await modules.database.query(query, { bind });
  return rows;
}

async function resetData() {
  await sql("DELETE FROM record_place_links");
  await sql("DELETE FROM source_sync_runs");
  await sql("DELETE FROM records");
  await sql("DELETE FROM places");
  await sql("DELETE FROM data_sources");
  await sql("INSERT INTO data_sources (id, label, mode, status) VALUES ($1, 'Synthetic places', 'synthetic_local', 'ready')", [PLACE_SOURCE_ID]);
  const places = [
    ["p-city", "Testopoli", "place:city", 42.0, 13.0, { "name:en": "Testopolis" }],
    ["p-village", "Testopoli", "place:village", 41.0, 12.0, {}],
    ["p-near-1", "Synthetic Peak", "natural:peak", 42.001, 13.001, {}],
    ["p-near-2", "Synthetic Spring", "natural:spring", 42.01, 13.0, {}],
    ["p-far", "Synthetic Far Hut", "tourism:alpine_hut", 42.2, 13.0, {}],
  ];
  for (const [id, name, category, lat, lon, tags] of places) {
    await sql(
      `INSERT INTO places (id, source_id, osm_type, osm_id, name, category, country_code, lat, lon, tags, import_token)
       VALUES ($1, $2, 'node', $1, $3, $4, 'IT', $5, $6, $7::jsonb, 'test')`,
      [id, PLACE_SOURCE_ID, name, category, lat, lon, JSON.stringify(tags)],
    );
  }
}

function event(externalId, overrides = {}) {
  return {
    externalId,
    observedAt: new Date("2026-10-12T10:00:00Z"),
    lat: 42.0,
    lon: 13.0,
    category: "seismic:earthquake",
    revision: "1",
    attributes: { label: `Synthetic ${externalId}`, magnitude: 2 },
    ...overrides,
  };
}

function adapter(events) {
  return {
    descriptor: { id: SOURCE_ID, label: "Synthetic test events", mode: "synthetic_local", license: "CC0-1.0", attribution: "test", sourceUrl: null },
    fetchEvents: async () => ({ events, skipped: 0, truncated: false }),
  };
}

const runImport = (events, offsetMinutes = 0) => modules.importService.importEvents({
  adapter: adapter(events),
  store: modules.store,
  days: 7,
  cooldownSeconds: 0,
  now: new Date(now.getTime() + offsetMinutes * 60_000),
});

test("imports idempotently, updates only revised events, and records sync runs", { skip }, async () => {
  const first = await runImport([event("1"), event("2", { lat: 42.5 })]);
  assert.deepEqual(first.counts, { fetched: 2, inserted: 2, updated: 0, skipped: 0 });
  const second = await runImport([event("1"), event("2", { lat: 42.5 })], 1);
  assert.deepEqual(second.counts, { fetched: 2, inserted: 0, updated: 0, skipped: 2 });
  const third = await runImport([event("1", { revision: "2", attributes: { label: "Revised", magnitude: 2.4 } }), event("2", { lat: 42.5 })], 2);
  assert.deepEqual(third.counts, { fetched: 2, inserted: 0, updated: 1, skipped: 1 });

  const rows = await sql("SELECT id, external_id, source_revision, attributes->>'magnitude' AS magnitude FROM records ORDER BY id");
  assert.deepEqual(rows.map((row) => [row.id, row.external_id, row.source_revision, row.magnitude]), [
    [`${SOURCE_ID}:1`, "1", "2", "2.4"],
    [`${SOURCE_ID}:2`, "2", "1", "2"],
  ]);
  const runs = await sql("SELECT status, inserted_count, updated_count, skipped_count FROM source_sync_runs ORDER BY started_at");
  assert.deepEqual(runs.map((run) => [run.status, run.inserted_count, run.updated_count, run.skipped_count]), [
    ["succeeded", 2, 0, 0],
    ["succeeded", 0, 0, 2],
    ["succeeded", 0, 1, 1],
  ]);
});

test("links events to the nearest places within 5 km and cascades deletions", { skip }, async () => {
  const links = await sql(`SELECT place_id, distance_meters FROM record_place_links WHERE record_id = $1 ORDER BY distance_meters`, [`${SOURCE_ID}:1`]);
  // Event 1 sits on Testopoli; the far hut (22 km) and the other Testopoli (140 km) are excluded.
  assert.deepEqual(links.map((link) => link.place_id), ["p-city", "p-near-1", "p-near-2"]);
  assert.equal(links[0].distance_meters, 0);
  assert.ok(links[1].distance_meters > 100 && links[1].distance_meters < 200);
  assert.equal((await sql("SELECT count(*)::int AS n FROM record_place_links WHERE record_id = $1", [`${SOURCE_ID}:2`]))[0].n, 0);

  await sql("DELETE FROM places WHERE id = 'p-near-2'");
  assert.equal((await sql("SELECT count(*)::int AS n FROM record_place_links WHERE place_id = 'p-near-2'"))[0].n, 0);
});

test("finds events without nearby-place links so a later run can link them", { skip }, async () => {
  await sql("DELETE FROM record_place_links WHERE record_id = $1", [`${SOURCE_ID}:1`]);
  const window = { start: new Date("2026-10-12T00:00:00Z"), end: new Date("2026-10-13T00:00:00Z") };
  const unlinked = await modules.store.findUnlinkedRecordIds(SOURCE_ID, window);
  assert.ok(unlinked.includes(`${SOURCE_ID}:1`));
  assert.ok(await modules.store.linkNearbyPlaces([`${SOURCE_ID}:1`]) > 0);
  assert.ok(!(await modules.store.findUnlinkedRecordIds(SOURCE_ID, window)).includes(`${SOURCE_ID}:1`));
});

test("allows only one running import per source", { skip }, async () => {
  // Later than the imports above, so this run is the latest one for the source.
  const startedAt = new Date(now.getTime() + 5 * 60_000);
  const window = { start: new Date(startedAt.getTime() - 3_600_000), end: startedAt };
  const runId = await modules.store.startRun(SOURCE_ID, window, startedAt);
  await assert.rejects(modules.store.startRun(SOURCE_ID, window, startedAt), { code: "import_running" });
  await modules.store.finishRun(runId, { status: "failed", counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 }, errorCode: "upstream_unavailable", finishedAt: startedAt });
  const summary = (await modules.repo.getSyncSummaries([SOURCE_ID])).get(SOURCE_ID);
  assert.equal(summary.status, "failed");
  assert.equal(summary.errorCode, "upstream_unavailable");
  assert.ok(summary.lastSucceededAt, "the last successful run is still reported");
});

test("searches by window, exact radius, and numeric magnitude without failing on malformed attributes", { skip }, async () => {
  await sql("DELETE FROM records");
  const base = Date.parse("2026-10-12T00:00:00Z");
  const insert = (id, lat, lon, minutes, magnitude) => sql(
    `INSERT INTO records (id, source_id, external_id, observed_at, lat, lon, category, attributes)
     VALUES ($1, $2, $1, $3, $4, $5, 'seismic:earthquake', $6::jsonb)`,
    [id, SOURCE_ID, new Date(base + minutes * 60_000), lat, lon, JSON.stringify({ magnitude, label: id })],
  );
  await insert("center", 42.0, 13.0, 0, 3.1);
  await insert("inside", 42.08, 13.0, 10, 1.2);        // ~8.9 km north
  await insert("corner", 42.085, 13.115, 20, 2.0);     // inside the 10 km bbox, ~13 km away
  await insert("old", 42.0, 13.0, -60 * 24 * 10, 4.0); // outside the window
  await insert("weird", 42.0, 13.0, 30, "strong");     // non-numeric magnitude

  const window = { from: new Date(base - 86_400_000), to: new Date(base + 86_400_000) };
  const near = await modules.repo.searchEvents({ ...window, near: { lat: 42.0, lon: 13.0, radiusMeters: 10_000 }, limit: 50 });
  assert.deepEqual(near.events.map((item) => item.id).sort(), ["center", "inside", "weird"]);
  assert.equal(near.events.find((item) => item.id === "inside").distanceMeters, 8896);
  // The range covers every match and skips the non-numeric magnitude.
  assert.deepEqual(near.magnitudeRange, { min: 1.2, max: 3.1 });

  const strong = await modules.repo.searchEvents({ ...window, minMagnitude: 2, limit: 50 });
  assert.deepEqual(strong.events.map((item) => item.id), ["corner", "center"]);
  assert.equal(strong.total, 2);
});

test("keyset pagination returns every row once even when timestamps tie", { skip }, async () => {
  await sql("DELETE FROM records");
  const tied = new Date("2026-10-12T10:00:00Z");
  for (let index = 0; index < 23; index += 1) {
    await sql(
      `INSERT INTO records (id, source_id, external_id, observed_at, lat, lon, category, attributes)
       VALUES ($1, $2, $1, $3, 42, 13, 'seismic:earthquake', '{}'::jsonb)`,
      [`e${String(index).padStart(2, "0")}`, SOURCE_ID, index < 10 ? tied : new Date(tied.getTime() - index * 60_000)],
    );
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await modules.repo.searchEvents({ from: new Date("2026-10-11T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z"), limit: 4, cursor });
    assert.equal(page.total, 23);
    seen.push(...page.events.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < 20);
  assert.equal(pages, 6);
  assert.equal(seen.length, 23);
  assert.equal(new Set(seen).size, 23);
  // Ten rows share the newest timestamp; the id tie-breaker orders them.
  assert.deepEqual(seen.slice(0, 10), ["e00", "e01", "e02", "e03", "e04", "e05", "e06", "e07", "e08", "e09"]);
});

test("returns event and entity details with links and provenance", { skip }, async () => {
  await runImport([event("detail", { revision: "x" })], 10);
  const details = await modules.repo.getEventDetails(`${SOURCE_ID}:detail`);
  assert.equal(details.event.label, "Synthetic detail");
  assert.deepEqual(details.linkedPlaces.map((link) => link.place.id), ["p-city", "p-near-1"]);
  assert.deepEqual(details.sources.map((source) => source.id).sort(), [PLACE_SOURCE_ID, SOURCE_ID]);
  assert.equal(details.lastSync.status, "succeeded");

  // Earlier unlinked fixture rows are linked by this run too, so ask for enough linked events.
  const entity = await modules.repo.getEntityDetails("p-city", 100);
  assert.equal(entity.place.name, "Testopoli");
  assert.ok(entity.linkedEvents.some((link) => link.event.id === `${SOURCE_ID}:detail`));
  assert.equal(await modules.repo.getEventDetails("missing"), null);
});

test("resolves settlements by exact local or English name, preferring larger places", { skip }, async () => {
  assert.equal((await modules.settlements.resolveSettlement("testopoli")).id, "p-city");
  assert.equal((await modules.settlements.resolveSettlement("Testopolis")).id, "p-city");
  assert.equal(await modules.settlements.resolveSettlement("Synthetic Peak"), null, "non-settlements are not resolved");
  assert.equal(await modules.settlements.resolveSettlement("Nowhere"), null);
  // Close spellings resolve to cities and towns only, and are reported as approximate.
  const approximate = await modules.settlements.resolveSettlement("Testopolli");
  assert.deepEqual([approximate.id, approximate.match], ["p-city", "approximate"]);
  assert.equal((await modules.settlements.resolveSettlement("testopoli")).match, "exact");
  assert.equal(await modules.settlements.resolveSettlement("Xestopoli"), null, "the first three letters must match");
  assert.equal(await modules.settlements.resolveSettlement("Testopoli' OR '1'='1"), null);
});

test("keeps the trip plan of a conversation across turns until it is replaced or cleared", { skip }, async () => {
  const { conversations, places } = modules;
  const id = "8b0e7c1e-5f0a-4a51-9a51-0c6a39a5e001";
  const plan = {
    status: "ready", countryCode: "IT", city: "Testopoli", totalDays: 1, supportedDays: 1, travelMode: "driving", airport: null, sourceIds: [PLACE_SOURCE_ID],
    days: [{ day: 1, area: "city", stopPlaceIds: ["p-near-1", "p-near-2"], straightLineDistanceMetersFromAirport: {}, routeStatus: "pending" }],
  };
  await sql("DELETE FROM assistant_conversations WHERE workspace_id = 'test-workspace'");
  await conversations.saveConversationTurn(id, "test-workspace", [{ role: "user", content: "Plan one day" }, { role: "assistant", content: "Plan" }], plan);
  assert.deepEqual(await conversations.getConversationTripPlan(id, "test-workspace"), plan);
  assert.equal(await conversations.getConversationTripPlan(id, "other-workspace"), null);

  await conversations.saveConversationTurn(id, "test-workspace", [{ role: "user", content: "How many stops?" }, { role: "assistant", content: "Two" }]);
  assert.deepEqual(await conversations.getConversationTripPlan(id, "test-workspace"), plan, "a turn without a plan keeps the stored one");
  assert.deepEqual((await places.getPlacesByIds(["p-far", "missing", "p-near-1"])).map((place) => place.id), ["p-far", "p-near-1"]);

  await conversations.saveConversationTurn(id, "test-workspace", [{ role: "user", content: "New plan" }, { role: "assistant", content: "Which country?" }], null);
  assert.equal(await conversations.getConversationTripPlan(id, "test-workspace"), null);
  await sql("DELETE FROM assistant_conversations WHERE workspace_id = 'test-workspace'");
});

test("stores import jobs per workspace and fails the ones left running by a stopped server", { skip }, async () => {
  const { importJobs } = modules;
  await sql("DELETE FROM import_jobs WHERE workspace_id LIKE 'test-%'");
  const source = (sourceId, status) => ({ sourceId, label: sourceId, status, progress: 0.5, phase: "fetching", windowStart: null, fetched: 3, inserted: 0, updated: 0, linkedPlaces: 0, runId: null, errorCode: null, retryAfterSeconds: null });
  const job = {
    id: "8b0e7c1e-5f0a-4a51-9a51-0c6a39a5e010", workspaceId: "test-a", status: "running", params: { sourceIds: ["a", "b"], days: 3 }, progress: 0.25,
    sources: [source("a", "succeeded"), source("b", "running")], createdAt: "2026-10-15T10:00:00.000Z", updatedAt: "2026-10-15T10:00:01.000Z", finishedAt: null,
  };
  await importJobs.save(job);
  await importJobs.save({ ...job, progress: 0.5, updatedAt: "2026-10-15T10:00:02.000Z" });
  assert.equal((await importJobs.get(job.id, "test-a")).progress, 0.5);
  assert.equal(await importJobs.get(job.id, "test-b"), null);
  assert.deepEqual((await importJobs.list("test-a", { active: true, limit: 10 })).map((item) => item.id), [job.id]);
  assert.ok(await importJobs.failInterrupted() >= 1);
  const failed = await importJobs.get(job.id, "test-a");
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.sources.map((item) => [item.status, item.errorCode]), [["succeeded", null], ["failed", "import_interrupted"]]);
  assert.deepEqual(await importJobs.list("test-a", { active: true, limit: 10 }), []);
  await sql("DELETE FROM import_jobs WHERE workspace_id LIKE 'test-%'");
});

test("lists countries and settlements, and deletes an imported dataset in one transaction", { skip }, async () => {
  const { datasets } = modules;
  const AREA = "osm-area-testville";
  await sql("INSERT INTO data_sources (id, label, mode, status) VALUES ($1, 'OpenStreetMap: Testville (Overpass)', 'public_snapshot', 'ready')", [AREA]);
  const rows = [
    ["a-city", "Testville", "place:city", null], ["a-town", "Smalltown", "place:town", null],
    ["a-1", "Synthetic Museum", "tourism:museum", "Testville"], ["a-2", "Synthetic Park", "leisure:park", "Testville"], ["a-3", "Synthetic Cafe", "amenity:cafe", "Smalltown"],
  ];
  for (const [id, name, category, city] of rows) {
    await sql(`INSERT INTO places (id, source_id, osm_type, osm_id, name, category, country_code, city, lat, lon, tags, import_token)
       VALUES ($1, $2, 'node', $1, $3, $4, 'XT', $5, 10, 10, '{}'::jsonb, 'test')`, [id, AREA, name, category, city]);
  }
  const event = (await sql("SELECT id FROM records LIMIT 1"))[0];
  if (event) await sql("UPDATE records SET place_id = 'a-1' WHERE id = $1", [event.id]);

  const country = (await datasets.listCountries()).find((item) => item.countryCode === "XT");
  assert.deepEqual(country, { countryCode: "XT", places: 5, cities: 1, towns: 1, villages: 0, datasets: [AREA] });
  const listed = await datasets.listSettlements({ countryCode: "XT", types: ["city", "town", "village"], limit: 10, offset: 0 });
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.settlements.map((item) => [item.name, item.type, item.places]), [["Testville", "city", 2], ["Smalltown", "town", 1]]);
  // The search is a bound LIKE pattern; wildcards in the query match literally.
  assert.deepEqual((await datasets.listSettlements({ countryCode: "XT", query: "small", types: ["town"], limit: 10, offset: 0 })).settlements.map((item) => item.name), ["Smalltown"]);
  assert.equal((await datasets.listSettlements({ countryCode: "XT", query: "%", types: ["city", "town"], limit: 10, offset: 0 })).total, 0);
  const view = (await datasets.listDatasets()).find((item) => item.id === AREA);
  assert.deepEqual([view.places, view.countries, view.deletable], [5, ["XT"], true]);

  // Places page by name with a keyset cursor; search, category, city, and area are bound filters.
  const scope = { datasetIds: [AREA] };
  const first = await datasets.listCatalogPlaces({ ...scope, limit: 3 });
  assert.equal(first.total, 5);
  const second = await datasets.listCatalogPlaces({ ...scope, limit: 3, after: first.next });
  assert.equal(second.total, null);
  assert.equal(second.next, null);
  assert.deepEqual([...first.places, ...second.places].map((place) => place.name), ["Smalltown", "Synthetic Cafe", "Synthetic Museum", "Synthetic Park", "Testville"]);
  // Names that do not start with a letter come after the others, across pages.
  await sql(`INSERT INTO places (id, source_id, osm_type, osm_id, name, category, country_code, lat, lon, tags, import_token)
     VALUES ('a-num', $1, 'node', 'a-num', '#00012 Station', 'amenity:bicycle_rental', 'XT', 10, 10, '{}'::jsonb, 'test')`, [AREA]);
  const pages = [];
  let after;
  do {
    const page = await datasets.listCatalogPlaces({ ...scope, limit: 2, after });
    pages.push(...page.places.map((place) => place.name));
    after = page.next ?? undefined;
  } while (after);
  assert.deepEqual(pages, ["Smalltown", "Synthetic Cafe", "Synthetic Museum", "Synthetic Park", "Testville", "#00012 Station"]);
  await sql("DELETE FROM places WHERE id = 'a-num'");
  assert.deepEqual((await datasets.listCatalogPlaces({ ...scope, limit: 10, query: "MUSE" })).places.map((place) => place.id), ["a-1"]);
  assert.equal((await datasets.listCatalogPlaces({ ...scope, limit: 10, query: "_" })).total, 0);
  assert.deepEqual((await datasets.listCatalogPlaces({ ...scope, limit: 10, city: "smalltown" })).places.map((place) => place.id), ["a-3"]);
  assert.equal((await datasets.listCatalogPlaces({ ...scope, countryCode: "XT", limit: 10, bbox: [9, 9, 11, 11] })).total, 5);
  assert.equal((await datasets.listCatalogPlaces({ ...scope, limit: 10, bbox: [20, 20, 21, 21] })).total, 0);
  assert.equal((await datasets.listCatalogPlaces({ datasetIds: [PLACE_SOURCE_ID], countryCode: "XT", limit: 10 })).total, 0);
  // Categories ignore the category filter itself, so the menu keeps its other choices.
  assert.deepEqual((await datasets.listCatalogCategories({ ...scope, category: "leisure:park" })).slice(0, 1), [{ category: "amenity:cafe", places: 1 }]);
  assert.deepEqual((await datasets.listCountries(AREA)).map((item) => [item.countryCode, item.places]), [["XT", 5]]);

  // A failing batch rolls everything back.
  await assert.rejects(datasets.sqlDatasetDeleteStore.deleteDataset(AREA, () => { throw new Error("import_cancelled"); }));
  assert.equal(await datasets.sqlDatasetDeleteStore.countPlaces(AREA), 5);
  assert.equal(await datasets.sqlDatasetDeleteStore.deleteDataset(AREA, () => {}), 5);
  assert.equal(await datasets.sqlDatasetDeleteStore.countPlaces(AREA), 0);
  // Events stay, without the place; the dataset row stays for the history but is no longer listed.
  if (event) assert.equal((await sql("SELECT place_id FROM records WHERE id = $1", [event.id]))[0].place_id, null);
  assert.equal((await sql("SELECT status FROM data_sources WHERE id = $1", [AREA]))[0].status, "unavailable");
  assert.equal((await datasets.listDatasets()).some((item) => item.id === AREA), false);
  assert.equal((await datasets.listCountries()).some((item) => item.countryCode === "XT"), false);
  assert.ok((await sql("SELECT count(*)::int AS n FROM places WHERE source_id = $1", [PLACE_SOURCE_ID]))[0].n > 0);
  await sql("DELETE FROM data_sources WHERE id = $1", [AREA]);
});

test("matches events across live catalogues, reports their cross-check, merges copies, and cascades deletions", { skip }, async () => {
  // Two synthetic sources registered as live catalogues, so they take part in cross-checks.
  const live = (id, events) => ({
    descriptor: { id, label: `Synthetic live ${id}`, mode: "approved_live", license: "CC0-1.0", attribution: "test", sourceUrl: null },
    fetchEvents: async () => ({ events, skipped: 0, truncated: false }),
  });
  const quake = (externalId, seconds, overrides = {}) => event(externalId, { observedAt: new Date(Date.parse("2026-10-12T08:00:00Z") + seconds * 1000), lat: 41.5, lon: 12.5, attributes: { label: `Synthetic ${externalId}`, magnitude: 3, depthKm: 10 }, ...overrides });
  const run = (source, offsetMinutes) => modules.importService.importEvents({ adapter: source, store: modules.store, days: 7, cooldownSeconds: 0, now: new Date(now.getTime() + offsetMinutes * 60_000) });

  await run(live("test-live-a", [quake("same", 0), quake("differs", 600), quake("alone", 1200)]), 30);
  const second = await run(live("test-live-b", [quake("same", 2, { lat: 41.55 }), quake("differs", 601, { attributes: { label: "Synthetic differs", magnitude: 4.2, depthKm: 10 } })]), 31);
  assert.equal(second.matchedEvents, 2);

  const search = (extra = {}) => modules.repo.searchEvents({ from: new Date("2026-10-12T07:00:00Z"), to: new Date("2026-10-12T09:00:00Z"), sourceIds: ["test-live-a", "test-live-b"], limit: 50, ...extra });
  const statuses = Object.fromEntries((await search()).events.map((item) => [item.id, item.crossCheck.status]));
  assert.deepEqual(statuses, {
    "test-live-a:same": "confirmed", "test-live-b:same": "confirmed",
    "test-live-a:differs": "conflict", "test-live-b:differs": "conflict",
    // test-live-b was imported for this time and does not report it.
    "test-live-a:alone": "single",
  });
  // Merging keeps one copy per earthquake, from the preferred source.
  const merged = await search({ mergePriority: ["test-live-a", "test-live-b"] });
  assert.equal(merged.total, 3);
  assert.deepEqual(merged.events.map((item) => item.sourceId), ["test-live-a", "test-live-a", "test-live-a"]);
  // ...unless the preferred copy fails a filter: then the other copy is listed.
  const strong = await search({ mergePriority: ["test-live-a", "test-live-b"], minMagnitude: 4 });
  assert.deepEqual(strong.events.map((item) => item.id), ["test-live-b:differs"]);
  assert.deepEqual((await search({ crossCheck: "confirmed" })).events.map((item) => item.id).sort(), ["test-live-a:same", "test-live-b:same"]);

  const details = await modules.repo.getEventDetails("test-live-a:same");
  assert.equal(details.crossCheck.status, "confirmed");
  assert.equal(details.crossCheck.matches[0].event.id, "test-live-b:same");
  assert.equal(details.crossCheck.matches[0].timeDeltaMs, 2000);
  assert.ok(details.sources.some((source) => source.id === "test-live-b"));

  // Deleting a record removes its matches.
  await sql("DELETE FROM records WHERE source_id = 'test-live-b'");
  assert.equal((await sql("SELECT count(*)::integer AS n FROM record_matches"))[0].n, 0);
});

test("stores lessons with versions, exam cases, and runs whose totals follow their results", { skip }, async () => {
  const { training } = modules;
  await sql("DELETE FROM eval_runs");
  await sql("DELETE FROM eval_cases");
  await sql("DELETE FROM lessons");
  const rule = await training.createLesson({ kind: "rule", topic: "all", title: "Source", text: "Name the data source." });
  const example = await training.createLesson({ kind: "example", topic: "events", title: "Synthetic", text: "Events near Testopoli?", exampleTool: "search_events", exampleArgs: { place: "Testopoli" } });
  assert.deepEqual((await training.enabledLessons()).map((lesson) => lesson.id), [rule.id, example.id]);
  const edited = await training.updateLesson(rule.id, { kind: "rule", topic: "events", title: "Source", text: "Name the catalogue." });
  assert.equal(edited.version, 2);
  assert.equal((await training.updateLesson(example.id, { enabled: false })).enabled, false);
  // The enabled-lesson cache is dropped on every change.
  assert.deepEqual((await training.enabledLessons()).map((lesson) => lesson.id), [rule.id]);
  await training.markLessonsApplied([rule.id]);
  assert.equal((await training.listLessons()).find((lesson) => lesson.id === rule.id).appliedCount, 1);

  assert.equal(await training.addMissingCases([{ id: "case-a", question: "Synthetic?", language: "en", enabled: true, expect: { tool: "reply" } }]), 1);
  assert.equal(await training.addMissingCases([{ id: "case-a", question: "Changed", language: "en", enabled: true, expect: {} }]), 0);
  assert.equal((await training.listCases())[0].question, "Synthetic?");

  const run = await training.createRun({ withLessons: true, lessonIds: [rule.id], model: "test", label: null, caseCount: 2, mode: "full", caseOrigins: [] });
  const result = (caseId, passed) => ({ caseId, question: "q", passed, checks: [{ check: "tool", passed }, { check: "language", passed: true }], toolCalls: [], answer: "a", appliedLessons: [], durationMs: 5, errorCode: null, skill: "reply", language: "en" });
  await training.addResult(run.id, result("case-a", true));
  const after = await training.addResult(run.id, result("case-b", false));
  assert.deepEqual([after.casesDone, after.casesPassed, after.checksTotal, after.checksPassed, after.score], [2, 1, 4, 3, 0.75]);
  await training.finishRun(run.id, "succeeded");
  const stored = await training.getRun(run.id);
  assert.equal(stored.run.status, "succeeded");
  assert.deepEqual(stored.results.map((item) => item.caseId), ["case-a", "case-b"]);
  assert.equal(await training.deleteLesson(example.id), true);
});

test("keeps teacher batches with checked examples, accepts them into the dataset, and counts deleted ones for the limit", { skip }, async () => {
  const { teacher } = modules;
  await sql("DELETE FROM teacher_batches");
  const batch = await teacher.createBatch({ topic: "places", languages: ["en", "de"], requested: 3, model: "test", crossCheck: false });
  const example = (question, status, reasons = []) => ({ question, language: "en", call: { tool: "search_places", args: { kind: "museum", city: "Testopoli" } }, status, reasons });
  await teacher.insertExamples(batch.id, [example("Museums in Testopoli", "passed"), example("Museums in Nowhere", "rejected", [{ code: "city_unknown", detail: "Nowhere" }]), example("Museum Testopoli?", "disputed")]);
  await teacher.updateBatch(batch.id, { status: "review", usage: { promptTokens: 100, completionTokens: 50 }, finished: true });
  const stored = await teacher.getBatch(batch.id);
  assert.deepEqual(stored.counts, { passed: 1, disputed: 1, rejected: 1, edited: 0 });
  assert.equal(stored.promptTokens, 100);
  assert.deepEqual((await teacher.listExamples(batch.id)).find((item) => item.status === "rejected").reasons, [{ code: "city_unknown", detail: "Nowhere" }]);
  // Only accepted batches feed the dataset, and only examples that passed or were approved.
  assert.equal((await teacher.acceptedExamples()).length, 0);
  await teacher.updateBatch(batch.id, { status: "accepted" });
  assert.deepEqual((await teacher.acceptedExamples()).map((item) => [item.question, item.topic]), [["Museums in Testopoli", "places"]]);
  assert.equal(await teacher.deleteRejected(batch.id), 1);
  assert.deepEqual((await teacher.knownQuestions()).sort(), ["Museum Testopoli?", "Museums in Testopoli"]);
  await teacher.updateBatch(batch.id, { status: "review", generated: 1 });
  assert.equal(await teacher.generatedToday(), 4);
  assert.equal(await teacher.deleteBatch(batch.id), true);
  assert.equal(await teacher.getBatch(batch.id), null);
  assert.equal((await teacher.listBatches()).length, 0);
  // A deleted batch's examples are gone, but what it cost still counts today.
  assert.equal(await teacher.generatedToday(), 4);
  assert.equal(await teacher.deleteBatch(batch.id), false);
});
