import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import { createInvestigationsRouter } from "../src/api/investigations.ts";
import { errorHandler } from "../src/api/error-handler.ts";
import { decodeEventCursor, encodeEventCursor, parseEventSearchQuery } from "../src/api/investigation-params.ts";
import { ImportAlreadyRunningError, ImportCooldownError, startBackgroundImport } from "../src/services/event-import.ts";

const now = new Date("2026-10-13T12:00:00Z");
// Synthetic rows only.
const event = {
  id: "demo-seismic-synthetic:synthetic-001",
  sourceId: "demo-seismic-synthetic",
  observedAt: "2026-10-12T10:00:00.000Z",
  label: "M2 · Synthetic demo event 001",
  lat: 42.6,
  lon: 13.1,
  accuracyMeters: null,
  attributes: { category: "seismic:earthquake", magnitude: 2 },
};
const calls = [];
let importBehavior = async () => "run-1";
let queryBehavior = async () => ({ ok: false, status: 422, error: "query_not_understood", interpretation: null, fallbackReason: "model_busy" });
let server;
let base;

function startApp(overrides = {}) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/v1/investigations", createInvestigationsRouter({
    searchEvents: async (input) => {
      calls.push(input);
      return { total: 3, events: [event], nextCursor: { observedAt: new Date(event.observedAt), id: event.id } };
    },
    getEventDetails: async (id) => id === event.id ? { event, linkedPlaces: [], sources: [], lastSync: null } : null,
    getEntityDetails: async (id) => id === "osm:node:7" ? { place: { id }, linkedEvents: [{ relation: "nearby", distanceMeters: 120, event }], totalLinkedEvents: 1, sources: [] } : null,
    getSources: async (ids) => ids.map((id) => ({ id, label: "Synthetic", mode: "synthetic_local", status: "ready" })),
    importEnabled: true,
    startImport: (...args) => importBehavior(...args),
    runQuery: async (input) => queryBehavior(input),
    now: () => now,
    ...overrides,
  }));
  app.use(errorHandler);
  return new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
}

before(async () => {
  server = await startApp();
  base = `http://127.0.0.1:${server.address().port}/api/v1/investigations`;
});
after(() => server.close());

test("returns events with a cursor, applied filters, map features, and sources", async () => {
  const response = await fetch(`${base}/events?lat=42.6&lon=13.1&radiusKm=5&minMagnitude=1.5&limit=10`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 3);
  assert.deepEqual(body.events, [event]);
  assert.deepEqual(decodeEventCursor(body.nextCursor), { observedAt: new Date(event.observedAt), id: event.id });
  assert.deepEqual(body.appliedFilters, {
    from: "2026-10-06T12:00:00.000Z",
    to: "2026-10-13T12:00:00.000Z",
    near: { lat: 42.6, lon: 13.1, radiusKm: 5 },
    minMagnitude: 1.5,
    limit: 10,
  });
  assert.deepEqual(body.mapFeatures.features[0].geometry, { type: "Point", coordinates: [13.1, 42.6] });
  assert.equal(body.sources[0].id, "demo-seismic-synthetic");
  assert.deepEqual(calls.at(-1).near, { lat: 42.6, lon: 13.1, radiusMeters: 5000 });
});

test("rejects malformed, unbounded, or conflicting event queries", async () => {
  const cases = {
    "from=2026-01-01T00:00:00Z": "invalid_time_window",
    "from=2026-10-13T00:00:00Z&to=2026-10-12T00:00:00Z": "invalid_time_window",
    "lat=42&lon=13": "invalid_radius_query",
    "lat=42&lon=13&radiusKm=301": "invalid_query",
    "bbox=10,40,9,41": "invalid_bbox",
    "bbox=1,2,3,4&lat=2&lon=2&radiusKm=1": "invalid_area_filter",
    "minMagnitude=3&maxMagnitude=2": "invalid_magnitude_range",
    "limit=201": "invalid_query",
    "limit=0": "invalid_query",
    "cursor=not-a-cursor": "invalid_cursor",
    "sql=DROP%20TABLE%20records": "invalid_query",
    "limit=1&limit=2": "invalid_query",
    "bbox=1,2,,4": "invalid_bbox",
  };
  for (const [query, error] of Object.entries(cases)) {
    const response = await fetch(`${base}/events?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error }, query);
  }
});

test("returns event details, 404 for unknown IDs, and 400 for invalid IDs", async () => {
  assert.equal((await fetch(`${base}/events/${encodeURIComponent(event.id)}`)).status, 200);
  const missing = await fetch(`${base}/events/demo-seismic-synthetic:missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  assert.equal((await fetch(`${base}/events/${encodeURIComponent("a b;--")}`)).status, 400);
  assert.equal((await fetch(`${base}/entities/osm:node:1?limit=500`)).status, 400);
  assert.equal((await fetch(`${base}/entities/osm:node:1`)).status, 404);
});

test("maps import outcomes to status codes", async () => {
  const post = (path, body = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  importBehavior = async () => "run-1";
  const accepted = await post("/import/ingv-fdsn", { days: 3 });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { runId: "run-1", sourceId: "ingv-fdsn", status: "running" });
  assert.equal((await post("/import/unknown-source")).status, 404);
  assert.equal((await post("/import/ingv-fdsn", { days: 90 })).status, 400);
  assert.equal((await post("/import/ingv-fdsn", { url: "http://169.254.169.254/" })).status, 400);
  importBehavior = async () => { throw new ImportCooldownError(120); };
  const cooldown = await post("/import/ingv-fdsn");
  assert.equal(cooldown.status, 429);
  assert.equal(cooldown.headers.get("retry-after"), "120");
  importBehavior = async () => { throw new ImportAlreadyRunningError("import_running"); };
  assert.equal((await post("/import/ingv-fdsn")).status, 409);
});

test("keeps the import trigger disabled unless configured", async () => {
  const disabled = await startApp({ importEnabled: false });
  const response = await fetch(`http://127.0.0.1:${disabled.address().port}/api/v1/investigations/import/ingv-fdsn`, { method: "POST" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "import_disabled" });
  disabled.close();
});

test("rate-limits a client that sends too many requests", async () => {
  const limited = await startApp({ rateLimit: { windowMs: 60_000, max: 2 } });
  const url = `http://127.0.0.1:${limited.address().port}/api/v1/investigations/events`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url)).status, 200);
  const third = await fetch(url);
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get("retry-after")) > 0);
  limited.close();
});

test("defaults the event window to the last seven days and round-trips cursors", () => {
  const parsed = parseEventSearchQuery({}, now);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.from.toISOString(), "2026-10-06T12:00:00.000Z");
  assert.equal(parsed.value.limit, 50);
  const cursor = { observedAt: new Date("2026-10-12T10:00:00.123Z"), id: "x:1" };
  assert.deepEqual(decodeEventCursor(encodeEventCursor(cursor)), cursor);
  assert.equal(decodeEventCursor(Buffer.from('{"t":"x","id":"1"}').toString("base64url")), null);
});

test("background import resolves on run start and rejects errors raised before it", async () => {
  const runId = await startBackgroundImport(async (onRunStarted) => {
    onRunStarted("run-9");
    return { runId: "run-9", sourceId: "s", window: {}, counts: {}, linkedPlaces: 0, truncated: false };
  });
  assert.equal(runId, "run-9");
  await assert.rejects(startBackgroundImport(async () => { throw new ImportCooldownError(5); }), { code: "import_cooldown" });
});

test("returns the interpretation, applied filters, and rows for a natural-language query", async () => {
  const post = (body) => fetch(`${base}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  queryBehavior = async (input) => ({
    ok: true,
    interpretation: { interpretedBy: "model", tool: "search_events", arguments: { hours: 24 } },
    resolvedPlace: null,
    search: { from: new Date(input.now.getTime() - 86_400_000), to: input.now, limit: 50 },
    result: { total: 1, events: [event], nextCursor: null },
  });
  const ok = await post({ text: "last day" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.interpretation.interpretedBy, "model");
  assert.deepEqual(body.appliedFilters, { from: "2026-10-12T12:00:00.000Z", to: "2026-10-13T12:00:00.000Z", limit: 50 });
  assert.equal(body.events.length, 1);
  assert.equal(body.nextCursor, null);

  queryBehavior = async () => ({ ok: false, status: 422, error: "place_not_found", interpretation: { interpretedBy: "rules", tool: "search_events", arguments: { place: "Nowhere" } } });
  const missing = await post({ text: "near Nowhere" });
  assert.equal(missing.status, 422);
  assert.equal((await missing.json()).error, "place_not_found");

  assert.equal((await post({ text: "" })).status, 400);
  assert.equal((await post({ text: "x".repeat(301) })).status, 400);
  assert.equal((await post({ text: "ok", tools: ["drop_tables"] })).status, 400);
  assert.equal((await post({ text: "ok", selection: { lat: 99, lon: 0, label: "x" } })).status, 400);
});

test("treats empty numeric parameters as absent", () => {
  const parsed = parseEventSearchQuery({ minMagnitude: "", lat: "", lon: "", radiusKm: "" }, now);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.minMagnitude, undefined);
  assert.equal(parsed.value.near, undefined);
});

test("returns entity details with linked events", async () => {
  const response = await fetch(`${base}/entities/osm:node:7?limit=5`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.totalLinkedEvents, 1);
  assert.equal(body.linkedEvents[0].event.id, event.id);
});

test("answers malformed JSON with 400 and requires JSON for imports", async () => {
  const malformed = await fetch(`${base}/query`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_json" });
  // A cross-site form post (no JSON content type) cannot trigger an import.
  const form = await fetch(`${base}/import/ingv-fdsn`, { method: "POST", headers: { "content-type": "text/plain" }, body: "days=7" });
  assert.equal(form.status, 415);
});
