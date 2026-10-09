import assert from "node:assert/strict";
import test from "node:test";
import { ActiveTurnGate } from "../src/api/active-turn.ts";

function turn(requestId) {
  return { requestId, controller: new AbortController() };
}

test("acquires synchronously and rejects overlapping turns", () => {
  const gate = new ActiveTurnGate();
  const first = turn("first");
  const second = turn("second");
  assert.equal(gate.tryAcquire(first), true);
  assert.equal(gate.tryAcquire(second), false);
  assert.equal(gate.current, first);
});

test("only releases the turn that owns the gate", () => {
  const gate = new ActiveTurnGate();
  const first = turn("first");
  const other = turn("other");
  gate.tryAcquire(first);
  gate.release(other);
  assert.equal(gate.current, first);
  gate.release(first);
  assert.equal(gate.current, undefined);
});
