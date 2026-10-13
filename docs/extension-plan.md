# Extension plan: Investigation Workspace

Status: **implemented** (demo). This was the Phase 1 audit and plan; the outcome is described in [technical decisions](technical-decisions.md), [code review](code-review.md), and the [demo and review guide](demo-and-review.md). Deviations from this plan are noted in those documents.

The goal is to extend WaypointAI into a small investigation workspace for open-source data. It should be one working vertical slice: a public external source is imported into PostgreSQL, exposed through a validated REST API, queried in natural language through allowlisted tools, and shown in the existing React map UI with provenance.

## 1. Current architecture

All claims below come from source code and the local database, not from the README.

### Frontend

| Area | Implementation | Paths |
|---|---|---|
| Framework | React 19, TypeScript, Vite 7 | `frontend/package.json` |
| Routing | No router. `App` renders `AssistantWorkspace`, which switches pages with `activePage` state (`home`, `workspace`, `model`) | `frontend/src/app/App.tsx`, `frontend/src/features/assistant/AssistantWorkspace.tsx:46` |
| State | Local React state and hooks; no global store | `AssistantWorkspace.tsx` (746 lines) |
| API client | `fetch` helpers and the WebSocket connection | `frontend/src/shared/api/client.ts` |
| Map | Leaflet through `react-leaflet`, Natural Earth country outlines, OSRM route layer. `MapPanel` already accepts a `records` prop and renders records as markers with popups | `frontend/src/widgets/map/MapPanel.tsx:136`, `RouteLayer.tsx`, `countryBoundaries.ts` |
| UI | Plain CSS, `lucide-react` icons, EN/RU/DE copy | `frontend/src/shared/ui/styles.css`, `frontend/src/shared/i18n.ts` |
| Placeholders | Empty `features/results/` and `entities/record/` folders | `frontend/src/features/results/.gitkeep` |

### Backend

| Area | Implementation | Paths |
|---|---|---|
| Framework | Express 5 on Node.js, `/api/v1` prefix, JSON body limit 32 KB, CORS limited to `FRONTEND_ORIGIN` | `backend/src/server.ts` |
| REST routes | `GET /healthz`, `GET /assistant/capabilities`, `DELETE /assistant/history`, `GET /data/sources`, `GET /data/places`, `POST /map/route` | `backend/src/api/http.ts` |
| Validation | Zod `safeParse` per route; `.strict()` objects; bounded `limit` | `backend/src/api/http.ts`, `backend/src/tools/assistant-tools.ts` |
| Error handling | Central 404 and 500 handlers returning `{ error: code }`; no stack traces to clients | `backend/src/server.ts` |
| WebSocket | `ws` on `/api/v1/assistant/ws`, Origin check, 16 KB payloads, Ajv validation against the shared JSON Schema | `backend/src/api/websocket.ts`, `backend/src/api/origin.ts`, `backend/src/schemas/websocket.ts` |
| Configuration | Zod-validated environment variables | `backend/src/config/env.ts`, `.env.example` |

### Database

| Area | Implementation | Paths |
|---|---|---|
| Engine | PostgreSQL 17 (`postgres:17-alpine`), only `plpgsql` installed; **PostGIS is not available** in this image | `docker-compose.yml` |
| ORM | Sequelize v6 with explicit `field` mappings to snake_case columns | `backend/src/models/*.ts` |
| Migrations | `sequelize-cli`, CommonJS migration files | `backend/database/migrations/` |
| `data_sources` | `id`, `label`, `mode` (`synthetic_local`, `public_snapshot`, `approved_live`, `client_api`), `status`, `attribution`, `snapshot_date`, `source_url`, `license` | `20261008000000-create-demo-data.cjs`, `20261008100000-add-osm-places.cjs` |
| `records` | `id`, `source_id` FK, `observed_at`, `lat`, `lon`, `accuracy_meters`, `category`, `attributes` JSONB, `place_id` FK; indexes on (`source_id`, `observed_at`), `category`, `place_id`. **Currently empty** | same migrations, `backend/src/models/record.ts` |
| `places` | About 2.98 million named OSM nodes from six regional extracts; unique (`osm_type`, `osm_id`, `source_id`); indexes on (`source_id`, `category`), (`lat`, `lon`), `name` | `backend/src/models/place.ts` |
| `assistant_conversations` | Chat history in JSONB with expiry | `20261008120000-create-assistant-history.cjs` |
| Seeds | None. OSM data comes from `npm run data:import:europe` | `scripts/import-europe-osm.sh`, `backend/src/cli/import-osm.ts` |

### LLM integration

| Area | Implementation | Paths |
|---|---|---|
| Provider | Local Ollama `/api/chat`, non-streaming, `think: false`, configurable context and temperature | `backend/src/llm/ollama.provider.ts` |
| Model | `qwen3:4b-instruct-2507-q4_K_M` | `.env.example` |
| Tools | Allowlist `search_records`, `get_record_details`, `search_places`, `list_sources`; Zod argument schemas; results capped before they reach the model | `backend/src/tools/allowlist.ts`, `backend/src/tools/assistant-tools.ts` |
| Orchestration | At most 4 model iterations and 3–5 tool calls per turn; one concurrent turn (`modelBusy`); deterministic travel prefetch and trip plans bypass the model | `backend/src/assistant/turn.ts` |
| Prompt | English system prompt that treats tool output as data, never instructions | `backend/src/assistant/prompts/system-prompt.ts` |

### Geospatial features

- Bounding-box filters with `lat BETWEEN` / `lon BETWEEN` on indexed columns.
- Radius search: bounding-box prefilter in SQL, then haversine distance in TypeScript (`searchNearbyPlaces`, `haversineDistanceMeters` in `backend/src/data/record.repository.ts`).
- Polygon centroid helper (`backend/src/services/geometry.ts`); `@turf/boolean-point-in-polygon` is a dependency.
- Road routes through an OSRM-compatible proxy (`POST /api/v1/map/route`).

### External integrations

| Service | Boundary |
|---|---|
| OSRM-compatible routing | Backend proxy, coordinates only, 12-second timeout, response shape validated |
| OpenAI Realtime transcription | Opt-in voice relay, key kept on the backend, URL allowlisted |
| Map tiles | Requested by the browser from the configured tile URL |
| Geofabrik OSM extracts | Manual import command, not called at runtime |

### Security controls

- No authentication or authorization. One implicit `demo` workspace.
- Origin check for WebSocket upgrades; CORS restricted to one origin.
- Read-only model tools; no SQL, URLs, or shell from the model.
- Parameterized Sequelize queries; `LIKE` input is escaped.
- Secrets live in `.env` (ignored); `.env.example` has empty values.
- No rate limiting on REST routes.

### Tests and tooling

- `node:test` with `tsx`, 30 backend tests in `backend/test/`. No network mocks yet. No frontend tests.
- `npm run typecheck`, `npm run build`. No linter or formatter configured.
- Contract types are generated from `contracts/openapi.yaml` into `packages/shared/src/openapi.generated.ts`.

## 2. Reusable functionality

| Need | Reuse |
|---|---|
| Events or observations table | `records` already has time, coordinates, category, JSONB attributes, source FK, and an optional place FK |
| Provenance | `data_sources` already stores license, attribution, URL, and mode; `approved_live` fits a public API |
| Entities | `places` provides real named objects for linking events to nearby locations |
| Radius and bbox search | The `searchNearbyPlaces` pattern and haversine helper |
| REST conventions | Zod validation, `{ error: code }` errors, bounded limits, `mapFeatures` GeoJSON in responses |
| Tool calling | Allowlist, Zod validation, tool-call limits, Ollama provider |
| Map | `MapPanel` with the `records` prop |
| External call pattern | The OSRM proxy: `AbortSignal.timeout`, response shape validation, generic `502` errors |

## 3. Missing capabilities

1. No connector for a live or periodically imported public event source.
2. No idempotency key for records (`id` only); no stable external identifier.
3. No import history or sync status per source.
4. No event–entity relationship other than a single nullable `place_id`.
5. `search_records` has no geographic filter (bbox or radius) and no numeric filter such as magnitude.
6. No REST endpoints for records. Records are only available through the assistant tools.
7. No cursor or offset pagination; responses return `total` plus up to `limit` rows.
8. No natural-language endpoint that returns the interpreted query separately from the results.
9. No investigation view in the UI and no records table or details panel.
10. No REST rate limiting and no authentication.

## 4. Proposed implementation

### External source

Selected in Phase 2: **INGV FDSN event service** (Italy, CC BY 4.0), with **USGS** as an optional second adapter. EMSC was rejected because commercial use needs written permission. See [technical-decisions.md](technical-decisions.md) for the comparison, measured coverage, and verified response format.

Why seismic events fit:

- Public, documented API with time, rectangle, radius, and magnitude filters and a 20,000-event cap per request.
- Each event has a stable ID, timestamps (origin time and last update), coordinates, depth, and magnitude.
- Contains no personal data, so the demo does not drift into surveillance of individuals.
- Overlaps the imported Central Italy OSM extract (about 800 INGV events per month), so events can be linked to real nearby places.

### Backend files

| Action | Path | Purpose |
|---|---|---|
| Add | `backend/database/migrations/<ts>-add-investigation-sources.cjs` | Additive schema changes (section 5) |
| Add | `backend/src/models/source-sync-run.ts`, `backend/src/models/record-place-link.ts` | Sequelize models |
| Edit | `backend/src/models/record.ts`, `backend/src/models/index.ts` | `externalId`, `sourceUpdatedAt`, associations |
| Add | `backend/src/sources/source-adapter.ts` | Adapter interface: `fetchPage(window) → NormalizedEvent[]` |
| Add | `backend/src/sources/ingv/ingv.adapter.ts`, `ingv.schema.ts` | HTTP client, Zod schema for GeoJSON, normalization (`sources/usgs/` later as the optional second adapter) |
| Add | `backend/src/services/event-import.ts` | Sync run lifecycle, upsert, place linking, cooldown |
| Add | `backend/src/cli/import-events.ts` | `npm run data:import:events -- --source ingv-fdsn --days 7` |
| Add | `backend/src/data/investigation.repository.ts` | Event search (time, bbox or radius, magnitude, source), details, entity details |
| Add | `backend/src/api/investigations.ts` | Express router mounted at `/api/v1/investigations` |
| Add | `backend/src/investigations/query.ts` | Natural-language interpretation: model tool call or rule-based fallback |
| Edit | `backend/src/tools/allowlist.ts`, `assistant-tools.ts` | `search_events` tool shared by the chat and the query endpoint |
| Edit | `backend/src/config/env.ts`, `.env.example` | `EVENT_SOURCE_INGV_URL`, `INVESTIGATION_IMPORT_ENABLED`, import cooldown |
| Edit | `backend/src/assistant/turn.ts` | Move `modelBusy` into a shared gate so chat and query do not run two inferences at once |

### Frontend files

| Action | Path | Purpose |
|---|---|---|
| Add | `frontend/src/features/investigation/InvestigationWorkspace.tsx` | Page layout, data loading, states |
| Add | `frontend/src/features/investigation/EventFilters.tsx`, `EventTable.tsx`, `EventDetails.tsx`, `QueryBar.tsx` | Focused components |
| Add | `frontend/src/shared/api/investigations.ts` | Typed REST client |
| Edit | `AssistantWorkspace.tsx` | Add an `investigation` page to the existing navigation |
| Reuse | `frontend/src/widgets/map/MapPanel.tsx` | Pass events as `records` |

### Contracts and docs

- `contracts/openapi.yaml` → regenerate `packages/shared/src/openapi.generated.ts`.
- If `search_events` is exposed in chat: `ToolName` in `packages/shared/src/protocol.ts`, `contracts/websocket.schema.json`, `contracts/websocket.md`.
- `docs/stack-decision.md` (new external source), `docs/system-workflow.md`, `docs/backend.md`, `docs/frontend.md`, README.

## 5. Database design and API contract

### Schema changes (additive, reversible)

```text
data_sources            (existing, unchanged)
records                 (existing) + external_id varchar(120) null
                                   + source_revision varchar(80) null
                                   + UNIQUE (source_id, external_id)
                                   + INDEX (observed_at)
                                   + INDEX (lat, lon)
source_sync_runs        id uuid PK, source_id FK → data_sources,
                        started_at, finished_at, status (running|succeeded|failed),
                        window_start, window_end,
                        fetched_count, inserted_count, updated_count, skipped_count,
                        error_code varchar(60) null
                        INDEX (source_id, started_at)
                        UNIQUE (source_id) WHERE status = 'running'
record_place_links      record_id FK → records ON DELETE CASCADE,
                        place_id FK → places ON DELETE CASCADE,
                        relation varchar(40) ('nearby'),
                        distance_meters integer,
                        PK (record_id, place_id, relation)
                        INDEX (place_id)
```

Design notes:

- `records.id` becomes a deterministic `"<sourceId>:<externalId>"`, so re-imports are upserts, not duplicates.
- Magnitude and depth stay in `attributes` JSONB at first. If magnitude filtering becomes a hot path, promote it to a typed column or add an expression index; decide in Phase 2 after measuring.
- `source_revision` lets an import skip unchanged rows and record revisions (for example, a revised magnitude). INGV has no update timestamp, so the revision is `originId:version`.
- `error_code` stores a short code, never raw upstream bodies or credentials.
- No PostGIS: radius queries use the existing bbox prefilter plus haversine pattern. Reconsider at larger volumes.

### Proposed REST endpoints (`/api/v1/investigations`)

| Method and path | Purpose | Key parameters | Responses |
|---|---|---|---|
| `GET /events` | Search events | `from`, `to` (ISO 8601, max 90-day window), `bbox` **or** `lat`+`lon`+`radiusKm` (≤ 300), `minMagnitude`, `sourceIds`, `limit` (≤ 200), `cursor` | `200 { total, events, mapFeatures, sources, nextCursor }`, `400 invalid_query` |
| `GET /events/:id` | Event details, linked places, source, last sync run | — | `200`, `404 not_found` |
| `GET /entities/:id` | Place details and linked events | `limit` | `200`, `404` |
| `GET /sources` | Sources with last sync status | — | `200 { sources }` (or extend `GET /data/sources` additively) |
| `POST /import/:sourceId` | Controlled import of a bounded window | body `{ days ≤ 30 }` | `202 { runId }`, `403 import_disabled`, `409 import_running`, `429 import_cooldown` |
| `POST /query` | Natural-language query | body `{ text ≤ 300 chars, language }` | `200 { interpretation: { tool, arguments, interpretedBy: "model" or "rules" }, appliedFilters, result }`, `422 query_not_understood`, `503 model_unavailable` |

Sorting is deterministic: `observed_at DESC, id ASC`. The cursor encodes that pair.

### Natural-language flow

1. The client sends text to `POST /query`.
2. The model gets one allowlisted tool (`search_events`) and must answer with a tool call. It does not write the answer text.
3. The backend validates the tool name and arguments with Zod, clamps limits and windows, and resolves place names through `searchPlaces` (the model never supplies coordinates it made up).
4. The repository runs a parameterized query.
5. The response returns the interpretation, the applied filters, and the actual rows separately.
6. If the model is unavailable or returns malformed output, a rule-based parser handles simple patterns ("last 24 hours", "within 5 km of X", "magnitude above 4"). The response labels this `interpretedBy: "rules"`. If neither works: `422`.

## 6. Risks, dependencies, and security

| Risk | Mitigation |
|---|---|
| No authentication: anyone with network access can trigger imports | Import endpoint disabled by default (`INVESTIGATION_IMPORT_ENABLED=false`), loopback binding, cooldown, one running import at a time; CLI as the primary path. Document as not production-secure. |
| Upstream outages, slow responses, 4xx/5xx, schema changes | Timeouts, Zod validation of every feature, failed runs recorded with an error code, existing data left intact. |
| Abuse of upstream API | Bounded windows, `limit` ≤ 20,000 per request, cooldown, descriptive `User-Agent`. |
| Duplicate imports | Unique (`source_id`, `external_id`) and upsert in one transaction per page. |
| Expensive queries | Required or defaulted time window, max radius, max limit, indexes on `observed_at` and (`lat`, `lon`). |
| Model-generated arguments | Single-tool allowlist, strict Zod schemas, clamping, server-side place resolution. |
| Prompt injection via external content | Event titles from the source are treated as data; only compact fields go to the model; the model never sees raw upstream payloads in the query flow. |
| Misleading provenance | Every row carries `sourceId`; the UI shows source label, license, and import time; fixtures are labeled `synthetic_local`. |
| Concurrency with the chat model | Shared inference gate; `503 busy` when occupied. |
| Contract drift | Update OpenAPI, shared types, and docs in the same change. |
| Dependencies | No new runtime packages expected (`fetch`, Zod, Sequelize, Leaflet already present). Any addition is recorded in `docs/stack-decision.md`. |

## 7. Acceptance criteria

1. `npm run db:migrate` applies the new migration on the existing database without data loss; `db:migrate:undo` reverts it.
2. `npm run data:import:events -- --source ingv-fdsn --days 7` imports events. A second run inserts 0 duplicates and reports updated and skipped counts.
3. A simulated upstream failure (timeout, 503, malformed JSON) records a failed sync run and leaves previous data intact.
4. `GET /api/v1/investigations/events` filters by time, bbox or radius, magnitude, and source, paginates deterministically, and rejects invalid or oversized queries with `400`.
5. `GET /events/:id` returns linked OSM places with distances and the source attribution.
6. `POST /query` with "events within 50 km of Roma in the last 7 days" returns the interpretation, applied filters, and real rows. With Ollama stopped, the rule-based fallback handles the same query and says so.
7. The Investigation page shows filters, a table, details, a source badge, map markers, and distinct loading, empty, error, and fallback states. All data comes from API responses.
8. Existing chat, trip plans, and place search still work; existing tests pass.
9. New tests cover validation, pagination, normalization, idempotency, upstream failures, rejected tool calls, and malformed model output, with network calls mocked.
10. OpenAPI, shared types, and docs match the implementation.

## 8. Phased implementation plan

| Phase | Output | Checkpoint |
|---|---|---|
| 1. Audit | This document | Review by the owner |
| 2. Research | `docs/technical-decisions.md`: INGV vs USGS vs EMSC, verified terms, field mapping, failure behavior | Source choice confirmed |
| 3A. Schema | Migration and models | Migrate and undo on a local copy |
| 3B. Import | Adapter, import service, CLI, fixture for offline demo | Import twice and compare counts |
| 3C. REST | Router, repository, OpenAPI, generated types | `curl` examples and tests |
| 3D. UI | Investigation page with map | Manual walkthrough |
| 3E. NL query | `search_events` tool, query endpoint, fallback | With and without Ollama |
| 4. Tests | Unit and route tests with mocked `fetch` | `npm test`, `npm run typecheck`, `npm run build` |
| 5. Review | `docs/code-review.md` | Critical and high findings fixed |
| 6. Demo | `docs/demo-and-review.md`, README update | Full rehearsal |

Each phase-3 slice ends with `git diff` review, tests, and a check that existing features still work.
