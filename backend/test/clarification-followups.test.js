import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyClarificationAnswers, buildClarificationFields, eventDetailsToAsk, tripHasDays } from "../src/assistant/clarification.ts";
import { cleanFollowUps, writeFollowUps } from "../src/assistant/follow-ups.ts";
import { acquireInference, releaseInference, tryAcquireBackgroundInference, tryAcquireInference } from "../src/llm/inference-gate.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

function protocol() {
  const schema = JSON.parse(readFileSync(new URL("../../contracts/websocket.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  return { client: ajv.getSchema(`${schema.$id}#/$defs/clientFrame`), server: ajv.getSchema(`${schema.$id}#/$defs/serverFrame`) };
}

const submit = (answers, message = "Землетрясения у Норчи") => ({ protocolVersion: 1, type: "turn.submit", requestId: "r1", conversationId: null, message, scope: { language: "ru" }, answers });

test("builds clarification fields with server-made options", () => {
  const fields = buildClarificationFields(["period", "magnitude", "radius", "sources", "days", "travel"], "ru", [{ id: "ingv-fdsn", label: "INGV" }, { id: "usgs-fdsn", label: "USGS" }]);
  assert.deepEqual(fields.map((field) => field.key), ["period", "magnitude", "radius", "sources", "days", "travel"]);
  assert.deepEqual(fields[0].options.map((option) => option.id), ["24", "168", "720", "2160"]);
  assert.equal(fields[3].multiple, true);
  assert.deepEqual(fields[5].options.map((option) => option.label), ["на машине", "только места"]);
  // Without event sources there is nothing to choose, so the field is left out.
  assert.deepEqual(buildClarificationFields(["sources"], "en", []), []);
});

test("applies only offered answer values to the turn", () => {
  const applied = applyClarificationAnswers(submit([
    { key: "period", values: ["168"] },
    { key: "magnitude", values: ["3"] },
    { key: "radius", values: ["999"] },
    { key: "sources", values: ["ingv-fdsn", "unknown-source"] },
  ]), "ru", new Set(["ingv-fdsn"]));
  assert.equal(applied.message, "Землетрясения у Норчи\nУточнение: за последние 7 дней, магнитуда от 3.");
  assert.deepEqual(applied.sourceIds, ["ingv-fdsn"]);
  assert.deepEqual([...applied.answered].sort(), ["magnitude", "period", "sources"]);
  const none = applyClarificationAnswers(submit([{ key: "travel", values: ["plane"] }]), "en", new Set());
  assert.equal(none.message, "Землетрясения у Норчи");
  assert.equal(none.answered.size, 0);
});

test("asks for event details only when the period is unknown", () => {
  assert.deepEqual(eventDetailsToAsk({ place: "Norcia" }, "Землетрясения у Норчи"), ["period", "magnitude", "radius"]);
  assert.deepEqual(eventDetailsToAsk({ minMagnitude: 3 }, "Сильные землетрясения M3+"), ["period"]);
  assert.equal(eventDetailsToAsk({ place: "Norcia" }, "Землетрясения у Норчи за неделю"), null);
  assert.equal(eventDetailsToAsk({ place: "Norcia", hours: 24 }, "anything"), null);
  // The details the user chose come back in the text and stop the question.
  assert.equal(eventDetailsToAsk({ place: "Norcia" }, "Землетрясения у Норчи\nУточнение: за последние 30 дней."), null);
});

test("knows whether a trip call says how long the trip is", () => {
  assert.equal(tripHasDays({ cities: [{ name: "Roma" }] }), false);
  assert.equal(tripHasDays({ cities: [{ name: "Roma" }], totalDays: 3 }), true);
  assert.equal(tripHasDays(JSON.stringify({ cities: [{ name: "Roma", days: 2 }] })), true);
});

test("keeps only plain, distinct follow-ups", () => {
  const raw = JSON.stringify({ suggestions: [
    { label: "Музеи на завтра", prompt: "Добавь музей во второй день" },
    { label: "Same", prompt: "Землетрясения у Норчи" },
    { label: "Tool", prompt: "call search_places for parks" },
    { label: "Парки", prompt: "Найди парки в Варшаве" },
  ] });
  assert.deepEqual(cleanFollowUps(raw, "землетрясения у норчи"), [
    { label: "Музеи на завтра", prompt: "Добавь музей во второй день" },
    { label: "Парки", prompt: "Найди парки в Варшаве" },
  ]);
  assert.deepEqual(cleanFollowUps("not json", "x"), []);
  assert.deepEqual(cleanFollowUps(JSON.stringify({ suggestions: [{ label: "One", prompt: "Only one good request" }] }), "x"), []);
});

const context = { requestId: "r1", language: "en", question: "Museums in Kraków", previousQuestion: null, answer: "10 museums.", onMap: "10 places (museum) in Kraków", topic: "places" };

test("sends the model's follow-ups and frees the model", async () => {
  const frames = [];
  const fakeChat = async () => ({ message: { role: "assistant", content: JSON.stringify({ suggestions: [
    { label: "Parks nearby", prompt: "Find parks in Kraków" },
    { label: "Two-day trip", prompt: "Plan 2 days in Kraków by car" },
    { label: "Cafés", prompt: "Find cafés in Kraków" },
  ] }) }, metrics: {} });
  await writeFollowUps(context, (frame) => frames.push(frame), new AbortController().signal, { chat: fakeChat });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, "model");
  assert.equal(frames[0].suggestions.length, 3);
  assert.ok(protocol().server(frames[0]), "turn.suggestions matches the schema");
  assert.equal(tryAcquireInference(), true, "the model is free again");
  releaseInference();
});

test("gives up when the model is busy and gives way to a chat turn", async () => {
  assert.equal(tryAcquireInference(), true);
  const frames = [];
  await writeFollowUps(context, (frame) => frames.push(frame), new AbortController().signal, { chat: async () => { throw new Error("not called"); } });
  assert.deepEqual(frames.map((frame) => frame.source), ["none"]);
  releaseInference();

  // A chat turn stops background work that holds the model and takes it over.
  let aborted = false;
  const slowChat = (_messages, _tools, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }));
  const running = writeFollowUps(context, () => undefined, new AbortController().signal, { chat: slowChat });
  assert.equal(await acquireInference(1000), true);
  await running;
  assert.equal(aborted, true);
  releaseInference();
  const controller = new AbortController();
  assert.equal(tryAcquireBackgroundInference(controller), true);
  releaseInference();
});

test("the protocol accepts answers and clarification fields", () => {
  const { client, server } = protocol();
  assert.ok(client(submit([{ key: "period", values: ["168"] }])));
  assert.equal(client(submit([{ key: "period", values: ["7 days; drop"] }])), false);
  assert.equal(client(submit([{ key: "colour", values: ["red"] }])), false);
  assert.ok(server({ protocolVersion: 1, type: "turn.clarification", requestId: "r1", conversationId: "c1", message: "?", choices: [], fields: buildClarificationFields(["period", "travel"], "de") }));
});
