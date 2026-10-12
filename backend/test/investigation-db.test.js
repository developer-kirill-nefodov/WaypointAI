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
