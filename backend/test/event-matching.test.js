import assert from "node:assert/strict";
import test from "node:test";
import { MATCH_RULES, matchEvents } from "../src/services/event-matching.ts";

/** Synthetic events; one degree of latitude is about 111 km. */
const at = (seconds) => new Date(Date.parse("2026-10-12T10:00:00Z") + seconds * 1000);
const event = (id, sourceId, seconds, overrides = {}) => ({ id, sourceId, observedAt: at(seconds), lat: 42, lon: 13, magnitude: 3, depthKm: 10, ...overrides });

test("pairs events within 30 s and 50 km, stored once with the smaller ID first", () => {
  const matches = matchEvents([event("b:1", "b", 0)], [event("a:1", "a", 2, { lat: 42.1 }), event("a:far", "a", 1, { lat: 43 }), event("a:late", "a", 31)]);
  assert.equal(matches.length, 1);
  assert.deepEqual({ ...matches[0] }, { recordId: "a:1", matchedRecordId: "b:1", timeDeltaMs: 2000, distanceMeters: 11119, magnitudeDelta: 0, depthDeltaKm: 0, consistent: true });
  // The limits themselves still match.
  const edge = matchEvents([event("x:1", "x", 0)], [event("y:1", "y", MATCH_RULES.maxTimeDeltaMs / 1000)]);
  assert.equal(edge.length, 1);
  // Events of the same source never match each other.
  assert.equal(matchEvents([event("x:1", "x", 0)], [event("x:2", "x", 1)]).length, 0);
});

test("chooses the closest pair in an aftershock burst and uses each event once per other source", () => {
  const events = [event("i:1", "i", 0), event("i:2", "i", 5, { lat: 42.05 })];
  const candidates = [event("u:1", "u", 4, { lat: 42.05 }), event("u:2", "u", 1)];
  const pairs = matchEvents(events, candidates).map((match) => `${match.recordId}=${match.matchedRecordId}`).sort();
  assert.deepEqual(pairs, ["i:1=u:2", "i:2=u:1"]);
  // A third catalogue gets its own pair for the same event.
  assert.equal(matchEvents([event("i:1", "i", 0)], [event("u:1", "u", 1), event("e:1", "e", 2)]).length, 2);
});

test("marks a pair inconsistent when magnitude or depth disagree, with a relative depth tolerance for deep events", () => {
  const [magnitude] = matchEvents([event("a:1", "a", 0, { magnitude: 3 })], [event("b:1", "b", 1, { magnitude: 3.6 })]);
  assert.equal(magnitude.consistent, false);
  assert.equal(magnitude.magnitudeDelta, 0.6);
  const [shallow] = matchEvents([event("a:1", "a", 0, { depthKm: 5 })], [event("b:1", "b", 1, { depthKm: 20 })]);
  assert.equal(shallow.consistent, false);
  // 300 km deep: 10% (30 km) is allowed.
  const [deep] = matchEvents([event("a:1", "a", 0, { depthKm: 300 })], [event("b:1", "b", 1, { depthKm: 320 })]);
  assert.equal(deep.consistent, true);
  // Missing values are not a disagreement.
  const [unknown] = matchEvents([event("a:1", "a", 0, { magnitude: null, depthKm: null })], [event("b:1", "b", 1)]);
  assert.deepEqual([unknown.magnitudeDelta, unknown.depthDeltaKm, unknown.consistent], [null, null, true]);
});
