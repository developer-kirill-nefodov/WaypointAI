import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { templateFollowUps } from "../src/assistant/follow-up-templates.ts";
import { formatPlaceResultsMessage } from "../src/assistant/place-results-message.ts";
import { buildRoutePlan, formatRoutePlacesMessage } from "../src/assistant/route-places.ts";
import { trimHistory } from "../src/data/conversation.repository.ts";
import { searchPlacesArgs } from "../src/tools/assistant-tools.ts";
import { routePlacesArgsValid } from "../src/tools/route-places.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

function serverFrame() {
  const schema = JSON.parse(readFileSync(new URL("../../contracts/websocket.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  return ajv.getSchema(`${schema.$id}#/$defs/serverFrame`);
}

const place = (index, lat, lon) => ({ id: `p${index}`, sourceId: "osm-ro-romania", name: `Place ${index}`, category: "tourism:attraction", countryCode: "RO", city: "București", postcode: null, street: null, houseNumber: null, lat, lon, details: {} });

test("places follow-ups offer the next page, a route, and another kind in the same city", () => {
  const items = templateFollowUps({ topic: "places", city: "București", kind: "attraction", shown: 10, total: 46, offset: 0 }, "ru");
  assert.deepEqual(items.map((item) => item.prompt), [
    "Покажи ещё достопримечательности в București, кроме уже показанных",
    "Построй маршрут на машине по найденным местам",
    "Найди музеи в București",
  ]);
  // The last page has nothing more to show, and a single place has no route.
  const last = templateFollowUps({ topic: "places", city: "Kraków", kind: "museum", shown: 1, total: 41, offset: 40 }, "en");
  assert.deepEqual(last.map((item) => item.label), ["Parks in Kraków", "2-day plan"]);
});

test("trip and event follow-ups name what they change", () => {
  assert.deepEqual(templateFollowUps({ topic: "trip", days: 2, travelMode: "driving" }, "en").map((item) => item.prompt), [
    "Add a museum to day 1", "Add one more day with parks", "Remove the route, keep the places only",
  ]);
  const events = templateFollowUps({ topic: "events", place: "Perugia", radiusKm: 50, hours: 720, minMagnitude: null }, "ru");
  assert.deepEqual(events.map((item) => item.prompt), [
    "Землетрясения магнитудой от 3 в радиусе 50 км от Perugia за последние 30 дней",
    "Землетрясения в радиусе 50 км от Perugia за последние 90 дней",
    "Самое сильное землетрясение в радиусе 50 км от Perugia за последние 30 дней",
  ]);
  assert.deepEqual(templateFollowUps({ topic: "other" }, "de"), []);
});

test("turn.completed may carry the server's follow-ups", () => {
  const validate = serverFrame();
  const frame = {
    protocolVersion: 1, type: "turn.completed", requestId: "r1", conversationId: "c1", assistantMessage: "ok", appliedFilters: [],
    result: { total: 0, records: [], mapFeatures: { type: "FeatureCollection", features: [] } }, sources: [],
    suggestions: templateFollowUps({ topic: "places", city: "Roma", kind: "museum", shown: 10, total: 30, offset: 0 }, "de"),
  };
  assert.ok(validate(frame), JSON.stringify(validate.errors));
  assert.ok(validate({ ...frame, type: "tool.started", tool: "route_places", label: "Route" }), "route_places is a known tool");
});

test("a later page of a place search says which matches it shows", () => {
  const search = { kind: "attraction", city: "București", query: null, category: null, offset: 10 };
  const places = Array.from({ length: 10 }, (_, index) => place(index, 44.43, 26.1));
  const message = formatPlaceResultsMessage(search, places, 46, "ru");
  assert.match(message, /: 11–20 из 46\./);
  assert.match(message, /\n11\. Place 0/);
  assert.match(formatPlaceResultsMessage({ ...search, offset: 50 }, [], 46, "en"), /all 46 were already shown/);
  assert.ok(searchPlacesArgs.safeParse({ kind: "attraction", city: "București", offset: 10 }).success);
  assert.equal(searchPlacesArgs.safeParse({ kind: "attraction", offset: 50 }).success, false);
});

test("a route through found places visits the nearest next and splits long routes into days", () => {
  // Places on a line, listed out of order: the route goes along the line from the first listed place.
  const found = [place(0, 44.40, 26.10), place(3, 44.43, 26.10), place(1, 44.41, 26.10), place(2, 44.42, 26.10)];
  const short = buildRoutePlan(found, "București");
  assert.deepEqual(short.days.map((day) => day.stopPlaceIds), [["p0", "p1", "p2", "p3"]]);
  assert.equal(short.travelMode, "driving");
  assert.equal(short.days[0].routeStatus, "pending");
  assert.equal(short.countryCode, "RO");

  const ten = Array.from({ length: 10 }, (_, index) => place(index, 44.40 + index * 0.01, 26.10));
  const long = buildRoutePlan([...ten, ten[0]], null);
  assert.deepEqual(long.days.map((day) => day.stopPlaceIds.length), [5, 5], "a repeated place counts once");
  assert.equal(long.city, "București");
  assert.match(formatRoutePlacesMessage(long, ten, "ru"), /^Маршрут на машине по найденным местам \(București\): 10 точек, по дням: 2\./);
});

test("route_places takes no arguments", () => {
  for (const empty of [undefined, null, "", "{}", {}]) assert.equal(routePlacesArgsValid(empty), true);
  assert.equal(routePlacesArgsValid({ places: ["p1"] }), false);
  assert.equal(routePlacesArgsValid("[1]"), false);
});

test("trimmed history starts at a user message, so a tool result keeps its call", () => {
  const turn = (index) => [
    { role: "user", content: `question ${index}` },
    { role: "assistant", content: "", toolCalls: [{ name: "search_places", arguments: { city: "Roma" } }] },
    { role: "tool", toolName: "search_places", content: "{}" },
    { role: "assistant", content: `answer ${index}` },
  ];
  const messages = Array.from({ length: 7 }, (_, index) => turn(index)).flat();
  const trimmed = trimHistory(messages);
  assert.ok(trimmed.length <= 20);
  assert.equal(trimmed[0].content, "question 0");
  assert.equal(trimmed[1].role, "user");
  assert.equal(trimmed.at(-1).content, "answer 6");
  for (const [index, message] of trimmed.entries()) {
    if (message.role === "tool") assert.ok(trimmed[index - 1].toolCalls?.length, "a tool result follows its call");
  }
});
