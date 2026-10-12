# Backend: structure, HTTP, and model lifecycle

## Stack

Node.js 24 LTS, TypeScript, Express, and Zod; PostgreSQL through Sequelize v6; native WebSocket through `ws`; Turf.js for simple GeoJSON operations. The demo imports an OSM place catalogue; the record API is optional and has no default event fixtures. See [the stack decision](stack-decision.md).

## Code structure

```text
backend/src/
├── server.ts            # Express server and WebSocket attachment
├── api/                 # health, capabilities, sources, WebSocket
├── assistant/           # turn lifecycle, scope, orchestration
├── llm/                 # provider protocol and Ollama adapter
├── tools/               # validated read-only functions
├── data/                # repositories and future client adapters
├── models/              # Sequelize models
├── migrations/          # versioned PostgreSQL schema changes
├── schemas/             # wire and domain validation
└── config/              # environment validation
```

Domain logic depends on provider interfaces, not directly on a concrete Ollama SDK.

## Endpoints

`contracts/openapi.yaml` is the HTTP contract source of truth.

- `GET /api/v1/healthz` — process health.
- `GET /api/v1/assistant/capabilities` — readiness, supported filters, safe model label, and demo flag.
- `GET /api/v1/data/sources` — sources available to the current user/workspace.
- `GET /api/v1/data/places` — local POI/address search by query, category, city, or bbox; capped at 500 points.
- `WS /api/v1/assistant/ws` — requests, clarifications, status, answer text, and result events. See `contracts/websocket.md`.

## Turn lifecycle

1. Check origin, frame size, active turn, and the shared JSON Schema.
2. Normalize the scope; client-provided scope is context, not authorization.
3. For open-ended questions, send the local model a system prompt, tool schemas, the current language, bounded conversation history, and verified selected-object context. A resolved itinerary is assembled deterministically from verified place rows and does not invoke model generation.
4. Scope travel follow-ups to the most recent destination segment. A new country, city, or explicit restart begins a fresh context. If the user asks to start over or switch countries without naming a destination, ask them to choose one of the six supported regional extracts. Do not carry forward the previous trip's country, city, duration, airport, or route preferences.
5. Accept only allowlisted tool calls; validate arguments and scope before calling repositories.
6. Query PostgreSQL through parameterized Sequelize operations.
7. Return only a compact, bounded result set to the model; return capped full results and provenance to the UI.
8. Finish with `turn.completed`, `turn.clarification`, `turn.cancelled`, or `turn.error`.

The MVP allows one model inference at a time and up to three tool calls per turn (travel prefetch has a separate bounded path). Results sent to the model are compact; UI results are capped. There is no fixed wall-clock timeout for model generation; users can cancel a turn, and disconnecting aborts inference. The model context is 4096 tokens and the answer limit defaults to 768 tokens (`OLLAMA_NUM_PREDICT`, configurable from 128 to 2048). Ollama must bind to loopback. Never pass SQL, arbitrary URLs, or file paths to the model. Polygon filtering currently returns an explicit unsupported error.

The available read-only tools are `search_records`, `get_record_details`, `search_places`, and `list_sources`. Place searches support name, category, city, country, and bbox. OSM places and configured records are returned in separate collections and GeoJSON point layers. Resolved itineraries return a typed `TripPlan`; the UI requests each day's route separately. Assistant text is sent as one `assistant.delta`, followed by `turn.completed`. Conversation text is stored in PostgreSQL and browser local storage with a limited retention period.

Assistant diagnostics log aggregate turn and model-call durations, Ollama prompt/generation timings and token counts, model ID, bounded result counts, and outcome. Route diagnostics log duration, point count, provider class, and outcome. They must not include prompts, place names, or coordinates.

## Data access layer

1. PostgreSQL stores the local OSM snapshot catalogue and may store explicitly configured records in separate tables.
2. Sources retain status, type, license, and attribution. The UI and model use the same source metadata.
3. Add a client API adapter only after its schema, authentication, and access rules are confirmed.
4. Connect external sources only through server-side allowlisted adapters. Do not provide general web or SQL access to the model.

Source metadata includes license, snapshot/fetch date, and provider URL when available. Repositories construct queries from validated parameters and do not accept model-generated SQL.

## Model access boundary

Ollama receives tool schemas, not PostgreSQL credentials or SQL access. The backend checks the allowlist, validates arguments, applies source/date/geographic scope, and returns bounded results. This limits arbitrary schema access, writes, and SQL injection through prompt text.

An allowlist is not full authorization. A permitted search can still return data the caller should not see if the server applies the wrong scope. The demo has one local workspace and no user authentication. Before using real data, add server-side workspace/source authorization, a read-only database role with minimum privileges, request auditing and limits, and minimization of fields sent to the model.

## WebSocket lifecycle

Validate event shape against `contracts/websocket.schema.json`; use `contracts/websocket.md` for semantics. Keep handlers thin. MVP permits one active turn per connection and one generation per laptop. Handle disconnect, cancel, and timeouts, and return error codes without internal details.
