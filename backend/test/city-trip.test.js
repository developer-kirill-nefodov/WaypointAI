import assert from "node:assert/strict";
import test from "node:test";
import { allocateTripDays, extractCityCandidates, resolveLatestTripCities, resolveTripCities } from "../src/assistant/trip-cities.ts";
import { buildCityTripPlan, isCityTrip, prefetchCityTrip } from "../src/assistant/city-trip-plan.ts";

// Synthetic settlements keyed by the names the resolver would receive.
const settlements = {
  Roma: { match: "exact", id: "c-roma", sourceId: "osm", name: "Roma", category: "place:city", countryCode: "IT", lat: 41.9, lon: 12.5 },
  Rome: { match: "exact", id: "c-roma", sourceId: "osm", name: "Roma", category: "place:city", countryCode: "IT", lat: 41.9, lon: 12.5 },
  Firenze: { match: "exact", id: "c-firenze", sourceId: "osm", name: "Firenze", category: "place:city", countryCode: "IT", lat: 43.77, lon: 11.25 },
  Florence: { match: "exact", id: "c-firenze", sourceId: "osm", name: "Firenze", category: "place:city", countryCode: "IT", lat: 43.77, lon: 11.25 },
  Plan: { match: "exact", id: "v-plan", sourceId: "osm", name: "Plan", category: "place:village", countryCode: "FR", lat: 45, lon: 6 },
  Spoletto: { match: "approximate", id: "c-spoleto", sourceId: "osm", name: "Spoleto", category: "place:town", countryCode: "IT", lat: 42.7, lon: 12.7 },
};
const resolve = async (name) => settlements[name] ?? null;
const at = (text, names) => names.map((name) => ({ mentionIndex: text.indexOf(name), mentionLength: name.length }));

test("finds cities from Russian, German, English, and local names in mention order", async () => {
  assert.deepEqual(extractCityCandidates("Хочу 2 дня в Риме и 3 во Флоренции").map((item) => item.name), ["Roma", "Firenze"]);
  assert.deepEqual(extractCityCandidates("Reise nach Rom und Florenz").filter((item) => item.viaExonym).map((item) => item.name), ["Roma", "Firenze"]);
  const cities = await resolveTripCities("Plan 5 days in Rome and Florence", resolve);
  assert.deepEqual(cities.map((city) => city.name), ["Roma", "Firenze"]);
});

test("rejects villages and approximate matches found only as capitalized words", async () => {
  assert.deepEqual((await resolveTripCities("Plan a trip to Spoletto", resolve)).map((city) => city.name), []);
});

test("a new city list replaces the cities of an earlier trip in the same conversation", async () => {
  const latest = await resolveLatestTripCities(["Trip to Rome for 2 days", "Рим и Флоренция на 5 дней", "на машине"], resolve);
  assert.deepEqual(latest.cities.map((city) => city.name), ["Roma", "Firenze"]);
  assert.equal(latest.text, "Рим и Флоренция на 5 дней\nна машине");
  assert.deepEqual((await resolveLatestTripCities(["на машине"], resolve)).cities, []);
});

test("allocates explicit per-city days and treats a single leading or trailing count as the total", () => {
  let text = "Хочу 2 дня в Риме и 3 во Флоренции";
  assert.deepEqual(allocateTripDays(text, at(text, ["Риме", "Флоренции"]), 2), [2, 3]);
  text = "Plan 5 days in Rome and Florence";
  assert.deepEqual(allocateTripDays(text, at(text, ["Rome", "Florence"]), 5), [3, 2]);
  text = "Рим и Флоренция на 5 дней";
  assert.deepEqual(allocateTripDays(text, at(text, ["Рим", "Флоренция"]), 5), [3, 2]);
  text = "Rome for 2 days, then Florence";
  assert.deepEqual(allocateTripDays(text, at(text, ["Rome", "Florence"]), null), [2, 1]);
  text = "Бухарест, Брашов и Клуж на неделю";
  assert.deepEqual(allocateTripDays(text, at(text, ["Бухарест", "Брашов", "Клуж"]), 7), [3, 2, 2]);
  text = "Roma 4 days, Firenze 4 days";
  assert.deepEqual(allocateTripDays(text, at(text, ["Roma", "Firenze"]), null).reduce((sum, days) => sum + days, 0), 7);
});

test("uses the city flow for several cities or a city outside the capital flow", () => {
  assert.equal(isCityTrip([{ name: "Berlin" }]), false);
  assert.equal(isCityTrip([{ name: "Firenze" }]), true);
  assert.equal(isCityTrip([{ name: "Roma" }, { name: "Firenze" }]), true);
});

test("builds consecutive days per city from places found around each center", async () => {
  const place = (id, category) => ({ id, sourceId: "osm-it", name: `Synthetic ${id}`, category, countryCode: "IT", city: null, street: null, houseNumber: null, postcode: null, lat: 42, lon: 12 });
  const searches = [];
  const search = async (input) => {
    searches.push(input);
    const prefix = `${input.center.lat}-${input.category}`;
    return { total: 6, partial: false, places: Array.from({ length: 6 }, (_, index) => place(`${prefix}-${index}`, input.category)), distancesMeters: {} };
  };
  const cities = [
    { ...settlements.Roma, mentionIndex: 0, mentionLength: 4 },
    { ...settlements.Firenze, mentionIndex: 10, mentionLength: 7 },
  ];
  const stops = await prefetchCityTrip(cities, [2, 1], undefined, search);
  assert.equal(searches.length, 4);
  assert.equal(searches[0].radiusMeters, 8000);
  assert.equal(stops[0].places[0].category, "tourism:attraction");
  assert.equal(stops[0].places[1].category, "tourism:museum");
  const plan = buildCityTripPlan(stops, "driving");
  assert.deepEqual(plan.days.map((day) => [day.day, day.city]), [[1, "Roma"], [2, "Roma"], [3, "Firenze"]]);
  assert.deepEqual(plan.cities.map((city) => city.name), ["Roma", "Firenze"]);
  assert.equal(plan.city, "Roma, Firenze");
  assert.equal(plan.totalDays, 3);
  assert.ok(plan.days.every((day) => day.stopPlaceIds.length >= 2 && day.routeStatus === "pending"));
});

test("reads two-digit day counts and caps them instead of keeping the last digit", () => {
  const text = "12 days in Roma";
  assert.deepEqual(allocateTripDays(text, at(text, ["Roma"]), null), [7]);
  const mixed = "Roma 12 days, Firenze";
  assert.equal(allocateTripDays(mixed, at(mixed, ["Roma", "Firenze"]), null).reduce((sum, days) => sum + days, 0), 7);
});

test("looks up each candidate name once per turn", async () => {
  const calls = [];
  const counting = async (name) => { calls.push(name); return settlements[name] ?? null; };
  await resolveLatestTripCities(["Rome and Florence for 5 days", "by car"], counting);
  assert.equal(calls.filter((name) => name === "Rome").length, 1);
});
