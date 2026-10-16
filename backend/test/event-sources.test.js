import assert from "node:assert/strict";
import test from "node:test";
import { buildIngvQueryUrl, createIngvAdapter, normalizeIngvPayload } from "../src/sources/ingv/ingv.adapter.ts";
import { parseFdsnTime } from "../src/sources/ingv/ingv.schema.ts";
import { fetchWithRetry, parseRetryAfter } from "../src/sources/http.ts";
import { generateSyntheticEvents } from "../src/sources/synthetic/synthetic.adapter.ts";
import { buildUsgsQueryUrl, createUsgsAdapter, normalizeUsgsPayload } from "../src/sources/usgs/usgs.adapter.ts";

// Synthetic feature shaped like an INGV FDSN GeoJSON response; not a real catalogue event.
function feature(overrides = {}) {
  return {
    type: "Feature",
    properties: {
      eventId: 900001,
      originId: 500001,
      time: "2026-10-12T15:34:43.630000",
      author: "SYNTHETIC",
      magType: "ML",
      mag: 2.1,
      type: "earthquake",
      place: "Synthetic test location",
      version: 100,
      ...overrides.properties,
    },
    geometry: { type: "Point", coordinates: overrides.coordinates ?? [13.1, 42.6, 9.5] },
  };
}

const collection = (features) => ({ type: "FeatureCollection", features });
const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const noSleep = async () => {};
const window = { start: new Date("2026-10-06T00:00:00Z"), end: new Date("2026-10-13T00:00:00Z") };

function adapterWith(fetchImpl) {
  return createIngvAdapter({
    baseUrl: "https://webservices.ingv.it/fdsnws/event/1/query",
    bbox: [6, 35, 19, 48],
    timeoutMs: 1000,
    userAgent: "test",
    fetchImpl,
    sleep: noSleep,
  });
}

test("parses suffix-less FDSN times as UTC and keeps milliseconds", () => {
  assert.equal(parseFdsnTime("2026-10-12T15:34:43.630000")?.toISOString(), "2026-10-12T15:34:43.630Z");
  assert.equal(parseFdsnTime("2026-10-12T15:34:43Z")?.toISOString(), "2026-10-12T15:34:43.000Z");
  assert.equal(parseFdsnTime("12/10/2026"), null);
});

test("normalizes an INGV feature into the internal event shape", () => {
  const { events, skipped, truncated } = normalizeIngvPayload(collection([feature()]));
  assert.equal(skipped, 0);
  assert.equal(truncated, false);
  assert.deepEqual(events[0], {
    externalId: "900001",
    observedAt: new Date("2026-10-12T15:34:43.630Z"),
    lat: 42.6,
    lon: 13.1,
    category: "seismic:earthquake",
    revision: "500001:100",
    attributes: {
      label: "M2.1 · Synthetic test location",
      magnitude: 2.1,
      magnitudeType: "ML",
      depthKm: 9.5,
      placeDescription: "Synthetic test location",
      author: "SYNTHETIC",
      sourceEventUrl: "https://terremoti.ingv.it/en/event/900001",
    },
  });
  assert.equal(normalizeIngvPayload(collection([feature({ properties: { type: "quarry blast" } })])).events[0].category, "seismic:quarry_blast");
});

test("skips invalid features but keeps valid ones", () => {
  const result = normalizeIngvPayload(collection([
    feature(),
    feature({ coordinates: [13.1, 95, 1] }),
    feature({ properties: { eventId: "abc" } }),
    feature({ properties: { time: "yesterday" } }),
    { type: "Feature" },
  ]));
  assert.equal(result.events.length, 1);
  assert.equal(result.skipped, 4);
});

test("rejects a payload that is not a feature collection", () => {
  assert.throws(() => normalizeIngvPayload({ error: "nope" }), { code: "upstream_malformed" });
  assert.throws(() => normalizeIngvPayload(null), { code: "upstream_malformed" });
});

test("flags a page that reached the request limit as truncated", () => {
  assert.equal(normalizeIngvPayload(collection([feature(), feature({ properties: { eventId: 2 } })]), 2).truncated, true);
});

test("builds a bounded FDSN query in UTC", () => {
  const url = buildIngvQueryUrl("https://webservices.ingv.it/fdsnws/event/1/query", window, [6, 35, 19, 48], 20000);
  assert.equal(url.searchParams.get("starttime"), "2026-10-06T00:00:00");
  assert.equal(url.searchParams.get("endtime"), "2026-10-13T00:00:00");
  assert.equal(url.searchParams.get("minlat"), "35");
  assert.equal(url.searchParams.get("maxlon"), "19");
  assert.equal(url.searchParams.get("limit"), "20000");
  assert.equal(url.searchParams.get("format"), "geojson");
});

test("treats 204 No Content as an empty successful result", async () => {
  const result = await adapterWith(async () => new Response(null, { status: 204 })).fetchEvents(window);
  assert.deepEqual(result, { events: [], skipped: 0, truncated: false });
});

test("retries transient upstream errors and then succeeds", async () => {
  let calls = 0;
  const result = await adapterWith(async () => {
    calls += 1;
    return calls < 3 ? new Response("busy", { status: 503 }) : jsonResponse(collection([feature()]));
  }).fetchEvents(window);
  assert.equal(calls, 3);
  assert.equal(result.events.length, 1);
});

test("gives up after bounded retries with a stable error code", async () => {
  let calls = 0;
  await assert.rejects(
    adapterWith(async () => { calls += 1; return new Response("down", { status: 502 }); }).fetchEvents(window),
    { code: "upstream_unavailable" },
  );
  assert.equal(calls, 3);
});

test("does not retry a client error", async () => {
  let calls = 0;
  await assert.rejects(
    adapterWith(async () => { calls += 1; return new Response("Error 400", { status: 400 }); }).fetchEvents(window),
    { code: "upstream_bad_request" },
  );
  assert.equal(calls, 1);
});

test("maps network failures and malformed bodies to error codes", async () => {
  await assert.rejects(adapterWith(async () => { throw new TypeError("fetch failed"); }).fetchEvents(window), { code: "upstream_unavailable" });
  await assert.rejects(adapterWith(async () => new Response("<html>", { status: 200 })).fetchEvents(window), { code: "upstream_malformed" });
});

test("reports a timeout when the upstream does not answer", async () => {
  // AbortSignal.timeout timers are unref'd; a ref'd timer keeps the loop alive like a real open socket would.
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 5000);
    init.signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(init.signal.reason); });
  });
  await assert.rejects(
    fetchWithRetry(new URL("https://webservices.ingv.it/x"), { timeoutMs: 20, retries: 0, userAgent: "test", fetchImpl: hanging }),
    { code: "upstream_timeout" },
  );
});

test("retries when the body download times out and refuses redirects", async () => {
  let calls = 0;
  const seen = [];
  const result = await fetchWithRetry(new URL("https://webservices.ingv.it/x"), {
    timeoutMs: 1000,
    userAgent: "test",
    sleep: noSleep,
    fetchImpl: async (_url, init) => {
      calls += 1;
      seen.push(init.redirect);
      if (calls === 1) {
        // Headers arrive, then the body stream fails like an aborted download.
        return new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("aborted", "AbortError")); } }), { status: 200 });
      }
      return jsonResponse(collection([feature()]));
    },
  });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(result.body).features.length, 1);
  assert.deepEqual(seen, ["error", "error"]);
});

test("derives a content revision when INGV omits the origin ID", () => {
  const base = normalizeIngvPayload(collection([feature({ properties: { originId: null } })])).events[0];
  const corrected = normalizeIngvPayload(collection([feature({ properties: { originId: null, mag: 2.6 } })])).events[0];
  assert.match(base.revision, /^h:[0-9a-f]{16}$/);
  assert.notEqual(base.revision, corrected.revision);
  assert.equal(base.revision, normalizeIngvPayload(collection([feature({ properties: { originId: null } })])).events[0].revision);
});

test("honours Retry-After before retrying", async () => {
  const delays = [];
  let calls = 0;
  await fetchWithRetry(new URL("https://webservices.ingv.it/x"), {
    timeoutMs: 1000,
    userAgent: "test",
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "3" } }) : jsonResponse(collection([]));
    },
  });
  assert.deepEqual(delays, [3000]);
  assert.equal(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("2026-10-21T07:27:50Z")), 10_000);
  assert.equal(parseRetryAfter("soon"), null);
});

test("generates the same synthetic events for the same window", () => {
  const first = generateSyntheticEvents(window);
  const second = generateSyntheticEvents(window);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
  assert.ok(first.every((event) => event.externalId.startsWith("synthetic-") && event.observedAt >= window.start && event.observedAt <= window.end));
});

test("accepts only allowlisted HTTPS hosts for the event source URL", async () => {
  const { isAllowedEventSourceUrl } = await import("../src/config/events.ts");
  assert.equal(isAllowedEventSourceUrl("https://webservices.ingv.it/fdsnws/event/1/query"), true);
  assert.equal(isAllowedEventSourceUrl("http://webservices.ingv.it/fdsnws/event/1/query"), false);
  assert.equal(isAllowedEventSourceUrl("https://webservices.ingv.it.evil.example/x"), false);
  assert.equal(isAllowedEventSourceUrl("https://169.254.169.254/latest/meta-data"), false);
  assert.equal(isAllowedEventSourceUrl("not a url"), false);
  // Each source's URL must be on its own host.
  assert.equal(isAllowedEventSourceUrl("https://earthquake.usgs.gov/fdsnws/event/1/query", "usgs"), true);
  assert.equal(isAllowedEventSourceUrl("https://earthquake.usgs.gov/fdsnws/event/1/query"), false);
  assert.equal(isAllowedEventSourceUrl("https://webservices.ingv.it/fdsnws/event/1/query", "usgs"), false);
});

// Synthetic feature shaped like a USGS FDSN GeoJSON response; not a real catalogue event.
function usgsFeature(overrides = {}) {
  return {
    type: "Feature",
    id: overrides.id ?? "xx9000test",
    properties: { time: Date.parse("2026-10-12T15:34:43.630Z"), updated: Date.parse("2026-10-13T08:00:00Z"), mag: 3.1, magType: "mb", place: "Synthetic test location", type: "earthquake", status: "reviewed", net: "xx", ...overrides.properties },
    geometry: { type: "Point", coordinates: overrides.coordinates ?? [13.1, 42.6, 10] },
  };
}

test("normalizes a USGS feature: epoch-millisecond time, update time as revision, link built from the ID", () => {
  const { events, skipped } = normalizeUsgsPayload(collection([usgsFeature()]));
  assert.equal(skipped, 0);
  assert.deepEqual(events[0], {
    externalId: "xx9000test",
    observedAt: new Date("2026-10-12T15:34:43.630Z"),
    lat: 42.6,
    lon: 13.1,
    category: "seismic:earthquake",
    revision: `u:${Date.parse("2026-10-13T08:00:00Z")}`,
    attributes: {
      label: "M3.1 · Synthetic test location",
      magnitude: 3.1,
      magnitudeType: "mb",
      depthKm: 10,
      placeDescription: "Synthetic test location",
      author: "xx",
      reviewStatus: "reviewed",
      sourceEventUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/xx9000test",
    },
  });
  // An ID that could change the link, a bad time, or bad coordinates are skipped.
  const mixed = normalizeUsgsPayload(collection([usgsFeature(), usgsFeature({ id: "../x" }), usgsFeature({ properties: { time: "yesterday" } }), usgsFeature({ coordinates: [200, 1, 1] })]));
  assert.equal(mixed.events.length, 1);
  assert.equal(mixed.skipped, 3);
  assert.throws(() => normalizeUsgsPayload({ error: "nope" }), { code: "upstream_malformed" });
});

test("queries USGS with full parameter names and accepts an empty collection", async () => {
  const url = buildUsgsQueryUrl("https://earthquake.usgs.gov/fdsnws/event/1/query", window, [6, 35, 19, 48], 20000);
  assert.equal(url.searchParams.get("starttime"), "2026-10-06T00:00:00");
  assert.equal(url.searchParams.get("minlatitude"), "35");
  assert.equal(url.searchParams.get("maxlongitude"), "19");
  assert.equal(url.searchParams.get("format"), "geojson");
  const adapter = createUsgsAdapter({ baseUrl: "https://earthquake.usgs.gov/fdsnws/event/1/query", bbox: [6, 35, 19, 48], timeoutMs: 1000, userAgent: "test", fetchImpl: async () => jsonResponse(collection([])), sleep: noSleep });
  assert.deepEqual(await adapter.fetchEvents(window), { events: [], skipped: 0, truncated: false });
  assert.equal(adapter.descriptor.id, "usgs-fdsn");
});

test("rejects a response body above the size limit without retrying", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("x".repeat(2048), { status: 200 }); };
  await assert.rejects(
    fetchWithRetry(new URL("https://example.test/events"), { timeoutMs: 1000, userAgent: "test", fetchImpl, maxBodyBytes: 1024, sleep: async () => {} }),
    (error) => error.code === "upstream_malformed" && error.retryable === false,
  );
  assert.equal(calls, 1);
  const ok = await fetchWithRetry(new URL("https://example.test/events"), { timeoutMs: 1000, userAgent: "test", fetchImpl, maxBodyBytes: 4096 });
  assert.equal(ok.body.length, 2048);
});
