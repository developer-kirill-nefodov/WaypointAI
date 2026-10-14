import assert from "node:assert/strict";
import test from "node:test";
import { buildCityTripPlan, prefetchCityTrip } from "../src/assistant/city-trip-plan.ts";
import { allocateTripDays, executePlanTrip } from "../src/assistant/plan-trip.ts";
import { parsePlanTripArgs } from "../src/tools/plan-trip.ts";

// Synthetic settlements keyed by the names the resolver would receive.
const settlements = {
  Roma: { match: "exact", id: "c-roma", sourceId: "osm", name: "Roma", category: "place:city", countryCode: "IT", lat: 41.9, lon: 12.5 },
  Rome: { match: "exact", id: "c-roma", sourceId: "osm", name: "Roma", category: "place:city", countryCode: "IT", lat: 41.9, lon: 12.5 },
  Firenze: { match: "exact", id: "c-firenze", sourceId: "osm", name: "Firenze", category: "place:city", countryCode: "IT", lat: 43.77, lon: 11.25 },
};
const place = (id, category = "tourism:attraction", lat = 42, lon = 12) => ({ id, sourceId: "osm-it", name: `Synthetic ${id}`, category, countryCode: "IT", city: null, street: null, houseNumber: null, postcode: null, lat, lon });
const nearbySearch = async (input) => ({
  total: 6, partial: false, distancesMeters: {},
  places: Array.from({ length: 6 }, (_, index) => place(`${input.center.lat}-${input.category}-${index}`, input.category)),
});
const dependencies = (overrides = {}) => ({
  resolveSettlement: async (name) => settlements[name] ?? null,
  prefetchCityTrip: (cities, days, sourceIds) => prefetchCityTrip(cities, days, sourceIds, nearbySearch),
  findAirport: async () => null,
  findNearAirport: async () => ({ places: [], distancesMeters: {} }),
  ...overrides,
});

test("builds consecutive days per city from places found around each center", async () => {
  const searches = [];
  const search = async (input) => { searches.push(input); return nearbySearch(input); };
  const cities = [settlements.Roma, settlements.Firenze];
  const stops = await prefetchCityTrip(cities, [2, 1], undefined, search);
  assert.equal(searches.length, 4);
  assert.equal(searches[0].radiusMeters, 8000);
  assert.equal(stops[0].places[0].category, "tourism:attraction");
  assert.equal(stops[0].places[1].category, "tourism:museum");
  const plan = buildCityTripPlan(stops, "driving");
  assert.deepEqual(plan.days.map((day) => [day.day, day.city]), [[1, "Roma"], [2, "Roma"], [3, "Firenze"]]);
  assert.deepEqual(plan.cities.map((city) => city.name), ["Roma", "Firenze"]);
  assert.equal(plan.city, "Roma, Firenze");
  assert.ok(plan.days.every((day) => day.stopPlaceIds.length >= 2 && day.routeStatus === "pending"));
});

test("keeps per-city days the user gave and shares the rest of the stay evenly", () => {
  assert.deepEqual(allocateTripDays([null, null], 5), [3, 2]);
  assert.deepEqual(allocateTripDays([2, null], 5), [2, 3]);
  assert.deepEqual(allocateTripDays([2, 1], undefined), [2, 1]);
  assert.deepEqual(allocateTripDays([null], undefined), [1]);
  assert.deepEqual(allocateTripDays([null, null], 12), [4, 3]);
});

test("plan_trip builds a plan from the model's structured request", async () => {
  const outcome = await executePlanTrip({ cities: [{ name: "Rome" }, { name: "Firenze", days: 1 }], totalDays: 3, routeMode: "driving" }, dependencies());
  assert.equal(outcome.kind, "planned");
  assert.deepEqual(outcome.plan.days.map((day) => day.city), ["Roma", "Roma", "Firenze"]);
  assert.equal(outcome.plan.travelMode, "driving");
  assert.ok(outcome.places.length > 0);
});

test("plan_trip asks for the route mode, reports unknown cities, and rejects invalid arguments", async () => {
  assert.deepEqual(await executePlanTrip({ cities: [{ name: "Roma" }], totalDays: 2 }, dependencies()), { kind: "ask_route_mode", cities: ["Roma"] });
  const unknown = await executePlanTrip({ cities: [{ name: "Tokyo" }], routeMode: "driving" }, dependencies());
  assert.equal(unknown.kind, "error");
  assert.match(unknown.error, /Tokyo/);
  assert.equal((await executePlanTrip({ cities: [], routeMode: "driving" }, dependencies())).kind, "error");
  assert.equal((await executePlanTrip({ cities: [{ name: "Roma" }], totalDays: 30, routeMode: "driving" }, dependencies())).kind, "error");
  assert.equal((await executePlanTrip({ cities: [{ name: "Roma" }], sql: "drop table places" }, dependencies())).kind, "error");
});

test("plan_trip starts with an airport day when the airport is in the snapshot", async () => {
  const airport = place("airport", "aeroway:aerodrome", 41.8, 12.25);
  const outcome = await executePlanTrip({ cities: [{ name: "Roma" }], totalDays: 3, routeMode: "driving", airportCode: "fco" }, dependencies({
    findAirport: async (code) => (code === "FCO" ? airport : null),
    findNearAirport: async () => ({ places: [place("near-1"), place("near-2")], distancesMeters: { "near-1": 900, "near-2": 1500 } }),
  }));
  assert.equal(outcome.kind, "planned");
  assert.equal(outcome.plan.airport.code, "FCO");
  assert.deepEqual(outcome.plan.days.map((day) => day.area), ["airport_radius", "city", "city"]);
  assert.deepEqual(outcome.plan.days[0].straightLineDistanceMetersFromAirport, { "near-1": 900, "near-2": 1500 });
  const missing = await executePlanTrip({ cities: [{ name: "Roma" }], routeMode: "driving", airportCode: "XXX" }, dependencies());
  assert.equal(missing.kind, "error");
});

test("plan_trip arguments tolerate nulls and bare city names but stay strict", () => {
  assert.deepEqual(parsePlanTripArgs({ cities: ["Warszawa"], totalDays: "2", routeMode: null, airportCode: null }).data, { cities: [{ name: "Warszawa" }], totalDays: 2 });
  assert.equal(parsePlanTripArgs('{"cities":[{"name":"Roma","days":2}],"routeMode":"driving"}').success, true);
  assert.equal(parsePlanTripArgs({ cities: [{ name: "Roma", lat: 41.9 }] }).success, false);
  assert.equal(parsePlanTripArgs({ cities: [{ name: "Roma" }], routeMode: "walking" }).success, false);
});
