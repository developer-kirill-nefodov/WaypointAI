import assert from "node:assert/strict";
import test from "node:test";
import { validateClientFrame } from "../src/schemas/websocket.ts";
import { TranscriptionProviderError } from "../src/voice/transcription.provider.ts";
import { clientAddress } from "../src/api/client-address.ts";
import { VoiceBudget } from "../src/voice/voice-budget.ts";
import { VoiceSessionManager } from "../src/voice/voice-session.ts";

const config = { enabled: true, maxSessionMs: 10_000, finishTimeoutMs: 1_000 };

function fakeProvider() {
  const state = { events: undefined, appended: [], finished: false, closed: false, options: undefined };
  const provider = async (options, events) => {
    state.options = options;
    state.events = events;
    return {
      appendAudio: (audio) => state.appended.push(audio),
      finish: () => { state.finished = true; },
      close: () => { state.closed = true; },
    };
  };
  return { provider, state };
}

function createManager(provider, overrides = {}) {
  const sent = [];
  const manager = new VoiceSessionManager({ ...config, ...overrides }, provider, (frame) => sent.push(frame));
  return { manager, sent };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const frame = (type, extra = {}) => ({ protocolVersion: 1, type, requestId: "voice-1", ...extra });

test("streams deltas and finishes with the final transcript", async () => {
  const { provider, state } = fakeProvider();
  const { manager, sent } = createManager(provider);
  manager.handle(frame("voice.start", { language: "de" }));
  await flush();
  assert.deepEqual(sent.map((event) => event.type), ["voice.ready"]);
  assert.equal(state.options.language, "de");

  manager.handle(frame("voice.audio", { audio: "AAAA" }));
  state.events.onDelta("Zeig ");
  state.events.onDelta("Museen");
  manager.handle(frame("voice.stop"));
  assert.equal(state.finished, true);
  state.events.onCompleted(" Zeig Museen ");

  assert.deepEqual(state.appended, ["AAAA"]);
  assert.deepEqual(sent.map((event) => event.type), ["voice.ready", "voice.transcript.delta", "voice.transcript.delta", "voice.transcript.completed", "voice.stopped"]);
  assert.equal(sent[3].text, "Zeig Museen");
  assert.equal(state.closed, true);
  assert.equal(manager.activeRequestId, undefined);
});

test("rejects voice input when the feature is disabled", async () => {
  const { provider } = fakeProvider();
  const { manager, sent } = createManager(provider, { enabled: false });
  manager.handle(frame("voice.start"));
  await flush();
  assert.equal(sent[0].type, "voice.error");
  assert.equal(sent[0].code, "voice_disabled");
  assert.equal(sent[0].retryable, false);
});

test("allows one voice session per connection", async () => {
  const { provider } = fakeProvider();
  const { manager, sent } = createManager(provider);
  manager.handle(frame("voice.start"));
  manager.handle({ ...frame("voice.start"), requestId: "voice-2" });
  await flush();
  assert.deepEqual(sent.map((event) => [event.type, event.requestId]), [["voice.error", "voice-2"], ["voice.ready", "voice-1"]]);
  assert.equal(sent[0].code, "busy");
  manager.dispose();
});

test("ignores audio for another request and before the provider is ready", async () => {
  const { provider, state } = fakeProvider();
  const { manager } = createManager(provider);
  manager.handle(frame("voice.start"));
  manager.handle(frame("voice.audio", { audio: "AAAA" }));
  await flush();
  manager.handle({ ...frame("voice.audio", { audio: "BBBB" }), requestId: "other" });
  assert.deepEqual(state.appended, []);
  manager.dispose();
});

test("maps provider connection failures to safe error codes", async () => {
  const provider = async () => { throw new TranscriptionProviderError("timeout"); };
  const { manager, sent } = createManager(provider);
  manager.handle(frame("voice.start"));
  await flush();
  assert.equal(sent[0].type, "voice.error");
  assert.equal(sent[0].code, "timeout");
  assert.equal(sent[0].retryable, true);
});

test("ends the session when audio exceeds the duration allowance", async () => {
  const { provider, state } = fakeProvider();
  const { manager, sent } = createManager(provider, { maxSessionMs: 10_000 });
  manager.handle(frame("voice.start"));
  await flush();
  const chunk = "A".repeat(12_000);
  for (let index = 0; index < 80; index += 1) manager.handle(frame("voice.audio", { audio: chunk }));
  assert.equal(sent.at(-1).type, "voice.error");
  assert.equal(sent.at(-1).code, "invalid_message");
  assert.equal(state.closed, true);
});

test("stops without a transcript when the provider never completes", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { provider } = fakeProvider();
  const { manager, sent } = createManager(provider);
  manager.handle(frame("voice.start"));
  await flush();
  manager.handle(frame("voice.stop"));
  context.mock.timers.tick(config.finishTimeoutMs);
  assert.deepEqual(sent.map((event) => event.type), ["voice.ready", "voice.stopped"]);
});

test("closes the provider stream when the connection drops", async () => {
  const { provider, state } = fakeProvider();
  const { manager, sent } = createManager(provider);
  manager.handle(frame("voice.start"));
  await flush();
  manager.dispose();
  assert.equal(state.closed, true);
  assert.deepEqual(sent.map((event) => event.type), ["voice.ready"]);
});

test("validates voice frames against the shared schema", () => {
  assert.equal(validateClientFrame(frame("voice.start", { language: "ru" })), true);
  assert.equal(validateClientFrame(frame("voice.audio", { audio: "AAAA" })), true);
  assert.equal(validateClientFrame(frame("voice.stop")), true);
  assert.equal(validateClientFrame(frame("voice.audio", { audio: "not base64!" })), false);
  assert.equal(validateClientFrame(frame("voice.audio", { audio: "A".repeat(12_004) })), false);
  assert.equal(validateClientFrame(frame("voice.start", { language: "fr" })), false);
});

test("refuses a session when the shared budget is exhausted and frees the slot when a session ends", async () => {
  const budget = new VoiceBudget({ maxConcurrentSessions: 1, maxSessionsPerClient: 10, maxSecondsPerClient: 1000, sessionSeconds: 10, windowMs: 60_000 });
  const first = createManager(fakeProvider().provider, { acquireBudget: () => budget.tryAcquire("a") });
  const second = createManager(fakeProvider().provider, { acquireBudget: () => budget.tryAcquire("b") });
  first.manager.handle(frame("voice.start"));
  await flush();
  second.manager.handle(frame("voice.start", { requestId: "voice-2" }));
  await flush();
  assert.equal(second.sent[0].code, "rate_limited");
  assert.equal(second.sent[0].retryable, true);
  first.manager.dispose();
  second.manager.handle(frame("voice.start", { requestId: "voice-3" }));
  await flush();
  assert.equal(second.sent[1].type, "voice.ready");
});

test("limits sessions and reserved seconds per client within a window", () => {
  let time = 0;
  const budget = new VoiceBudget({ maxConcurrentSessions: 10, maxSessionsPerClient: 2, maxSecondsPerClient: 25, sessionSeconds: 10, windowMs: 60_000 }, () => time);
  const one = budget.tryAcquire("203.0.113.5");
  one.release();
  budget.tryAcquire("203.0.113.5").release();
  assert.deepEqual(budget.tryAcquire("203.0.113.5"), { ok: false, reason: "client_limit" });
  assert.equal(budget.tryAcquire("198.51.100.7").ok, true);
  time = 60_000;
  assert.equal(budget.tryAcquire("203.0.113.5").ok, true);
  const seconds = new VoiceBudget({ maxConcurrentSessions: 10, maxSessionsPerClient: 10, maxSecondsPerClient: 25, sessionSeconds: 10, windowMs: 60_000 }, () => 0);
  seconds.tryAcquire("c").release();
  seconds.tryAcquire("c").release();
  assert.deepEqual(seconds.tryAcquire("c"), { ok: false, reason: "client_limit" });
});

test("uses forwarded addresses only for trusted proxy hops", () => {
  const request = { socket: { remoteAddress: "10.0.0.2" }, headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" } };
  assert.equal(clientAddress(request, false), "10.0.0.2");
  assert.equal(clientAddress(request, 1), "203.0.113.9");
  assert.equal(clientAddress(request, 2), "198.51.100.1");
  assert.equal(clientAddress({ socket: { remoteAddress: "10.0.0.2" }, headers: {} }, 1), "10.0.0.2");
});
