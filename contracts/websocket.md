# WebSocket contract v1

This is the canonical description of assistant messages. `contracts/openapi.yaml` defines HTTP endpoints and publishes the WebSocket path. Update this document together with frontend and backend changes.

## Connection

- Local URL: `ws://127.0.0.1:8000/api/v1/assistant/ws`.
- Production URL: `wss://<same-origin>/api/v1/assistant/ws`.
- The backend validates `Origin` against `FRONTEND_ORIGIN` and uses the same authentication/authorization as the HTTP API. Production requires an exact match. In `development`, the `localhost`, `127.0.0.1`, and `[::1]` aliases of a loopback `FRONTEND_ORIGIN` with the same scheme and port are also accepted.
- Never put messages, IDs, tokens, or personal fields in a query string.
- All messages are UTF-8 JSON text frames with `protocolVersion: 1` and `type` fields.
- Each turn is associated through `requestId`; server event IDs are ordered only within a connection and are not persistent.

### Lifecycle, heartbeat, and reconnection

- The server pings every client every 25 seconds and terminates a client that did not answer the previous ping (half-open connections). Browsers answer pings automatically.
- On shutdown or restart the server closes every socket with code `1012` (Service Restart) and reason `Server restarting` before the process exits. `1001` (Going Away) is reserved for the same purpose.
- Clients reconnect automatically: they check `GET /api/v1/healthz` first, then open a new socket and send `session.start` again. Backoff is exponential with jitter, capped at 15 seconds; after `1012` the first check waits about 1.2 seconds. Constants live in `packages/shared/src/reconnect.ts`.
- A turn that was in progress when the socket closed has no terminal event. Clients must report it as interrupted and must not resend it automatically. Conversation context continues through the existing `conversationId`.

## Client → server

### `session.start`

```json
{
  "protocolVersion": 1,
  "type": "session.start",
  "requestId": "req-connect-1"
}
```

The server replies with `session.ready`, including a temporary `connectionId`, a safe model status, and supported filters.

### `turn.submit`

```json
{
  "protocolVersion": 1,
  "type": "turn.submit",
  "requestId": "req-001",
  "conversationId": null,
  "message": "Show records in the selected area from last week",
  "scope": {
    "workspaceId": "demo",
    "dateRange": {
      "from": "2026-10-01T00:00:00Z",
      "to": "2026-10-07T23:59:59Z"
    },
    "polygonIds": ["demo-zone-central"],
    "sourceIds": [],
    "language": "en"
  }
}
```

Rules:

- The client creates a `requestId` unique within the current connection.
- `conversationId` may be null for a new conversation; the server returns the created ID.
- In the local demo, conversation context is scoped to `conversationId` and workspace and retained in PostgreSQL for up to 30 days. The server keeps up to 100 conversations per workspace and 12 user/assistant messages per conversation. Tool calls and results are not saved. The browser stores up to 100 messages per conversation and up to 30 recent conversations, each with the map result of its last completed turn (places, records, trip plan, search area; trimmed, and dropped first when browser storage is full), so a reload or a reopened chat shows its results again; `DELETE /api/v1/assistant/history` clears all server history for the demo workspace.
- `scope` is UI context, not authorization. The backend validates the scope and permissions again. Optional `selectedMapItem` has `{type: "place"|"record", id}`. The backend reloads the authoritative card by ID and checks its source/date scope.
- Optional `language` is `"en"`, `"ru"`, or `"de"` and controls the assistant response and progress/error text for this turn. If omitted, the backend defaults to English.
- Values in `sourceIds` and `polygonIds` have length/count limits and are validated by the backend schema.
- The MVP allows one active turn per connection; concurrent turns receive `turn.error` with code `busy`.

### `turn.cancel`

```json
{
  "protocolVersion": 1,
  "type": "turn.cancel",
  "requestId": "req-001"
}
```

Cancellation is best-effort; the backend should not leave generation or tool work running after cancellation.

## Server → client

### `session.ready`

```json
{
  "protocolVersion": 1,
  "type": "session.ready",
  "requestId": "req-connect-1",
  "connectionId": "conn-abc",
  "assistantStatus": "ready",
  "modelLabel": "Qwen3 4B (local)",
  "demoMode": true,
  "supportedFilters": ["dateRange", "sourceIds", "polygonIds", "category"],
  "voiceInput": false
}
```

Optional `voiceInput` is `true` only when the backend has voice input enabled and configured. See [Voice input](#voice-input-demo-opt-in).

### `turn.accepted`

```json
{
  "protocolVersion": 1,
  "type": "turn.accepted",
  "requestId": "req-001",
  "conversationId": "conv-demo-1"
}
```

### `turn.status`

```json
{
  "protocolVersion": 1,
  "type": "turn.status",
  "requestId": "req-001",
  "phase": "searching",
  "label": "Searching records with the requested filters"
}
```

Allowed `phase`: `understanding`, `searching`, `composing`.

### `tool.started` / `tool.completed`

```json
{
  "protocolVersion": 1,
  "type": "tool.started",
  "requestId": "req-001",
  "tool": "search_records",
  "label": "Searching allowed sources"
}
```

```json
{
  "protocolVersion": 1,
  "type": "tool.completed",
  "requestId": "req-001",
  "tool": "search_records",
  "recordsFound": 12
}
```

Do not send raw SQL, provider credentials, arbitrary URLs, full tool arguments or sensitive fields in these status events.

### `turn.step`

```json
{
  "protocolVersion": 1,
  "type": "turn.step",
  "requestId": "req-001",
  "stepId": "step-2",
  "label": "Searching places: museum · Warszawa",
  "state": "done",
  "detail": "found: 10"
}
```

One line of the progress feed the chat shows during a turn: understanding the request, classifying a follow-up about the trip plan, each tool call, assembling or writing the answer. Each `stepId` is sent first as `running`, then once as `done` or `failed`, in the order the steps happen. Labels name the tool and at most a few short plain argument values (kind, city, place, days); never full arguments. `turn.status` is still sent for clients that show a single line.

### `assistant.delta`

```json
{
  "protocolVersion": 1,
  "type": "assistant.delta",
  "requestId": "req-001",
  "text": "Found 12 records"
}
```

Incremental user-facing text only. Never stream model reasoning/thinking content. A turn can send many deltas: the model's answer is streamed as it is generated, and replies assembled by the backend from database rows (trip plans, place lists) are sent section by section. Clients append deltas in order; `turn.completed.assistantMessage` carries the full final text and replaces the streamed text.

### `turn.clarification`

```json
{
  "protocolVersion": 1,
  "type": "turn.clarification",
  "requestId": "req-001",
  "conversationId": "conv-demo-1",
  "message": "Which source should I use?",
  "choices": [
    { "id": "osm-mazovia", "label": "Regional OpenStreetMap extract" }
  ]
}
```

Clarification completes the current turn. The next user answer is a new `turn.submit` with the same `conversationId` and a new `requestId`.

### `turn.completed`

```json
{
  "protocolVersion": 1,
  "type": "turn.completed",
  "requestId": "req-001",
  "conversationId": "conv-demo-1",
  "assistantMessage": "Found 12 records in the selected date range.",
  "appliedFilters": [
    { "field": "dateRange", "label": "October 1–7", "value": { "from": "2026-10-01T00:00:00Z", "to": "2026-10-07T23:59:59Z" } }
  ],
  "result": {
    "total": 12,
    "records": [],
    "places": [
      { "id": "osm-place-001", "sourceId": "osm-mazovia", "name": "Verified place one", "category": "tourism:museum", "countryCode": "PL", "city": "Warszawa", "street": null, "houseNumber": null, "postcode": null, "lat": 52.23, "lon": 21.01 },
      { "id": "osm-place-002", "sourceId": "osm-mazovia", "name": "Verified place two", "category": "tourism:museum", "countryCode": "PL", "city": "Warszawa", "street": null, "houseNumber": null, "postcode": null, "lat": 52.24, "lon": 21.02 }
    ],
    "tripPlan": {
      "status": "ready",
      "countryCode": "PL",
      "city": "Warszawa",
      "totalDays": 2,
      "supportedDays": 2,
      "travelMode": "driving",
      "airport": null,
      "days": [
        { "day": 1, "area": "city", "stopPlaceIds": ["osm-place-001"], "straightLineDistanceMetersFromAirport": {}, "routeStatus": "pending" },
        { "day": 2, "area": "city", "stopPlaceIds": ["osm-place-002"], "straightLineDistanceMetersFromAirport": {}, "routeStatus": "pending" }
      ],
      "sourceIds": ["osm-mazovia"]
    },
    "mapFeatures": []
  },
  "sources": [
    { "id": "osm-mazovia", "label": "Regional OpenStreetMap extract", "mode": "public_snapshot" }
  ]
}
```

`records` is capped (MVP default 50); `places` optionally contains matched named map features; `total` is the backend's total before cap for the objects found by tools. For bigger result sets use pagination in a later contract. `mapFeatures` are GeoJSON `FeatureCollection` values with point/zone geometry and safe properties referencing record/place IDs; do not put private source fields in map properties.

`tripPlan` is included when the backend has resolved a supported multi-day itinerary. For city trips (several cities, or one city outside the capital flow such as Firenze) it also carries `cities` (verified settlements in visiting order) and `days[].city`; cities are recognized from local, English, and listed Russian/German names, days follow explicit per-city counts ("2 days in Roma and 3 in Firenze") or are shared evenly, and stops are searched around each city's center. The UI outlines each city's visited area from the day stops; this is not an official boundary. It references only verified place IDs returned in `places`. Each day holds its stop IDs, area, route status, and any exact straight-line distances from the selected airport. The UI requests road geometry separately for each day from the configured routing service; actual route distance, duration, and geometry are not part of this WebSocket frame.

Each place includes `countryCode` as an ISO 3166-1 alpha-2 code. The current local sample covers selected regions in DE, PL, FR, IT and ES, plus all of RO; country coverage does not imply a complete national dataset.

The assistant's allowed read-only tools are `search_records`, `get_record_details`, `search_places`, `list_sources`, `search_events`, `plan_trip`, and `edit_trip_plan` (plus an internal `reply` for answers that need no data, which never appears in tool events). `search_events` searches imported events by settlement or selected map item, radius, period, and magnitude, with the same validation and limits as `POST /api/v1/investigations/query`; the backend resolves the center and never accepts coordinates from the model. When it applied a radius, `turn.completed.result.searchArea` (`lat`, `lon`, `radiusKm`, `label`) lets the UI draw the circle, and radius results carry `distanceMeters`. `search_places` searches the locally imported place catalogue; extracts may be incomplete. Source provenance and attribution are returned in `sources`. `plan_trip` creates a trip plan from cities, days, and a route mode named by the model; the backend resolves the cities against verified settlements and selects every stop. `edit_trip_plan` changes the trip plan the conversation currently shows (add, remove, or move stops; add, remove, or replace days; set the number of days; turn the driving route on or off). The model refers only to stops already in the plan, every new stop is chosen by the backend from the local place catalogue, and the backend keeps the plan per conversation, so follow-up edits apply to what the user sees. The edited plan is returned in `turn.completed.result.tripPlan`. `list_sources` gives the model a concise description of sources available in the current scope; full source metadata is also returned to the UI in `turn.completed.sources`.

### `turn.cancelled` and `turn.error`

```json
{
  "protocolVersion": 1,
  "type": "turn.cancelled",
  "requestId": "req-001"
}
```

```json
{
  "protocolVersion": 1,
  "type": "turn.error",
  "requestId": "req-001",
  "code": "model_unavailable",
  "message": "The local assistant is temporarily unavailable. Please try again.",
  "retryable": true
}
```

Error `code` allowlist: `invalid_message`, `unauthorized`, `forbidden`, `busy`, `model_unavailable`, `source_unavailable`, `timeout`, `internal_error`. Never send traceback, filesystem path, SQL, or upstream raw response.

## Voice input (demo, opt-in)

Status: **demo**. Voice input is disabled unless the administrator sets `VOICE_INPUT_ENABLED=true` and `OPENAI_API_KEY` on the backend. While it is active, the backend relays microphone audio to the external OpenAI Realtime transcription service. The browser never connects to OpenAI and never receives the API key. The UI must state that audio leaves the local machine while recording.

Voice frames share the assistant connection but are independent of turns. A transcript is never submitted automatically; the UI places it in the composer, and the user sends it with a regular `turn.submit`.

### Client → server

```json
{ "protocolVersion": 1, "type": "voice.start", "requestId": "voice-001", "language": "en" }
```

```json
{ "protocolVersion": 1, "type": "voice.audio", "requestId": "voice-001", "audio": "<base64 PCM16>" }
```

```json
{ "protocolVersion": 1, "type": "voice.stop", "requestId": "voice-001" }
```

- `language` is optional (`"en"`, `"ru"`, or `"de"`) and is passed to the transcription model as a hint.
- `audio` is base64 of raw 16-bit little-endian PCM, mono, 24 kHz. Send chunks of about 100 ms. One chunk is at most 12,000 base64 characters so the frame stays below the 16 KiB WebSocket payload limit.
- Only one voice session may be active per connection. A session ends after `voice.stop`, a provider error, the backend's maximum duration (`VOICE_MAX_SESSION_SECONDS`, default 120), or disconnection.
- `voice.audio` and `voice.stop` frames for a request ID that is not active are ignored.

### Server → client

```json
{ "protocolVersion": 1, "type": "voice.ready", "requestId": "voice-001" }
```

```json
{ "protocolVersion": 1, "type": "voice.transcript.delta", "requestId": "voice-001", "text": "Show museums" }
```

```json
{ "protocolVersion": 1, "type": "voice.transcript.completed", "requestId": "voice-001", "text": "Show museums in Berlin" }
```

```json
{ "protocolVersion": 1, "type": "voice.stopped", "requestId": "voice-001" }
```

```json
{
  "protocolVersion": 1,
  "type": "voice.error",
  "requestId": "voice-001",
  "code": "provider_unavailable",
  "message": "Speech recognition is temporarily unavailable.",
  "retryable": true
}
```

- `voice.ready` means the backend reached the transcription provider. The client may send `voice.audio` after it arrives; earlier audio is ignored.
- `voice.transcript.delta` carries newly recognized text that is appended to the previous deltas for the same request.
- `voice.transcript.completed` carries the final text for the committed audio and replaces the accumulated deltas.
- `voice.stopped` and `voice.error` are terminal for a voice session.
- Error `code` allowlist: `voice_disabled`, `invalid_message`, `busy`, `rate_limited`, `provider_unavailable`, `timeout`, `internal_error`.
- `rate_limited`: the server caps open voice sessions process-wide and, per client address, the number of sessions and recording seconds in a fixed window (`VOICE_MAX_CONCURRENT_SESSIONS`, `VOICE_SESSIONS_PER_CLIENT_PER_HOUR`, `VOICE_SECONDS_PER_CLIENT_PER_HOUR`). Each session reserves its full `VOICE_MAX_SESSION_SECONDS` up front. Never forward the provider's raw error text, credentials, or internal addresses.
- The backend does not store or log audio or transcript text.

Voice lifecycle: `voice.start` → `voice.ready` → zero or more `voice.transcript.delta` → `voice.stop` → `voice.transcript.completed` (when speech was recognized) → `voice.stopped`. `voice.error` can replace any step after `voice.start`.

## Turn lifecycle

Normal turn: `turn.accepted` → zero or more `turn.status` / tool events / `assistant.delta` → exactly one terminal event (`turn.completed`, `turn.clarification`, `turn.cancelled`, or `turn.error`). Terminal event frees the connection for its next turn.

## Versioning and compatibility

- `protocolVersion` is required on every JSON event.
- Additive optional fields are backwards compatible. Changing required fields or event meaning requires a versioned migration.
- Both frontend and backend must use these names; generate types or centralize mirror types from this document/schema before parallel implementation.
- Close invalid frame with an appropriate WebSocket close code and a short safe reason; do not process unknown event types.
