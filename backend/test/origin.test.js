import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedOrigin } from "../src/api/origin.ts";

const configured = "http://127.0.0.1:5173";

test("accepts the exact configured origin in every environment", () => {
  assert.equal(isAllowedOrigin(configured, configured, "production"), true);
  assert.equal(isAllowedOrigin(configured, configured, "development"), true);
});

test("accepts loopback aliases with the same scheme and port in development", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173", configured, "development"), true);
  assert.equal(isAllowedOrigin("http://[::1]:5173", configured, "development"), true);
});

test("rejects loopback aliases outside development", () => {
  assert.equal(isAllowedOrigin("http://localhost:5173", configured, "production"), false);
  assert.equal(isAllowedOrigin("http://localhost:5173", configured, "test"), false);
});

test("rejects other ports, schemes, hosts, and missing origins", () => {
  assert.equal(isAllowedOrigin("http://localhost:5174", configured, "development"), false);
  assert.equal(isAllowedOrigin("https://localhost:5173", configured, "development"), false);
  assert.equal(isAllowedOrigin("http://evil.example:5173", configured, "development"), false);
  assert.equal(isAllowedOrigin("http://localhost.evil.example:5173", configured, "development"), false);
  assert.equal(isAllowedOrigin("null", configured, "development"), false);
  assert.equal(isAllowedOrigin(undefined, configured, "development"), false);
});

test("does not widen a non-loopback configured origin", () => {
  assert.equal(isAllowedOrigin("http://localhost:443", "https://app.example", "development"), false);
});
