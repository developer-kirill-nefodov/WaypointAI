import { env } from "../config/env.js";
import { createIngvAdapter, INGV_SOURCE_ID } from "./ingv/ingv.adapter.js";
import type { EventSourceAdapter } from "./source-adapter.js";
import { createSyntheticAdapter, SYNTHETIC_SOURCE_ID } from "./synthetic/synthetic.adapter.js";

export const EVENT_SOURCE_IDS = [INGV_SOURCE_ID, SYNTHETIC_SOURCE_ID] as const;
export type EventSourceId = typeof EVENT_SOURCE_IDS[number];

export const EVENT_SOURCE_USER_AGENT = "WaypointAI-demo/0.1 (+https://github.com/developer-kirill-nefodov/WaypointAI)";

export function isEventSourceId(value: string): value is EventSourceId {
  return (EVENT_SOURCE_IDS as readonly string[]).includes(value);
}

/** Allowlisted import sources; an unknown ID never reaches an adapter. */
export function createEventSourceAdapter(sourceId: EventSourceId): EventSourceAdapter {
  if (sourceId === INGV_SOURCE_ID) {
    return createIngvAdapter({
      baseUrl: env.EVENT_SOURCE_INGV_URL,
      bbox: env.EVENT_IMPORT_BBOX,
      timeoutMs: env.EVENT_IMPORT_TIMEOUT_MS,
      userAgent: EVENT_SOURCE_USER_AGENT,
    });
  }
  return createSyntheticAdapter();
}
