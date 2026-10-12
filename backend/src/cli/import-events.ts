import { parseArgs } from "node:util";
import { env } from "../config/env.js";
import { sqlEventImportStore } from "../data/event-import.repository.js";
import { database } from "../database/client.js";
import {
  DEFAULT_IMPORT_DAYS,
  ImportCooldownError,
  importErrorCode,
  importEvents,
  MAX_IMPORT_DAYS,
} from "../services/event-import.js";
import { createEventSourceAdapter, EVENT_SOURCE_IDS, isEventSourceId } from "../sources/registry.js";
import { INGV_SOURCE_ID } from "../sources/ingv/ingv.adapter.js";

let options: { source: string; days: string; force: boolean };
try {
  options = parseArgs({
    options: {
      source: { type: "string", default: INGV_SOURCE_ID },
      days: { type: "string", default: String(DEFAULT_IMPORT_DAYS) },
      force: { type: "boolean", default: false },
    },
  }).values;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const sourceId = options.source;
const days = Number(options.days);
const force = options.force;

if (!isEventSourceId(sourceId)) {
  console.error(`Unknown --source. Allowed: ${EVENT_SOURCE_IDS.join(", ")}`);
  process.exit(2);
}
if (!Number.isInteger(days) || days < 1 || days > MAX_IMPORT_DAYS) {
  console.error(`--days must be an integer from 1 to ${MAX_IMPORT_DAYS}`);
  process.exit(2);
}

const startedAt = performance.now();
let exitCode = 0;
try {
  const summary = await importEvents({
    adapter: createEventSourceAdapter(sourceId),
    store: sqlEventImportStore,
    days,
    force,
    cooldownSeconds: env.EVENT_IMPORT_COOLDOWN_SECONDS,
  });
  console.log(JSON.stringify({
    outcome: "succeeded",
    ...summary,
    window: { start: summary.window.start.toISOString(), end: summary.window.end.toISOString() },
    durationMs: Math.round(performance.now() - startedAt),
  }, null, 2));
} catch (error) {
  exitCode = 1;
  const code = importErrorCode(error);
  console.error(JSON.stringify({
    outcome: "failed",
    sourceId,
    code,
    retryAfterSeconds: error instanceof ImportCooldownError ? error.retryAfterSeconds : undefined,
    hint: code === "import_cooldown" ? "Wait or pass --force." : undefined,
  }));
  if (code === "import_failed") console.error(error);
} finally {
  await database.close();
}
process.exit(exitCode);
