import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chat } from "../src/llm/ollama.provider.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

/** A fake Ollama /api/chat stream: one JSON object per line, as the runtime sends it. */
function stream(chunks) {
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(chunk)}\n`)); controller.close(); } });
  return new Response(body, { status: 200 });
}

test("counts streamed tokens for progress without passing a tool-choice text on", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return stream([
      { message: { role: "assistant", content: "{\"tool\"" }, done: false },
      { message: { role: "assistant", content: ":\"reply\"}" }, done: false },
      { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "reply", arguments: {} } }] }, done: false },
      { message: { role: "assistant", content: "" }, done: true, eval_count: 3, total_duration: 2_000_000 },
    ]);
  };
  try {
    const counts = [];
    const result = await chat([{ role: "user", content: "hi" }], [], new AbortController().signal, { onToken: (tokens) => counts.push(tokens) });
    assert.equal(requests[0].stream, true);
    assert.deepEqual(counts, [1, 2, 3]);
    assert.equal(result.message.content, "{\"tool\":\"reply\"}");
    assert.equal(result.message.tool_calls[0].function.name, "reply");
    assert.equal(result.metrics.generatedTokenCount, 3);
    // Without onDelta or onToken the call is not streamed.
    globalThis.fetch = async (url, init) => { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } })); };
    await chat([{ role: "user", content: "hi" }], [], new AbortController().signal);
    assert.equal(requests[1].stream, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("describes turn.progress, step durations, and the models of a turn in the WebSocket contract", () => {
  const schema = JSON.parse(readFileSync(new URL("../../contracts/websocket.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const server = ajv.getSchema(`${schema.$id}#/$defs/serverFrame`);
  const base = { protocolVersion: 1, requestId: "req-1" };
  assert.equal(server({ ...base, type: "turn.progress", stepId: "step-1", phase: "generating", tokens: 23, tokensPerSecond: 11.4 }), true);
  assert.equal(server({ ...base, type: "turn.progress", stepId: "step-1", phase: "thinking", tokens: 1 }), false);
  assert.equal(server({ ...base, type: "turn.step", stepId: "step-1", label: "Understanding", state: "done", durationMs: 4800 }), true);
  assert.equal(server({ ...base, type: "turn.completed", conversationId: "c", assistantMessage: "ok", appliedFilters: [], result: { total: 0, records: [], mapFeatures: { type: "FeatureCollection", features: [] } }, sources: [], models: ["qwen3:4b"] }), true);
});

test("reports steps with durations and throttles token progress on the latest running step", async () => {
  const { TurnReporter, PROGRESS_INTERVAL_MS } = await import("../src/assistant/turn-reporter.ts");
  let clock = 0;
  const frames = [];
  const reporter = new TurnReporter("req-1", (frame) => frames.push(frame), () => clock);
  const outer = reporter.step("Understanding");
  const onToken = reporter.modelProgress();
  clock = 100; onToken(1);
  clock = 150; onToken(2);
  clock = 100 + PROGRESS_INTERVAL_MS + 1; onToken(3);
  clock = 1000; outer.done("ok");
  onToken(4);
  reporter.models.add("model-a");
  reporter.emit({ protocolVersion: 1, type: "turn.completed", requestId: "req-1", conversationId: "c", assistantMessage: "", appliedFilters: [], result: { total: 0, records: [], mapFeatures: { type: "FeatureCollection", features: [] } }, sources: [] });
  const progress = frames.filter((frame) => frame.type === "turn.progress");
  assert.deepEqual(progress.map((frame) => [frame.phase, frame.tokens]), [["reading", 0], ["generating", 1], ["generating", 3]]);
  assert.ok(progress.every((frame) => frame.stepId === "step-1"));
  assert.equal(progress[2].tokensPerSecond, 8);
  const done = frames.find((frame) => frame.type === "turn.step" && frame.state === "done");
  assert.equal(done.durationMs, 1000);
  assert.equal(done.detail, "ok");
  assert.deepEqual(frames.at(-1).models, ["model-a"]);
});

test("notes how a turn ended for the journal", async () => {
  const { TurnReporter } = await import("../src/assistant/turn-reporter.ts");
  const reporter = new TurnReporter("req-2", () => undefined);
  reporter.emit({ protocolVersion: 1, type: "turn.error", requestId: "req-2", code: "timeout", message: "x", retryable: true });
  assert.deepEqual(reporter.ending, { errorCode: "timeout", clarification: false, cancelled: false });
});
