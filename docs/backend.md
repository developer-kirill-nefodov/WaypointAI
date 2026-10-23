# Backend: structure, HTTP, and model lifecycle

## Stack

Node.js 24 LTS, TypeScript, Express, and Zod; PostgreSQL through Sequelize v6; native WebSocket through `ws`; Turf.js for simple GeoJSON operations. The demo imports an OSM place catalogue; the record API is optional and has no default event fixtures. See [the stack decision](stack-decision.md).

## Code structure

```text
backend/src/
├── server.ts            # Express app, routes, WebSocket attachment, startup and shutdown
├── setup/               # wiring of background import jobs and of the training routes and services
├── api/                 # HTTP routes (assistant, data, investigations, training, fine-tuning, teacher, journal) and WebSocket
├── assistant/           # turn lifecycle (turn.ts), its progress frames (turn-reporter.ts), prompts, tool helpers, result frames
├── llm/                 # provider protocol and Ollama adapter
├── tools/               # validated read-only functions
├── voice/               # demo, opt-in speech-to-text relay (OpenAI Realtime adapter)
├── data/                # repositories
├── sources/             # external event source adapters (INGV, USGS, synthetic demo) and OpenStreetMap services
├── services/            # imports, benchmark and exam runner, LoRA trainer, model packages, OpenAI teacher
├── cli/                 # manual OSM and event import commands
├── models/              # Sequelize models
├── schemas/             # wire and domain validation
└── config/              # environment validation
```

Migrations live in `backend/database/migrations/` and tests in `backend/test/`.

Domain logic depends on provider interfaces, not directly on a concrete Ollama SDK.

## Endpoints

`contracts/openapi.yaml` is the HTTP contract source of truth.

- `GET /api/v1/healthz` — process health.
- `GET /api/v1/assistant/capabilities` — readiness, supported filters, safe model label, and demo flag.
- `GET /api/v1/data/sources` — sources available to the current user/workspace, with `lastSync` for event sources.
- `GET /api/v1/data/places` — local POI/address search by query, category, city, or bbox; capped at 500 points.
- `GET /api/v1/data/datasets`, `/countries`, `/settlements`, `/catalog/places`, `/catalog/categories`, `/datasets/{id}/events`, `/geocode`, `/regions`, `/regions/{id}` — the Data page and the import dialog (see [Import jobs](#import-jobs)).
- `POST /api/v1/map/route` — a road route between verified points through the optional routing provider (coordinates only).
- `DELETE /api/v1/assistant/history` — deletes the stored conversations of the workspace.
- `/api/v1/training/*` — lessons, benchmark cases and runs, the journal and aliases, fine-tuning (`/finetune`: dataset, runs, publish, export, import), and the teacher (`/teacher`: batches and examples). Editing needs `TRAINING_ENABLED`; see the sections below.
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
3. Send the local model a system prompt, tool schemas, the current language, bounded conversation history, verified selected-object context, and the current trip plan if one is on the map. The model interprets every message, in any language; the backend has no keyword rules for intent. When a plan is on the map, a short structured-output call first classifies the message (`change_plan`, `new_trip`, or `other`, `assistant/plan-intent.ts`) and the answering call gets only the fitting tools.
4. The first model step must be a tool call: a data tool, or `reply` for messages that need no data. A plain-text first answer is dropped and the model is asked once more; if it again answers without a tool, the user gets "could not process this request" instead of an unverified text that might name places or claim a change (questions classified as `other` while a plan is shown are answered from the plan).
5. Accept only allowlisted tool calls; validate arguments and scope before calling repositories.
6. Query PostgreSQL through parameterized Sequelize operations.
7. Return only a compact, bounded result set to the model; return capped full results and provenance to the UI.
8. Finish with `turn.completed`, `turn.clarification`, `turn.cancelled`, or `turn.error`.

The MVP allows one model inference at a time and up to four tool calls per turn. Results sent to the model are compact; UI results are capped. There is no fixed wall-clock timeout for model generation; users can cancel a turn, and disconnecting aborts inference. The model context defaults to 8192 tokens (`OLLAMA_NUM_CONTEXT`; with 4096 the prompt, tools, trip plan, and history can overflow and get truncated) and the answer limit defaults to 768 tokens (`OLLAMA_NUM_PREDICT`, configurable from 128 to 2048). Ollama must bind to loopback. Never pass SQL, arbitrary URLs, or file paths to the model. Polygon filtering currently returns an explicit unsupported error.

The available tools are `search_records`, `get_record_details`, `search_places`, `list_sources`, `search_events`, `plan_trip`, `edit_trip_plan`, and `reply` (an answer without data). `search_events` searches events by settlement or selected map item, radius, period, and magnitude; the server resolves the center, applies the chat scope, fills explicit numbers the model omitted from the user text, merges an earthquake reported by several catalogues into one row with its `crossCheck` status, and returns `searchArea` for the map. Every event, record, and place row the model sees gets a per-turn ref (`assistant/citations.ts`); the model cites facts with it, the server keeps only refs a tool returned, and `turn.completed.citations` lists the cited rows with links built from their IDs. Refs are removed from the stored history. `search_places` takes a `kind` (museum, park, restaurant, attraction, … or `any` for a name search) that maps to OSM categories; with a city it resolves that city to a verified settlement and searches around it (most OSM rows have no address city), and a city alone means sights. The reply to a place search is listed by the backend from the returned rows (`assistant/place-results-message.ts`), so the text cannot name places the search did not return; it states what was searched, which also makes a wrong choice of kind visible. When a plan is being edited, the edit call sees the user's messages and the plan but not earlier assistant confirmations, which a small model otherwise imitates instead of calling the tool. OSM places and configured records are returned in separate collections and GeoJSON point layers.

Trip plans are built and changed only through tools; the model never writes an itinerary. `plan_trip` (`tools/plan-trip.ts`, `assistant/plan-trip.ts`) takes up to five cities in local spelling with optional per-city days, `totalDays`, `routeMode`, and an optional airport code. The backend resolves each city against verified OSM settlements (unknown names go back to the model as an error), shares the days, finds attractions and museums around each city center (`city-trip-plan.ts`), and returns a typed `TripPlan`; when `routeMode` is missing it asks whether to add driving routes. The plan is stored with the conversation (`assistant_conversations.trip_plan`). `edit_trip_plan` (`assistant/trip-plan-edit.ts`) applies one operation per call to that stored plan: `add_stops`, `remove_stops`, `move_stop`, `add_day`, `remove_day`, `set_days`, `replace_day`, or `set_route_mode`. Existing stops are named by their ref in the plan the model sees ("1.2" = day 1, stop 2) or by name; new stops come from the nearest verified places of an allowed kind (attraction, museum, gallery, viewpoint, monument, castle, church, theatre, park, restaurant, cafe, bar) around the day's stops, and days an edit does not touch keep their stops. Both tools use strict Zod schemas; unused null fields are dropped first. The reply after a plan or an edit is built from verified rows, not by the model, and the stored history keeps only its first line so the small context window is not filled with stop lists. A question that changes nothing keeps the plan on the map. Without the model there is no trip planning: the chat reports that the local model is unavailable.

Clarifications with one-time filters (`assistant/clarification.ts`): when guessing would change the answer, the turn ends with `turn.clarification` and `fields` whose options the server builds. An earthquake search whose call and text name no period asks for the period (and the magnitude, radius, and event sources when they are missing too); a trip plan without a route mode asks for the route (and the number of days when unknown). Exam turns never ask, and the question is not repeated right after it was asked. The answer comes back in `turn.submit.answers`; values outside the offered options and unknown sources are dropped, chosen sources become the turn's `sourceIds`, and the rest is added to the message in words, which the model and the rule parser read.

Follow-up suggestions (`assistant/follow-ups.ts`): after a chat turn ends with an answer, the WebSocket handler asks the local model for three follow-up requests (a tool-free call with a JSON schema, from the last exchange, what is on the map, and a hint for the kind of answer) and sends them as `turn.suggestions`. This runs as background work on the inference gate (`llm/inference-gate.ts`): a new turn on any connection stops it and takes the model, the socket closing stops it, and it gives up after 45 s. Suggestions are checked (plain text of bounded length, no tool names, code, or links, not the last request) and `source: "none"` tells the client to use its own.

Progress is sent as `turn.step` events (each step `running`, then `done` or `failed` with the server's `durationMs`) and, while a model call runs inside a step, `turn.progress` events (`reading` the prompt, then `generating` with the token count and tokens per second, at most four per second). `turn.completed.models` names the models the turn called. `assistant/turn-reporter.ts` builds these frames. Model answers written after data was fetched, and answers that need no data, are streamed from Ollama as `assistant.delta` fragments; a `reply` is written by a separate tool-free call with a short prompt. Replies assembled from rows (plans, place lists) are sent section by section, and `turn.completed` carries the full text. Conversation text is stored in PostgreSQL and browser local storage with a limited retention period.

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

- `sources/` adapters fetch, validate (Zod), and normalize source data. `ingv-fdsn` reads the INGV FDSN event service (CC BY 4.0); `usgs-fdsn` reads the USGS FDSN event service (public domain; epoch-millisecond times, the `updated` time as the revision, event pages built from the validated ID). Their URLs come only from `EVENT_SOURCE_INGV_URL` and `EVENT_SOURCE_USGS_URL`, each of which must be on that source's own host.
- `services/event-import.ts` creates a `source_sync_runs` row, fetches the whole window before writing, splits truncated windows, upserts by (`source_id`, `external_id`), and links each new or revised event to up to five places within 5 km in `record_place_links`. For live catalogues it then recomputes the cross-source matches of the window (`services/event-matching.ts`, stored in `record_matches`): another live catalogue's event within 30 s and 50 km, the closest pair first, one pair per event and other source; a pair is consistent when magnitudes differ by at most 0.5 and depths by at most 10 km or 10%. Event search returns each event's `crossCheck` (confirmed, conflict, single when another catalogue covered that time without a match, unchecked), and `merge=true` hides a copy when the preferred source's copy (INGV, then USGS) passes the same filters.
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


## Import jobs

`services/import-jobs.ts` runs imports started from the app (`POST /api/v1/investigations/imports`, enabled only with `INVESTIGATION_IMPORT_ENABLED=true`). A job covers one or more allowlisted sources over 1–30 days; sources run one after another in the API process, each through the existing `importEvents` with its cooldown, idempotent upsert, and audit row in `source_sync_runs`. `importEvents` fetches the period in one-day windows (each still split while the source reports a truncated page), so progress is reported per window (fetching 0–80%, then saving and linking OSM places) and a cancel takes effect at the next window; nothing is written until every window is fetched. Jobs are stored in `import_jobs` with per-source status, progress, counts, error code, and retry time; progress is published to WebSocket connections of the job's workspace as `import.progress` (throttled to 5 per second) and saved about once a second. At most three jobs per workspace run at once. Jobs still marked running at startup were stopped with the previous process and are marked failed (`import_interrupted`).

### Area imports (OpenStreetMap places)

A job of kind `osm_area` loads the places of one area from the Overpass API (`sources/osm/osm-area.ts`, `services/osm-area-import.ts`). The area comes from the dialog's Nominatim search (`GET /api/v1/data/geocode`, at most one request per second, cached for an hour; the local name such as "Kraków" names the dataset) and is limited to `OSM_AREA_MAX_SQUARE_DEGREES`. It is fetched in tiles of 0.25° with a one-second pause between requests; each tile asks for named nodes, ways, and relations (as centres) of the chosen kinds plus settlements, so the assistant can resolve the new city by name. Nothing is written until every tile is fetched; then the places are upserted in one transaction into the dataset `osm-area-<name>` (licence ODbL, attribution "© OpenStreetMap contributors"), and the run is audited in `source_sync_runs`. A place another dataset already holds, for example from an overlapping regional extract, keeps its dataset; no rows are deleted. Only one area import runs at a time (`import_kind_busy`). After it finishes, the list of imported areas in the model's prompt is refreshed, so the next turn knows the city. `GET /api/v1/data/datasets` lists every dataset with its place and event counts, extent, snapshot date, and last import. Hosts are allowlisted in `config/osm.ts` (`OSM_OVERPASS_URL`, `OSM_NOMINATIM_URL`).

### Datasets, countries, and deletion

`GET /api/v1/data/datasets` lists every ready source with its counts, countries, extent, and whether it can be deleted; `GET /api/v1/data/countries` sums places, cities, towns, and villages per country; `GET /api/v1/data/settlements?country=` lists a country's settlements, cities first and then by how many places name them in their address (all values are bound parameters; the search is an escaped `LIKE`). Datasets and countries are cached for a minute. `GET /api/v1/data/catalog/places` feeds the data explorer: a dataset's places, or a country's across the datasets that hold it, filtered by city, category, text (name or street, an escaped `LIKE`), and map area, a page at a time with an opaque keyset cursor. Every query is restricted to known dataset IDs first, so PostgreSQL can use the `(source_id, category)` index even for a whole country; a text, city, or area filter first collects its few matches and then sorts them. Names that start with a letter are listed first (in the database collation they all sort at or after `'A'`), then house numbers and codes. `/catalog/categories` counts categories under the other filters, `/countries?dataset=` gives one dataset's own country counts, and `/datasets/{id}/events` pages through an event source, newest first. All of these are read-only, every value is a bound parameter, and cursors are validated with a strict schema.

A job of kind `dataset_delete` (`services/dataset-delete.ts`) deletes a dataset imported from the app. Only `osm-area-*` and `osm-region-*` datasets qualify; the built-in regional extracts and the event sources are refused (`dataset_not_deletable`), and the request names only the dataset ID. The places are deleted in batches of 5,000 inside one transaction with progress per batch, so a cancel or an error rolls everything back. Event links to those places are removed by their foreign key and events keep their rows with the place cleared. The dataset row stays for the `source_sync_runs` history that references it, marked `unavailable`, and is hidden from the source and dataset lists until it is imported again. No two running jobs may target the same dataset (`dataset_busy`). The assistant's coverage list is refreshed after the job. `POST /api/v1/investigations/imports/history/clear` removes a workspace's finished jobs from the history only. Downloaded region files in `data/local/regions` are kept for a later import.

### Region imports (Geofabrik)

A job of kind `osm_region` imports a whole region of the Geofabrik catalogue (`sources/osm/geofabrik.ts`, `services/osm-region-import.ts`). The catalogue (`index-v1-nogeom.json`, cached for a day) is browsed through `GET /api/v1/data/regions?parent=` (Europe's countries without a parent) and searched through `GET /api/v1/data/regions?q=`: by catalogue name, ID, or path, and countries also by their name in about 25 languages from the runtime's CLDR data (`Intl.DisplayNames`), so "Polska" or "Польша" finds Poland. A name the catalogue does not know ("Bavaria", "Краков", "Lombardia") is looked up in Nominatim under the same one-request-per-second limit as the city search; the result's ISO 3166 codes and local names (the state in its own spelling, for example "Bayern") give the smallest catalogue region that contains it, or its country, and the response names the place in `via`, and `GET /api/v1/data/regions/{id}` reports the file size and date. The request names only the region ID; its name, country, and file URL come from the catalogue, so a request cannot point the server at another URL. The file is downloaded from `download.geofabrik.de` only (redirects are followed only within that host) through a `.part` file into `data/local/regions/<id>-latest.osm.pbf`, refused above `OSM_REGION_MAX_BYTES` (default 1.5 GB), and reused while its size matches the catalogue. It is then parsed and written by the existing `cli/import-osm.ts` in a child process with `--progress-json`, which prints how much of the file was read; the API process stays responsive, and cancelling kills the child so its single transaction is rolled back. Progress: downloading up to 35%, then parsing and writing. The dataset is `osm-region-<id>`. Only one region import runs at a time.

## Training: lessons and exam

Teaching without changing weights. `assistant/lessons.ts` defines lessons: *rules* (a principle for every answer) and *examples* (a user question with the right tool call, a sample answer, or both). `validateLesson` refuses text that tries to override instructions (English, Russian, German phrasings), SQL, links, and code fences, and validates an example's arguments with the tool's own Zod schema, so an example cannot teach coordinates or other fields the tool refuses. On every turn `assistant/turn.ts` adds one system message after the system prompt with the enabled rules (at most 12 and 2,400 characters) and the three examples most similar to the message (character-trigram similarity, at least 0.12). The block says it ranks below the system rules and is never a source of facts. The same block is added to answers without data. The applied lessons are a `turn.step` in the progress feed and are counted per lesson (`applied_count`).

The exam (`services/eval-runner.ts`, `services/eval-checks.ts`, `services/exam-turn.ts`) asks every enabled case as a fresh turn through `processTurn` with `ephemeral: true` (workspace `exam`, nothing stored), with the enabled lessons or none, and records the tool calls with their parsed arguments. Checks: the expected tool, an argument subset (strings case-insensitive), the answer's language (list items, usually place names, are ignored), required and forbidden text, citations (`citationsMode: "cited"`), a ref in every sentence that states a magnitude (`citeEachEvent`; a summary of a magnitude range does not count), and a sentence limit. One run at a time; a case that meets a busy model waits and retries, and a `model_unavailable` error is retried twice after 10 s, since it says nothing about the answer. Each result is stored with the run's totals in one transaction, and runs left running by a stopped server are marked failed at startup. `services/starter-exam.ts` holds 12 synthetic starter questions.

`GET /api/v1/training/model` returns the model card (`llm/model-card.ts`): family, version, fine-tune, parameter count, architecture, context length, quantization, licence, capabilities, and install time from Ollama `/api/show` and `/api/version`, plus our runtime settings. Only known fields are copied; links are kept only on huggingface.co, github.com, and qwenlm.github.io, and the model page is derived from the Hugging Face licence link. The card is cached for 10 minutes; a failed read answers 503 and is not cached.

Endpoints are under `/api/v1/training` (`api/training.ts`): lessons (CRUD, toggle, preview of the exact prompt block), cases (CRUD, toggle, add the starter set), runs (list, details, start, cancel). Reading is always allowed; changes need `TRAINING_ENABLED` (unset: on only in development).

## Benchmark, journal, and router fine-tuning

- **Benchmark.** `services/benchmark-generator.ts` builds cases from the database: place, event, trip, source, and reply questions in three languages with real settlements (`benchmarkSettlements`: every city, Central Italian towns for events). A city can be named by its local or English name; the expectation lists both (`args` values may be lists, keys may be dotted: `cities.0.name`). `services/benchmark-hard-cases.ts` holds hand-written hard cases. Cases carry `skill` and `origin` (`starter`, `manual`, `generated`, `hard`, `journal`). Runs have a `mode`: `full` (the whole turn), `first_step` (the turn stops at the model's first tool call, `TurnOptions.firstStepOnly`), or `router` (the first call comes from the router prompt). `services/benchmark-metrics.ts` stores accuracy overall, per skill and language, and of the tool choice and the arguments, each with a 95% Wilson interval, in `eval_runs.metrics`. A run may name another installed model (validated against Ollama's model list).
- **Journal.** `assistant/turn.ts` records every non-exam turn through `data/journal.repository.ts`: the message, each tool call with its arguments, error, and result count, the outcome, and signals (`emptyResult`, `placeNotFound`, `invalidArgs`, `retriedWithoutTool`, and `rephrased` when the next message of the conversation follows a failed turn within 3 minutes). Thumbs from the chat set `feedback`. `api/journal.ts` lists entries and candidates, reviews them (the confirmed call is validated with the tool's schema, then added to the benchmark as a `journal` case), reports data gaps, and manages `settlement_aliases`, which `resolveSettlement` consults after exact names. Entries older than `JOURNAL_RETENTION_DAYS` are deleted at start and daily.
- **Router.** `assistant/router.ts` is a short prompt (about 300 tokens instead of several thousand) whose answer is JSON `{tool, args}` (Ollama JSON mode, not a schema: a schema grammar orders the properties alphabetically, putting `args` before `tool`, which broke the fine-tuned router). Its answer is accepted only if the tool's own schema accepts the arguments. With `ROUTER_MODEL` set (or in a router benchmark run), the first step of a turn asks the router; an invalid answer or a plan on the map falls back to the full prompt.
- **Fine-tuning.** `services/training-dataset.ts` writes `data/local/training/router-dataset.jsonl` (router messages with the right call as the answer): generated questions with another seed than the benchmark, examples of accepted teacher batches, and confirmed journal turns, leaving out every benchmark question. `services/lora-trainer.ts` runs `model/training/train_router.py` (LoRA on the answer tokens only, a validation split, one JSON progress line per step with the epoch and peak memory) in `model/training/.venv` under a 12 GB memory limit, and keeps each run's state in `data/local/training/runs/<id>/run.json`, with a `timeline` of the stages (loading, tokenized, training, saving, then merging, converting, creating, published, benchmark). Publishing runs in the background (`POST …/runs/:id/publish` answers 202; the run shows `publishing` and then `publishedAs` or `publishError`): an adapter alone (an imported package) is merged into its base model with `merge_adapter.py`, a merged model is converted to GGUF Q8_0 by `publish_router.sh`, and a ready GGUF goes straight to `ollama create waypoint-router:<id>`. A run started with `autoBenchmark` publishes itself after training and starts the router benchmark of the new model. Only these fixed scripts run, with validated arguments. Routes are under `/api/v1/training/finetune`.
- **Export and import.** `services/model-package.ts` writes a finished run as a plain tar (`GET …/runs/:id/export?kind=adapter|gguf`): `manifest.json` (the run's settings and losses, SHA-256 and size per file), the LoRA adapter (`adapter_config.json`, `adapter_model.safetensors`), and for `gguf` the model ready for Ollama. `POST …/import` streams an uploaded package (`application/x-tar`, up to 7 GB) to `data/local/training/uploads/` and reads it into a new run only if every check passes: regular files under the four fixed names (no links, folders elsewhere, or pickled `.bin` weights), size limits, checksums, a base model from `LORA_BASE_MODELS`, a LoRA config over the trained modules with nothing that loads code, and valid safetensors and GGUF headers. Files are written to fixed paths, so an archive cannot place anything elsewhere; on any failure the new folder is removed.
- **Teacher.** `services/teacher/` lets an OpenAI model (`TEACHER_MODEL`, default `gpt-4.1-mini`, with `OPENAI_API_KEY`) write training examples in batches per topic (`topics.ts`: city names, places, earthquakes, trips, sources and chat, hard requests). The request uses Structured Outputs with a strict JSON schema of the router's argument shapes and contains only synthetic instructions, the router prompt, and settlement names from the import, never journal turns. Each example is checked (`checks.ts`): the tool's own schema, the topic's tools, search_events only for earthquakes, every settlement resolvable in the database (an English name or exonym is corrected to the local spelling), the stated language, repeats, and benchmark questions. With cross-checking, the teacher answers the passed questions again blind and a different call marks the example disputed. `TeacherService` writes a batch in chunks of 20, two requests at a time, retrying rate limits, one batch at a time and at most `TEACHER_MAX_EXAMPLES_PER_DAY` examples per UTC day (deleted batches still count). Batches and examples are kept in `teacher_batches` and `teacher_examples`; a person reviews a batch, edits or approves examples (an edit runs the checks again), and accepts it into the dataset. Routes are under `/api/v1/training/teacher`.
