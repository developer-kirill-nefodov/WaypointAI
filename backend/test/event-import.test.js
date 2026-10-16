import assert from "node:assert/strict";
import test from "node:test";
import { ImportAlreadyRunningError, importEvents } from "../src/services/event-import.ts";
import { SourceFetchError } from "../src/sources/source-adapter.ts";

/** In-memory store with the same semantics as the SQL store: upsert by external ID, update only on revision change. */
function memoryStore() {
  const records = new Map();
  const runs = [];
  return {
    records,
    runs,
    async registerSource() {},
    async failStaleRuns(sourceId, startedBefore) {
      let count = 0;
      for (const run of runs) if (run.sourceId === sourceId && run.status === "running" && run.startedAt < startedBefore) { run.status = "failed"; run.errorCode = "stale_run"; count += 1; }
      return count;
    },
    async lastRunStartedAt(sourceId) {
      return runs.filter((run) => run.sourceId === sourceId && run.status !== "failed").map((run) => run.startedAt).sort((a, b) => b - a)[0] ?? null;
    },
    async startRun(sourceId, window, startedAt) {
      if (runs.some((run) => run.sourceId === sourceId && run.status === "running")) throw new ImportAlreadyRunningError("import_running");
      const run = { id: `run-${runs.length + 1}`, sourceId, window, startedAt, status: "running" };
      runs.push(run);
      return run.id;
    },
    async upsertEvents(sourceId, events) {
      const result = { insertedIds: [], updatedIds: [], unchanged: 0 };
      for (const event of events) {
        const id = `${sourceId}:${event.externalId}`;
        const existing = records.get(id);
        if (!existing) { records.set(id, event); result.insertedIds.push(id); }
        else if (existing.revision !== event.revision) { records.set(id, event); result.updatedIds.push(id); }
        else result.unchanged += 1;
      }
      return result;
    },
    linked: new Set(),
    async linkNearbyPlaces(recordIds) {
      if (this.failLinking) throw new Error("link failed");
      for (const id of recordIds) this.linked.add(id);
      return recordIds.length;
    },
    matchedWindows: [],
    async matchAcrossSources(sourceId, window) { this.matchedWindows.push({ sourceId, window }); return 0; },
    async findUnlinkedRecordIds(sourceId) {
      return [...records.keys()].filter((id) => id.startsWith(`${sourceId}:`) && !this.linked.has(id));
    },
    async finishRun(runId, outcome) { Object.assign(runs.find((run) => run.id === runId), outcome); },
  };
}

function event(externalId, revision = "1") {
  return { externalId, observedAt: new Date("2026-10-12T10:00:00Z"), lat: 42, lon: 13, category: "seismic:earthquake", revision, attributes: {} };
}

function adapter(fetchEvents) {
  return { descriptor: { id: "test-source", label: "Test", mode: "synthetic_local", license: "CC0-1.0", attribution: "test", sourceUrl: null }, fetchEvents };
}

const now = new Date("2026-10-13T00:00:00Z");
const base = { days: 7, cooldownSeconds: 0, now, windowDays: 7 };

test("a repeated import inserts nothing and counts unchanged events as skipped", async () => {
  const store = memoryStore();
  const source = adapter(async () => ({ events: [event("1"), event("2")], skipped: 1, truncated: false }));
  const first = await importEvents({ ...base, adapter: source, store });
  const second = await importEvents({ ...base, adapter: source, store });
  assert.deepEqual(first.counts, { fetched: 2, inserted: 2, updated: 0, skipped: 1 });
  assert.deepEqual(second.counts, { fetched: 2, inserted: 0, updated: 0, skipped: 3 });
  assert.equal(store.records.size, 2);
  assert.deepEqual(store.runs.map((run) => run.status), ["succeeded", "succeeded"]);
});

test("a revised event is updated, not duplicated", async () => {
  const store = memoryStore();
  await importEvents({ ...base, store, adapter: adapter(async () => ({ events: [event("1", "a")], skipped: 0, truncated: false })) });
  const summary = await importEvents({ ...base, store, adapter: adapter(async () => ({ events: [event("1", "b")], skipped: 0, truncated: false })) });
  assert.equal(summary.counts.updated, 1);
  assert.equal(store.records.get("test-source:1").revision, "b");
});

test("duplicate events inside one response are imported once", async () => {
  const store = memoryStore();
  const summary = await importEvents({ ...base, store, adapter: adapter(async () => ({ events: [event("1"), event("1")], skipped: 0, truncated: false })) });
  assert.equal(summary.counts.fetched, 1);
  assert.equal(store.records.size, 1);
});

test("an upstream failure records a failed run and keeps existing data", async () => {
  const store = memoryStore();
  await importEvents({ ...base, store, adapter: adapter(async () => ({ events: [event("1")], skipped: 0, truncated: false })) });
  await assert.rejects(
    importEvents({ ...base, store, adapter: adapter(async () => { throw new SourceFetchError("upstream_unavailable", true); }) }),
    { code: "upstream_unavailable" },
  );
  assert.equal(store.records.size, 1);
  assert.equal(store.runs.at(-1).status, "failed");
  assert.equal(store.runs.at(-1).errorCode, "upstream_unavailable");
});

test("enforces the cooldown unless forced", async () => {
  const store = memoryStore();
  const source = adapter(async () => ({ events: [], skipped: 0, truncated: false }));
  await importEvents({ ...base, cooldownSeconds: 600, store, adapter: source });
  await assert.rejects(
    importEvents({ ...base, cooldownSeconds: 600, now: new Date(now.getTime() + 60_000), store, adapter: source }),
    (error) => error.code === "import_cooldown" && error.retryAfterSeconds === 540,
  );
  await importEvents({ ...base, cooldownSeconds: 600, now: new Date(now.getTime() + 60_000), force: true, store, adapter: source });
});

test("rejects a concurrent run and clears a stale one", async () => {
  const store = memoryStore();
  store.runs.push({ id: "old", sourceId: "test-source", startedAt: new Date(now.getTime() - 60_000), status: "running" });
  const source = adapter(async () => ({ events: [], skipped: 0, truncated: false }));
  await assert.rejects(importEvents({ ...base, store, adapter: source }), { code: "import_running" });
  store.runs[0].startedAt = new Date(now.getTime() - 31 * 60_000);
  await importEvents({ ...base, store, adapter: source });
  assert.equal(store.runs[0].errorCode, "stale_run");
});

test("splits a truncated window until pages fit", async () => {
  const store = memoryStore();
  const windows = [];
  const source = adapter(async (window) => {
    windows.push(window);
    const days = (window.end - window.start) / 86_400_000;
    return days > 2
      ? { events: [event(`w${windows.length}`)], skipped: 0, truncated: true }
      : { events: [event(`ok-${window.start.toISOString()}`)], skipped: 0, truncated: false };
  });
  const summary = await importEvents({ ...base, store, adapter: source });
  assert.equal(summary.truncated, false);
  assert.ok(windows.length > 1);
  assert.ok([...store.records.keys()].every((id) => id.includes(":ok-")));
});

test("validates the import window", async () => {
  const source = adapter(async () => ({ events: [], skipped: 0, truncated: false }));
  await assert.rejects(importEvents({ ...base, days: 0, store: memoryStore(), adapter: source }), RangeError);
  await assert.rejects(importEvents({ ...base, days: 31, store: memoryStore(), adapter: source }), RangeError);
});

test("links events left unlinked by a failed link step on the next run", async () => {
  const store = memoryStore();
  const source = adapter(async () => ({ events: [event("1"), event("2")], skipped: 0, truncated: false }));
  store.failLinking = true;
  await assert.rejects(importEvents({ ...base, store, adapter: source }), /link failed/);
  assert.equal(store.runs.at(-1).status, "failed");
  store.failLinking = false;
  const retry = await importEvents({ ...base, store, adapter: source });
  assert.deepEqual(retry.counts, { fetched: 2, inserted: 0, updated: 0, skipped: 2 });
  assert.equal(retry.linkedPlaces, 2);
  assert.deepEqual([...store.linked].sort(), ["test-source:1", "test-source:2"]);
});

test("a failed run does not start the cooldown", async () => {
  const store = memoryStore();
  await assert.rejects(
    importEvents({ ...base, cooldownSeconds: 600, store, adapter: adapter(async () => { throw new SourceFetchError("upstream_unavailable", true); }) }),
    { code: "upstream_unavailable" },
  );
  const retry = await importEvents({ ...base, cooldownSeconds: 600, now: new Date(now.getTime() + 60_000), store, adapter: adapter(async () => ({ events: [], skipped: 0, truncated: false })) });
  assert.equal(retry.counts.fetched, 0);
});
