import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { parseRouterOutput, routerMessages, ROUTER_SYSTEM_PROMPT } from "../src/assistant/router.ts";
import { buildDataset, datasetSummary, toJsonl } from "../src/services/training-dataset.ts";
import { createJournalRouter } from "../src/api/journal.ts";
import { createFinetuneRouter } from "../src/api/finetune.ts";
import { errorHandler } from "../src/api/error-handler.ts";

test("accepts a router answer only when the tool's own schema accepts its arguments", () => {
  assert.deepEqual(parseRouterOutput('{"tool":"search_places","args":{"kind":"museum","city":"Kraków"}}'), { ok: true, tool: "search_places", args: { kind: "museum", city: "Kraków" } });
  // Nulls for omitted fields are dropped, as for tool calls of the full prompt.
  assert.equal(parseRouterOutput('{"tool":"search_events","args":{"place":"Norcia","hours":72,"radiusKm":null}}').ok, true);
  assert.equal(parseRouterOutput('{"tool":"search_events","args":{"lat":42.8,"lon":13.1}}').error, "invalid_args");
  assert.equal(parseRouterOutput('{"tool":"drop_tables","args":{}}').error, "unknown_tool");
  assert.equal(parseRouterOutput("call search_places").error, "invalid_json");
  assert.deepEqual(parseRouterOutput('{"tool":"reply","args":{}}'), { ok: true, tool: "reply", args: {} });
  // A ready answer in reply's arguments is dropped rather than failing the call.
  assert.deepEqual(parseRouterOutput('{"tool":"reply","args":{"message":"Bitte!"}}'), { ok: true, tool: "reply", args: {} });
  assert.ok(ROUTER_SYSTEM_PROMPT.length < 2000);
  assert.match(routerMessages("hi", true)[0].content, /selected a point/);
});

test("builds router training data without benchmark questions and with confirmed journal turns", () => {
  const cities = [{ name: "Testopoli", nameEn: "Testopolis", countryCode: "XT" }, { name: "Mockburg", nameEn: null, countryCode: "XT" }];
  const eventTowns = [{ name: "Quietville", nameEn: null, countryCode: "XT" }];
  const all = buildDataset({ cities, eventTowns, benchmarkQuestions: [], confirmed: [], perSkill: 10, seed: 3 });
  const banned = all.examples[0].messages[1].content;
  const { examples, excludedAsBenchmark } = buildDataset({
    cities, eventTowns, benchmarkQuestions: [banned.toUpperCase()], perSkill: 10, seed: 3,
    confirmed: [{ message: "Землетрясения у Норчи", language: "ru", corrected: { tool: "search_events", args: { place: "Norcia" } } }],
  });
  assert.equal(excludedAsBenchmark, 1);
  assert.ok(!examples.some((example) => example.messages[1].content === banned));
  const journal = examples.find((example) => example.meta.source === "journal");
  assert.deepEqual(JSON.parse(journal.messages[2].content), { tool: "search_events", args: { place: "Norcia" } });
  // Every target is a call the router parser accepts.
  for (const example of examples) assert.equal(parseRouterOutput(example.messages[2].content).ok, true, example.messages[2].content);
  const summary = datasetSummary(examples);
  assert.equal(summary.total, examples.length);
  assert.equal(summary.bySource.journal, 1);
  const lines = toJsonl(examples).trim().split("\n");
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ["messages"]);
});

async function serve(app) {
  return new Promise((resolve) => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
}

test("reviews journal turns with tool validation and adds them to the benchmark; aliases cannot hide a settlement", async () => {
  const entry = { id: "11111111-1111-4111-8111-111111111111", message: "Что трясло у Норчи?", language: "ru", toolCalls: [], corrected: null };
  const added = [];
  const saved = [];
  const app = express();
  app.use(express.json());
  app.use("/t", createJournalRouter({
    enabled: true,
    journal: {
      list: async () => ({ total: 0, entries: [] }), get: async (id) => (id === entry.id ? entry : null), review: async (id, review) => ({ ...entry, ...review }),
      feedback: async (requestId) => requestId === "known", stats: async () => ({}), gaps: async () => ({ missingPlaces: [], emptySearches: [] }),
    },
    aliases: { list: async () => [], save: async (...args) => { saved.push(args); }, remove: async () => true, resolve: async (name) => ({ norcia: { id: "osm:node:1", name: "Norcia" }, cascia: { id: "osm:node:2", name: "Cascia" } })[name.toLowerCase()] ?? null },
    addCase: async (item) => { added.push(item); },
  }));
  app.use(errorHandler);
  const server = await serve(app);
  const url = (path) => `http://127.0.0.1:${server.address().port}/t${path}`;
  const post = (path, body) => fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(`/journal/${entry.id}/review`, { status: "confirmed", tool: "search_events", args: { lat: 1 } })).status, 400);
    assert.equal((await post(`/journal/${entry.id}/review`, { status: "confirmed", tool: "search_events", args: { place: "Norcia", hours: 168 } })).status, 200);
    assert.deepEqual(added[0].expect, { tool: "search_events", args: { place: "Norcia", hours: 168 } });
    assert.equal(added[0].origin, "journal");
    assert.equal((await post("/journal/feedback", { requestId: "known", rating: -1 })).status, 204);
    assert.equal((await post("/journal/feedback", { requestId: "other", rating: 1 })).status, 404);
    assert.equal((await post("/aliases", { alias: "Норча", settlement: "Norcia" })).status, 201);
    assert.equal((await post("/aliases", { alias: "Cascia", settlement: "Norcia" })).status, 409);
    assert.equal((await post("/aliases", { alias: "Нигде", settlement: "Nowhere" })).status, 404);
    assert.deepEqual(saved, [["Норча", "osm:node:1", "manual"]]);
  } finally { server.close(); }
});

test("starts fine-tuning only with valid settings and reports a missing environment", async () => {
  const started = [];
  let available = { python: false, dataset: true };
  const app = express();
  app.use(express.json());
  app.use("/f", createFinetuneRouter({
    enabled: true,
    trainer: {
      availability: () => available, list: async () => [], active: null, cancel: () => false, publish: async () => "waypoint-router:x",
      start: async (input) => {
        if (!available.python) { const { TrainerUnavailableError } = await import("../src/services/lora-trainer.ts"); throw new TrainerUnavailableError("python_missing"); }
        started.push(input); return { id: "20261016-abcdef", ...input };
      },
    },
    dataset: { last: async () => null, build: async () => ({ total: 1 }) },
    uploads: "/nonexistent",
  }));
  const server = await serve(app);
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}/f${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.deepEqual(await (await post("/runs", { baseModel: "Qwen/Qwen3-0.6B" })).json(), { error: "python_missing" });
    available = { python: true, dataset: true };
    assert.equal((await post("/runs", { baseModel: "evil/model" })).status, 400);
    assert.equal((await post("/runs", { baseModel: "Qwen/Qwen3-0.6B", epochs: 50 })).status, 400);
    assert.equal((await post("/runs", { baseModel: "Qwen/Qwen3-0.6B" })).status, 202);
    assert.deepEqual(started[0], { baseModel: "Qwen/Qwen3-0.6B", epochs: 2, learningRate: 2e-4, rank: 16, autoBenchmark: false });
    assert.equal((await post("/runs/../../etc/publish", {})).status, 404);
    assert.equal((await post("/runs/bad-id/publish", {})).status, 400);
  } finally { server.close(); }
});
