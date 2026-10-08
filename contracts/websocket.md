# WebSocket contract v1

This is the canonical description of assistant messages. `contracts/openapi.yaml` defines HTTP endpoints and publishes the WebSocket path. Update this document together with frontend and backend changes.

## Connection

- Local URL: `ws://127.0.0.1:8000/api/v1/assistant/ws`.
- Production URL: `wss://<same-origin>/api/v1/assistant/ws`.
- The backend validates `Origin` and uses the same authentication/authorization as the HTTP API.
- Never put messages, IDs, tokens, or personal fields in a query string.
- All messages are UTF-8 JSON text frames with `protocolVersion: 1` and `type` fields.
- Each turn is associated through `requestId`; server event IDs are ordered only within a connection and are not persistent.

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
- In the local demo, conversation context is scoped to `conversationId` and workspace and retained in PostgreSQL for up to 30 days. The server keeps up to 100 conversations per workspace and 12 user/assistant messages per conversation. Tool calls and results are not saved. The browser stores up to 100 messages for the current conversation; `DELETE /api/v1/assistant/history` clears all server history for the demo workspace.
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
  "supportedFilters": ["dateRange", "sourceIds", "polygonIds", "category"]
}
```

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

### `assistant.delta`

```json
{
  "protocolVersion": 1,
  "type": "assistant.delta",
  "requestId": "req-001",
  "text": "Found 12 records"
}
```

Incremental user-facing text only. Never stream model reasoning/thinking content.

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

`tripPlan` is included when the backend has resolved a supported multi-day itinerary. It references only verified place IDs returned in `places`. Each day holds its stop IDs, area, route status, and any exact straight-line distances from the selected airport. The UI requests road geometry separately for each day from the configured routing service; actual route distance, duration, and geometry are not part of this WebSocket frame.

Each place includes `countryCode` as an ISO 3166-1 alpha-2 code. The current local sample covers selected regions in DE, PL, FR, IT and ES, plus all of RO; country coverage does not imply a complete national dataset.

The assistant's allowed read-only tools are `search_records`, `get_record_details`, `search_places`, and `list_sources`. `search_places` searches the locally imported place catalogue; extracts may be incomplete. Source provenance and attribution are returned in `sources`. `list_sources` gives the model a concise description of sources available in the current scope; full source metadata is also returned to the UI in `turn.completed.sources`.

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

## Turn lifecycle

Normal turn: `turn.accepted` → zero or more `turn.status` / tool events / `assistant.delta` → exactly one terminal event (`turn.completed`, `turn.clarification`, `turn.cancelled`, or `turn.error`). Terminal event frees the connection for its next turn.

## Versioning and compatibility

- `protocolVersion` is required on every JSON event.
- Additive optional fields are backwards compatible. Changing required fields or event meaning requires a versioned migration.
- Both frontend and backend must use these names; generate types or centralize mirror types from this document/schema before parallel implementation.
- Close invalid frame with an appropriate WebSocket close code and a short safe reason; do not process unknown event types.
