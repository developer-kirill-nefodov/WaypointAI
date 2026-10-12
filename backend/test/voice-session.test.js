import assert from "node:assert/strict";
import test from "node:test";
import { validateClientFrame } from "../src/schemas/websocket.ts";
import { TranscriptionProviderError } from "../src/voice/transcription.provider.ts";
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
