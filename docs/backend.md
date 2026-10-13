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
├── voice/               # demo, opt-in speech-to-text relay (OpenAI Realtime adapter)
├── data/                # repositories and future client adapters
├── sources/             # external event source adapters (INGV, synthetic demo)
├── services/            # domain services such as event import
├── cli/                 # manual OSM and event import commands
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
- `GET /api/v1/data/sources` — sources available to the current user/workspace, with `lastSync` for event sources.
- `GET /api/v1/data/places` — local POI/address search by query, category, city, or bbox; capped at 500 points.
- `GET /api/v1/investigations/events` — event search by time window (default 7 days, max 90), bbox or radius (max 300 km), magnitude, source, and category; keyset cursor pagination; at most 200 per page. A bbox combined with a radius is rejected with `invalid_area_filter`, and `minMagnitude` above `maxMagnitude` with `invalid_magnitude_range`.
- `GET /api/v1/investigations/events/{id}` — one event with up to 20 linked nearby places, sources, and the last sync run.
- `GET /api/v1/investigations/entities/{id}` — one place with its linked events.
- `POST /api/v1/investigations/import/{sourceId}` — starts an import; returns `403 import_disabled` unless `INVESTIGATION_IMPORT_ENABLED=true`.
- `POST /api/v1/investigations/query` — natural-language event search. The local model must call `search_events`; arguments are validated with Zod, the place is resolved on the server, and the database returns the rows. A rule-based parser takes over when the model is busy, unavailable, slow, returns an invalid call, or fails unexpectedly (`interpretation.interpretedBy: "rules"` with `fallbackReason`; unexpected failures report `model_error` and log only the error message). Non-allowlisted tool names are reported in `rejectedTools` and never executed.
- Investigation routes are rate-limited per client IP (120 requests per minute, in memory). Behind a reverse proxy set `TRUST_PROXY` to the hop count; it is `false` by default.
- Malformed JSON bodies return `400 invalid_json`; oversize bodies return `413`. The import trigger requires `application/json` (`415` otherwise).
- `WS /api/v1/assistant/ws` — requests, clarifications, status, answer text, and result events. See `contracts/websocket.md`.

## Turn lifecycle

1. Check origin, frame size, active turn, and the shared JSON Schema. The WebSocket `Origin` must equal `FRONTEND_ORIGIN`; in `development` only, loopback aliases (`localhost`, `127.0.0.1`, `[::1]`) with the same scheme and port are also accepted.
2. Normalize the scope; client-provided scope is context, not authorization.
3. For open-ended questions, send the local model a system prompt, tool schemas, the current language, bounded conversation history, and verified selected-object context. A resolved itinerary is assembled deterministically from verified place rows and does not invoke model generation.
4. Scope travel follow-ups to the most recent destination segment. A new country, city, or explicit restart begins a fresh context. If the user asks to start over or switch countries without naming a destination, ask them to choose one of the six supported regional extracts. Do not carry forward the previous trip's country, city, duration, airport, or route preferences.
5. Accept only allowlisted tool calls; validate arguments and scope before calling repositories.
6. Query PostgreSQL through parameterized Sequelize operations.
7. Return only a compact, bounded result set to the model; return capped full results and provenance to the UI.
8. Finish with `turn.completed`, `turn.clarification`, `turn.cancelled`, or `turn.error`.

The MVP allows one model inference at a time and up to three tool calls per turn (travel prefetch has a separate bounded path). Results sent to the model are compact; UI results are capped. There is no fixed wall-clock timeout for model generation; users can cancel a turn, and disconnecting aborts inference. The model context is 4096 tokens and the answer limit defaults to 768 tokens (`OLLAMA_NUM_PREDICT`, configurable from 128 to 2048). Ollama must bind to loopback. Never pass SQL, arbitrary URLs, or file paths to the model. Polygon filtering currently returns an explicit unsupported error.

The available read-only tools are `search_records`, `get_record_details`, `search_places`, `list_sources`, and `search_events` (events by settlement or selected map item, radius, period, and magnitude; the server resolves the center, applies the chat scope, fills explicit numbers the model omitted from the user text, and returns `searchArea` for the map). Place searches support name, category, city, country, and bbox. OSM places and configured records are returned in separate collections and GeoJSON point layers. Resolved itineraries return a typed `TripPlan`; the UI requests each day's route separately. Assistant text is sent as one `assistant.delta`, followed by `turn.completed`. Conversation text is stored in PostgreSQL and browser local storage with a limited retention period.

Assistant diagnostics log aggregate turn and model-call durations, Ollama prompt/generation timings and token counts, model ID, bounded result counts, and outcome. Route diagnostics log duration, point count, provider class, and outcome. They must not include prompts, place names, or coordinates.

## Data access layer

1. PostgreSQL stores the local OSM snapshot catalogue and may store explicitly configured records in separate tables.
2. Sources retain status, type, license, and attribution. The UI and model use the same source metadata.
3. Add a client API adapter only after its schema, authentication, and access rules are confirmed.
4. Connect external sources only through server-side allowlisted adapters. Do not provide general web or SQL access to the model.

Source metadata includes license, snapshot/fetch date, and provider URL when available. Repositories construct queries from validated parameters and do not accept model-generated SQL.

## Event import (investigation workspace, demo)

Events are imported manually into `records`; nothing is fetched at startup.

```bash
npm run data:import:events -- --source ingv-fdsn --days 7
npm run data:import:events -- --source demo-seismic-synthetic --days 7   # offline, labeled synthetic
```

- `sources/` adapters fetch, validate (Zod), and normalize source data. `ingv-fdsn` reads the INGV FDSN event service (CC BY 4.0). Its URL comes only from `EVENT_SOURCE_INGV_URL`, which must be on an allowlisted host.
- `services/event-import.ts` creates a `source_sync_runs` row, fetches the whole window before writing, splits truncated windows, upserts by (`source_id`, `external_id`), and links each new or revised event to up to five places within 5 km in `record_place_links`.
- Re-imports are idempotent: unchanged revisions are counted as skipped. A failed fetch records a failed run with an error code and leaves stored data untouched.
- One running import per source is enforced by a partial unique index. A cooldown (`EVENT_IMPORT_COOLDOWN_SECONDS`) applies unless `--force` is passed. Runs left `running` for 30 minutes are marked `stale_run`.
- Upstream requests use a timeout per attempt (including the body download), up to two retries with jittered exponential backoff, `Retry-After`, and no redirects. Logs and the database store error codes only.
- Each run also links events in its window that still have no place links, so a failed link step is repaired by the next run. Failed runs do not start the cooldown. At startup, runs left `running` by a previous process are marked `interrupted`.

See [technical-decisions.md](technical-decisions.md) for the source choice and field mapping.

## Investigation query (demo)

`assistant/investigation-query.ts` sends a short system prompt, the user text, and only the `search_events` definition (`tools/search-events.ts`). The model output is never shown as an answer and never supplies coordinates or rows. `llm/inference-gate.ts` allows one local inference at a time across the chat turn and this endpoint; when it is busy, the query uses `assistant/investigation-rules.ts` immediately instead of waiting. Rule parsing understands common EN/RU/DE phrasing (period, radius, magnitude, "this location", a capitalized settlement name); it cannot translate exonyms such as "Rome" to "Roma".

## Tests

- `npm test` runs unit and route tests with mocked network calls and injected dependencies; no live INGV, Ollama, or database is needed.
- `TEST_DATABASE_URL=postgres://waypoint:waypoint_dev@127.0.0.1:5433/waypoint_test npm run test:db` runs PostgreSQL integration tests for upserts, place links, the one-running-import index, radius and magnitude search, keyset pagination, details, and settlement resolution. The suite creates and migrates the database if needed and refuses to run unless the database name contains "test". Without the variable these tests are skipped.

## Model access boundary

Ollama receives tool schemas, not PostgreSQL credentials or SQL access. The backend checks the allowlist, validates arguments, applies source/date/geographic scope, and returns bounded results. This limits arbitrary schema access, writes, and SQL injection through prompt text.

An allowlist is not full authorization. A permitted search can still return data the caller should not see if the server applies the wrong scope. The demo has one local workspace and no user authentication. Before using real data, add server-side workspace/source authorization, a read-only database role with minimum privileges, request auditing and limits, and minimization of fields sent to the model.

## Voice input relay (demo, opt-in)

`backend/src/voice/` relays microphone audio to OpenAI Realtime transcription. It is active only when `VOICE_INPUT_ENABLED=true` and `OPENAI_API_KEY` is set; `GET /api/v1/assistant/capabilities` and `session.ready` then report `voiceInput: true`.

- `voice-session.ts` owns one voice session per WebSocket connection. It enforces the maximum duration, an audio-volume cap, and a 10-second wait for the final transcript after `voice.stop`. It closes the upstream connection when the client disconnects.
- `openai-realtime.provider.ts` implements `TranscriptionProvider`. It opens `OPENAI_REALTIME_URL` (only `wss://api.openai.com` is allowlisted) with the key in the `Authorization` header and configures a `transcription` session with `turn_detection: null`. It commits the audio buffer when the user stops.
- Provider errors are mapped to the `voice.error` code allowlist; raw provider messages are never forwarded.
- Diagnostics log the request ID, duration, audio volume, and outcome. They never log audio or transcript text.

| Variable | Default | Purpose |
|---|---|---|
| `VOICE_INPUT_ENABLED` | `false` | Enables the relay |
| `OPENAI_API_KEY` | — | Backend-only credential |
| `OPENAI_REALTIME_URL` | `wss://api.openai.com/v1/realtime?intent=transcription` | Upstream endpoint |
| `OPENAI_TRANSCRIBE_MODEL` | `gpt-live-transcribe` | Transcription model |
| `VOICE_MAX_SESSION_SECONDS` | `120` | Maximum recording length (10–600) |
| `VOICE_CONNECT_TIMEOUT_MS` | `10000` | Upstream connection timeout |

## WebSocket lifecycle

Validate event shape against `contracts/websocket.schema.json`; use `contracts/websocket.md` for semantics. Keep handlers thin. MVP permits one active turn per connection and one generation per laptop. Handle disconnect, cancel, and timeouts, and return error codes without internal details.
