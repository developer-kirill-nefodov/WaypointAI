import assert from "node:assert/strict";
import test from "node:test";
import { applyTripPlanEdits, parseEditTripPlanArgs } from "../src/assistant/trip-plan-edit.ts";

const place = (id, name, lat = 52.23, lon = 21.01, category = "tourism:attraction") => ({
  id, sourceId: "osm-pl", name, category, countryCode: "PL", city: "Warszawa", street: null, houseNumber: null, postcode: null, lat, lon,
});
const initialPlaces = [place("a", "Melt Museum"), place("b", "Fabryka Koronek"), place("c", "John Dragon"), place("d", "Be Happy Museum")];
const plan = () => ({
  status: "ready", countryCode: "PL", city: "Warszawa", totalDays: 2, supportedDays: 2, travelMode: "driving", airport: null, sourceIds: ["osm-pl"],
  days: [
    { day: 1, area: "city", stopPlaceIds: ["a", "b"], straightLineDistanceMetersFromAirport: {}, routeStatus: "pending" },
    { day: 2, area: "city", stopPlaceIds: ["c", "d"], straightLineDistanceMetersFromAirport: {}, routeStatus: "pending" },
  ],
});

/** A finder over a fixed catalogue that honours the exclusions and records what it was asked for. */
function fakeFinder(catalogue) {
  const calls = [];
  const finder = async (input) => {
    calls.push(input);
    return catalogue.filter((candidate) => input.categories.some((category) => candidate.category === category) && !input.excludeIds.has(candidate.id)).slice(0, input.count);
  };
  return { finder, calls };
}
const catalogue = [
  place("m1", "Muzeum Narodowe", 52.23, 21.02, "tourism:museum"),
  place("m2", "Muzeum Chopina", 52.24, 21.02, "tourism:museum"),
  place("t1", "Pałac Kultury", 52.23, 21.0),
  place("t2", "Zamek Królewski", 52.25, 21.01),
  place("p1", "Park Łazienkowski", 52.21, 21.03, "leisure:park"),
];

test("adds verified stops of the requested kind to one day and leaves other days alone", async () => {
  const { finder, calls } = fakeFinder(catalogue);
  const result = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "add_stops", day: 2, category: "museum", count: 2 }], finder);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.days[0].stopPlaceIds, ["a", "b"]);
  assert.deepEqual(result.plan.days[1].stopPlaceIds, ["c", "d", "m1", "m2"]);
  assert.deepEqual(calls[0].categories, ["tourism:museum"]);
  assert.ok(["a", "b", "c", "d"].every((id) => calls[0].excludeIds.has(id)));
  assert.deepEqual(result.changes, [{ kind: "stops_added", day: 2, names: ["Muzeum Narodowe", "Muzeum Chopina"] }]);
  assert.deepEqual(result.places.map((item) => item.id), ["a", "b", "c", "d", "m1", "m2"]);
});

test("stops can be named by their day.position ref from the plan the model sees", async () => {
  const { finder } = fakeFinder(catalogue);
  const result = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "remove_stops", stops: ["2.1"] }, { op: "move_stop", stop: "1.2", toDay: 2 }], finder);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.days.map((day) => day.stopPlaceIds), [["a"], ["d", "b"]]);
  const missing = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "remove_stops", stops: ["1.9"] }], finder);
  assert.equal(missing.ok, false);
});

test("removes and moves stops by name, and rejects names that are not in the plan", async () => {
  const { finder } = fakeFinder(catalogue);
  const removed = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "remove_stops", stops: ["john dragon"] }, { op: "move_stop", stop: "Melt Museum", toDay: 2 }], finder);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.plan.days.map((day) => day.stopPlaceIds), [["b"], ["d", "a"]]);
  assert.equal(removed.plan.days[0].routeStatus, "unavailable");

  const unknown = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "remove_stops", stops: ["Eiffel Tower"] }], finder);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /not a stop of the current plan/);
  const ambiguous = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "remove_stops", stops: ["Museum"] }], finder);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /several stops/);
});

test("adds, removes, and sets days without reshuffling the days that stay", async () => {
  const { finder } = fakeFinder(catalogue);
  const added = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "add_day" }], finder);
  assert.equal(added.ok, true);
  assert.equal(added.plan.totalDays, 3);
  assert.deepEqual(added.plan.days.slice(0, 2).map((day) => day.stopPlaceIds), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(added.plan.days[2].stopPlaceIds, ["m1", "m2", "t1", "t2"]);

  const removed = await applyTripPlanEdits(added.plan, added.places, [{ op: "remove_day", day: 1 }], finder);
  assert.deepEqual(removed.plan.days.map((day) => [day.day, day.stopPlaceIds]), [[1, ["c", "d"]], [2, ["m1", "m2", "t1", "t2"]]]);

  const shorter = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "set_days", totalDays: 1 }], finder);
  assert.deepEqual(shorter.plan.days.map((day) => day.stopPlaceIds), [["a", "b"]]);
  assert.deepEqual(shorter.places.map((item) => item.id), ["a", "b"]);

  const tooLong = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "remove_day", day: 5 }], finder);
  assert.equal(tooLong.ok, false);
});

test("replaces a day with new kinds of places and never brings removed stops back", async () => {
  const { finder } = fakeFinder([...catalogue, place("c", "John Dragon", 52.2, 21, "leisure:park")]);
  const result = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "replace_day", day: 2, category: "park" }], finder);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.days[1].stopPlaceIds, ["p1"]);
});

test("route mode changes the route status of every day", async () => {
  const { finder } = fakeFinder(catalogue);
  const result = await applyTripPlanEdits(plan(), initialPlaces, [{ op: "set_route_mode", mode: "none" }], finder);
  assert.equal(result.plan.travelMode, "none");
  assert.ok(result.plan.days.every((day) => day.routeStatus === "not_requested"));
});

test("tool arguments are validated strictly after dropping fields of other operations", () => {
  const flat = parseEditTripPlanArgs({ operations: [{ op: "add_day", day: null, category: "museum", stops: null }] });
  assert.equal(flat.success, true);
  assert.deepEqual(flat.data.operations, [{ op: "add_day", category: "museum" }]);
  assert.equal(parseEditTripPlanArgs('{"operations":[{"op":"set_days","totalDays":"3"}]}').data.operations[0].totalDays, 3);
  assert.equal(parseEditTripPlanArgs({ operations: [{ op: "set_days", totalDays: 12 }] }).success, false);
  assert.equal(parseEditTripPlanArgs({ operations: [{ op: "drop_table" }] }).success, false);
  assert.equal(parseEditTripPlanArgs({ operations: [{ op: "add_day", category: "casino" }] }).success, false);
  assert.equal(parseEditTripPlanArgs({ operations: [{ op: "add_day" }], sql: "select 1" }).success, false);
  // The model-facing shape is one flat operation per call.
  assert.deepEqual(parseEditTripPlanArgs({ op: "move_stop", stop: "1.2", toDay: 2, day: null, category: null }).data.operations, [{ op: "move_stop", stop: "1.2", toDay: 2 }]);
});


test("plan intent comes from the model's structured answer and falls back to other", async () => {
  const { classifyPlanIntent, parseIntent } = await import("../src/assistant/plan-intent.ts");
  assert.equal(parseIntent('{"intent":"change_plan"}'), "change_plan");
  assert.equal(parseIntent('{"intent":"drop_tables"}'), "other");
  assert.equal(parseIntent("not json"), "other");
  let seen;
  const call = async (messages, format) => { seen = { messages, format }; return { message: { role: "assistant", content: '{"intent":"new_trip"}' }, metrics: {} }; };
  const { intent } = await classifyPlanIntent("{}", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "Plan Paris", call);
  assert.equal(intent, "new_trip");
  assert.deepEqual(seen.format.properties.intent.enum, ["change_plan", "new_trip", "other"]);
  assert.equal(seen.messages.at(-1).content, "Plan Paris");
});

test("a city whose days are all removed leaves the trip", async () => {
  const twoCities = { ...plan(), city: "Warszawa, Radom", cities: [{ name: "Warszawa", placeId: "w", lat: 52.2, lon: 21, countryCode: "PL" }, { name: "Radom", placeId: "r", lat: 51.4, lon: 21.1, countryCode: "PL" }] };
  twoCities.days = twoCities.days.map((day, index) => ({ ...day, city: index === 0 ? "Warszawa" : "Radom" }));
  const { finder } = fakeFinder(catalogue);
  const result = await applyTripPlanEdits(twoCities, initialPlaces, [{ op: "set_days", totalDays: 1 }], finder);
  assert.deepEqual(result.plan.cities.map((city) => city.name), ["Warszawa"]);
  assert.equal(result.plan.city, "Warszawa");
});

test("place search replies list only returned rows and say what was searched", async () => {
  const { formatPlaceResultsMessage } = await import("../src/assistant/place-results-message.ts");
  const message = formatPlaceResultsMessage({ kind: "park", city: "Berlin", query: null, category: null }, [initialPlaces[0]], 103, "ru");
  assert.match(message, /парки, Berlin/);
  assert.match(message, /1 из 103/);
  assert.match(message, /1\. Melt Museum/);
  assert.match(formatPlaceResultsMessage({ kind: "museum", city: "Roma", query: null, category: null }, [], 0, "en"), /Nothing was found .*museums, Roma/);
});
