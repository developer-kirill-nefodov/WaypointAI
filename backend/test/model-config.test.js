import assert from "node:assert/strict";
import test from "node:test";
import { isLocalOllamaUrl, modelEnvironmentSchema } from "../src/config/model.ts";

test("accepts IPv4, IPv6, and hostname loopback Ollama addresses", () => {
  for (const value of ["http://127.0.0.1:11434", "http://[::1]:11434", "http://localhost:11434"]) {
    assert.equal(isLocalOllamaUrl(value), true, value);
  }
});

test("rejects non-loopback Ollama endpoints", () => {
  for (const value of ["https://ollama.example.com", "http://192.168.1.5:11434", "not a URL"]) {
    assert.equal(isLocalOllamaUrl(value), false, value);
  }
});

test("validates configurable generation settings and defaults", () => {
  const parsed = modelEnvironmentSchema.parse({});
  assert.equal(parsed.OLLAMA_NUM_CONTEXT, 8192);
  assert.equal(parsed.OLLAMA_NUM_PREDICT, 768);
  assert.equal(modelEnvironmentSchema.safeParse({ OLLAMA_NUM_PREDICT: "10000" }).success, false);
});
