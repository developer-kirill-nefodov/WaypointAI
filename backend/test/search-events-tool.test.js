import assert from "node:assert/strict";
import test from "node:test";
import { executeSearchEventsTool } from "../src/tools/search-events-tool.ts";

const now = new Date("2026-10-13T12:00:00Z");
// Synthetic settlement and event rows.
const town = { match: "exact", id: "osm:node:1", sourceId: "osm-test", name: "Testville", category: "place:town", countryCode: "IT", lat: 42.79, lon: 13.09 };
const event = {
  id: "test:1",
  sourceId: "test",
  observedAt: "2026-10-12T10:00:00.000Z",
  label: "M2 · Synthetic",
  lat: 42.8,
  lon: 13.1,
  accuracyMeters: null,
  attributes: { magnitude: 2, placeDescription: "Synthetic event", category: "seismic:earthquake" },
  distanceMeters: 1234,
};

function context(overrides = {}) {
  const searches = [];
  return {
    searches,
    value: {
      scope: {},
      selection: null,
      now,
      deps: {
        resolveSettlement: async (name) => (name === "Testville" ? town : null),
        getSources: async (ids) => ids.map((id) => ({ id, mode: id === "test" ? "synthetic_local" : "approved_live" })),
        searchEvents: async (input) => {
          searches.push(input);
          return { total: 1, events: [event], nextCursor: null };
        },
      },
      ...overrides,
    },
  };
}

test("searches around a resolved settlement and returns the area for the map", async () => {
  const ctx = context();
  const result = await executeSearchEventsTool({ place: "Testville", radiusKm: 30, hours: 72 }, ctx.value);
  assert.deepEqual(result.searchArea, { lat: 42.79, lon: 13.09, radiusKm: 30, label: "Testville" });
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.content.events[0], {
    id: "test:1",
    sourceId: "test",
    observedAt: "2026-10-12T10:00:00.000Z",
    magnitude: 2,
    placeDescription: "Synthetic event",
    synthetic: true,
    distanceKm: 1.2,
    directionFromCenter: "NE",
  });
  assert.equal(result.content.syntheticEventsOnThisPage, 1);
  assert.deepEqual(ctx.searches[0].near, { lat: 42.79, lon: 13.09, radiusMeters: 30_000 });
  assert.equal(ctx.searches[0].from.toISOString(), "2026-10-10T12:00:00.000Z");
});

test("uses the selected map item for nearSelection and reports a missing selection", async () => {
  const selected = context({ selection: { lat: 42.5, lon: 13.5, label: "Selected event" } });
  const result = await executeSearchEventsTool({ nearSelection: true, radiusKm: 5 }, selected.value);
  assert.equal(result.searchArea.label, "Selected event");
  const missing = await executeSearchEventsTool({ nearSelection: true }, context().value);
  assert.equal(missing.content.error, "selection_required");
  assert.equal(missing.records, undefined);
});

test("reports unknown places and invalid arguments without searching", async () => {
  const ctx = context();
  const unknown = await executeSearchEventsTool({ place: "Atlantis" }, ctx.value);
  assert.equal(unknown.content.error, "place_not_found");
  const invalid = await executeSearchEventsTool({ radiusKm: 5000, sql: "DROP TABLE records" }, ctx.value);
  assert.match(invalid.content.error, /Invalid search_events arguments/);
  assert.equal(ctx.searches.length, 0);
});

test("the chat scope narrows sources and dates the model asked for", async () => {
  const ctx = context({ scope: { dateRange: { from: "2026-10-12T00:00:00Z" } } });
  await executeSearchEventsTool({ hours: 168 }, { ...ctx.value, sourceIds: ["ingv-fdsn"] });
  assert.equal(ctx.searches[0].from.toISOString(), "2026-10-12T00:00:00.000Z");
  assert.deepEqual(ctx.searches[0].sourceIds, ["ingv-fdsn"]);
  const outside = context({ scope: { dateRange: { to: "2026-01-01T00:00:00Z" } } });
  const empty = await executeSearchEventsTool({ hours: 24 }, outside.value);
  assert.equal(empty.content.total, 0);
  assert.equal(outside.searches.length, 0);
});

test("drops a country passed as place and searches the whole catalogue", async () => {
  const ctx = context();
  const result = await executeSearchEventsTool({ place: "Italy", radiusKm: 50 }, ctx.value);
  assert.equal(result.searchArea, undefined);
  assert.equal(result.content.appliedFilters.ignoredRegion, "Italy");
  assert.equal(ctx.searches[0].near, undefined);
});

test("fills an explicit radius or period the model left out, but keeps the model's own values", async () => {
  const ctx = context();
  const filled = await executeSearchEventsTool({ place: "Testville" }, { ...ctx.value, userText: "earthquakes within 20 km of Testville in the last 3 days" });
  assert.equal(filled.searchArea.radiusKm, 20);
  assert.equal(ctx.searches[0].from.toISOString(), "2026-10-10T12:00:00.000Z");
  const kept = await executeSearchEventsTool({ place: "Testville", radiusKm: 40 }, { ...ctx.value, userText: "within 20 km of Testville" });
  assert.equal(kept.searchArea.radiusKm, 40);
  const noRadius = await executeSearchEventsTool({ place: "Testville" }, { ...ctx.value, userText: "earthquakes near Testville" });
  assert.equal(noRadius.searchArea.radiusKm, 25);
});

test("the chat category filter applies to event searches", async () => {
  const ctx = context({ scope: { filters: { category: "seismic:earthquake" } } });
  await executeSearchEventsTool({ hours: 24 }, ctx.value);
  assert.equal(ctx.searches[0].category, "seismic:earthquake");
});

test("tells the model when its event list is a sample and gives the range over all matches", async () => {
  const ctx = context();
  ctx.value.deps.searchEvents = async () => ({ total: 68, events: [event], nextCursor: null, magnitudeRange: { min: 0.2, max: 2 } });
  const result = await executeSearchEventsTool({ hours: 24 }, ctx.value);
  assert.deepEqual(result.content.magnitudeRangeOfAllMatches, { min: 0.2, max: 2 });
  assert.match(result.content.eventsBelowAreASample, /of 68 matches/);
  const small = await executeSearchEventsTool({ hours: 24 }, context().value);
  assert.equal(small.content.eventsBelowAreASample, false);
});

test("computes the compass direction from the search center for the model", async () => {
  const { compassDirection } = await import("../src/tools/search-events-tool.ts");
  const perugia = { lat: 43.11, lon: 12.39 };
  assert.equal(compassDirection(perugia, { lat: 42.83, lon: 12.99 }), "SE");
  assert.equal(compassDirection(perugia, { lat: 43.5, lon: 12.39 }), "N");
  assert.equal(compassDirection(perugia, { lat: 43.11, lon: 11.9 }), "W");
});

test("counts an earthquake in several catalogues once and tells the model which catalogues confirm each event", async () => {
  const confirmed = { ...event, id: "live:1", sourceId: "live", crossCheck: { status: "confirmed", matchedSourceIds: ["other-live"], checkedSourceIds: ["other-live"] } };
  const unchecked = { ...event, id: "live:2", sourceId: "live", crossCheck: { status: "unchecked", matchedSourceIds: [], checkedSourceIds: [] } };
  const ctx = context();
  ctx.value.deps.searchEvents = async (input) => { ctx.searches.push(input); return { total: 2, events: [confirmed, unchecked], nextCursor: null }; };
  const result = await executeSearchEventsTool({ place: "Testville" }, ctx.value);
  assert.deepEqual(ctx.searches[0].mergePriority, ["ingv-fdsn", "usgs-fdsn"]);
  assert.equal(result.content.events[0].crossCheck, "confirmed");
  assert.deepEqual(result.content.events[0].alsoReportedBy, ["other-live"]);
  // An event nothing was compared with carries no claim either way.
  assert.equal(result.content.events[1].crossCheck, undefined);
  assert.deepEqual(result.content.crossCheckOnThisPage, { confirmed: 1, conflict: 0, single: 0 });
});
