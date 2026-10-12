import assert from "node:assert/strict";
import test from "node:test";
import { buildTripPlan } from "../src/assistant/trip-plan.ts";

const place = (index) => ({ id: `place-${index}`, sourceId: "osm-de", name: `Synthetic stop ${index}`, category: "tourism:museum", countryCode: "DE", city: "Berlin", lat: 52.5 + index / 1000, lon: 13.4, details: {} });

test("splits verified city stops across a four-day driving plan", () => {
  const places = Array.from({ length: 16 }, (_, index) => place(index));
  const prefetch = { countryCode: "DE", city: "Berlin", searches: [{ label: "museums", category: "tourism:museum", area: "city", total: 16, places }], places };
  const plan = buildTripPlan(prefetch, { airportCode: null, totalDays: 4, routeMode: "driving", cityOnly: false });
  assert.equal(plan?.status, "ready");
  assert.equal(plan?.totalDays, 4);
  assert.deepEqual(plan?.days.map((day) => day.stopPlaceIds.length), [4, 4, 4, 4]);
  assert.ok(plan?.days.every((day) => day.routeStatus === "pending"));
});

test("uses country-level stops and a one-day default when only the route mode is known", () => {
  const places = [place(1), place(2)];
  const prefetch = { countryCode: "DE", city: "Berlin", searches: [{ label: "museums", category: "tourism:museum", area: "country", total: 2, places }], places };
  const plan = buildTripPlan(prefetch, { airportCode: null, totalDays: null, routeMode: "driving", cityOnly: false });
  assert.equal(plan?.totalDays, 1);
  assert.deepEqual(plan?.days[0]?.stopPlaceIds, ["place-1", "place-2"]);
});
