# Waypoint AI

Waypoint AI is a self-hosted map assistant built around one rule: **the model cannot invent a fact**. A local LLM turns natural-language requests into validated, read-only backend searches, and every place name, coordinate, and route on the map comes from verified database rows or the routing service. When the model is unavailable, a rule-based parser takes over and the UI says so.

It covers OpenStreetMap places, multi-city itineraries with road routes, and public earthquake data searched by place, radius, and period — all on one map with three modes: the assistant, events, and places.

![Waypoint AI: the chat finds earthquakes within 60 km of Perugia and draws the search radius on the map](docs/media/waypoint-ai-route-chat.png)

[![CI](https://github.com/developer-kirill-nefodov/WaypointAI/actions/workflows/ci.yml/badge.svg)](https://github.com/developer-kirill-nefodov/WaypointAI/actions/workflows/ci.yml)

## Why the model can't invent a stop

The assistant can interpret a trip request, but it does not write the final stop list. The backend assembles itineraries from verified place rows already stored in the database. Place names and coordinates come from those rows, while route geometry and distance come from the routing service. When the available data does not contain a matching place, the assistant asks for clarification or reports that no matching stop was found.

The model runs through a locally managed Ollama service. It can request a small allowlist of backend functions; the backend validates each request and queries approved data sources. The model does not receive database credentials, arbitrary SQL, or general internet access.

## What the demo shows

- English, Russian, and German assistant interactions over WebSocket: a live step feed (understanding, each tool call with its result count, assembling the answer), answers streamed as they are written, and automatic reconnection.
- Local inference through Ollama. The model interprets every message in any language and answers only through allowlisted tools: five read-only searches (`search_places`, `search_records`, `get_record_details`, `list_sources`, `search_events`), `plan_trip` and `edit_trip_plan` for the trip plan of the current conversation, and `reply` for answers that need no data. The server validates every tool call with Zod; there are no keyword rules for intent.
- Search over imported OpenStreetMap places and clear source coverage metadata.
- Deterministic itineraries for 1–7 days across up to five cities ("Rome and Florence for 5 days"): stops come from verified place rows, each day gets its own road route, and each city's visited area is outlined on the map. The plan stays editable in the chat, in any language: "add a museum to day 2", "remove the first stop of day 1", "move Melt Museum to day 2", "one more day with parks", "places only, no route". The server keeps the plan per conversation and picks every new stop from the database; the model only names the change.
- Event search from the chat: "earthquakes within 60 km of Perugia this month" resolves the settlement on the server, runs a bounded radius query, and draws the circle on the map.
- Answers cite their data. Each event or place a tool shows the model gets a ref (`E1`, `P1`); the answer marks facts with it (`M3.1 near Norcia [E2]`), the server removes any ref no tool returned, and the chat shows the refs as chips that select the row on the map, with a "Sources of this answer" list linking to the row's page at INGV, USGS, or OpenStreetMap. When the model cites nothing, the list shows the rows it was given.
- Cross-checked events. Earthquakes are imported from two independent catalogues, INGV and USGS; the same earthquake in both (within 30 s and 50 km) is matched at import and listed once. Each event says whether the other catalogue confirms it, describes it differently (magnitude or depth), or does not list it, and its details compare the two side by side.
- Explicit empty, clarification, model-unavailable, and route-unavailable states.
- Optional live voice dictation through OpenAI (disabled by default; the only feature that sends data off the machine). See [Voice input](#voice-input-demo-opt-in).
- One map page with three modes: **Assistant** (the chat), **Events** (imported INGV and USGS earthquakes by period, magnitude, and source, cross-checked between the catalogues, with a period summary and details linked to nearby OSM places), and **Places** (the place catalog by country, city, and category). Any event or place can be handed to the assistant with "Ask the assistant": it becomes the selected map point and a ready question is offered. See [Map and events](#map-and-events-demo).
- A **Data** page to explore, import, and delete datasets: every record page by page beside a map, countries and cities, and the import history.

The included OpenStreetMap extracts cover selected regions in Germany, Poland, Romania, France, Italy, and Spain; coverage is not complete in every country. Event records are imported on demand from INGV and USGS; an optional synthetic event set for offline demos is clearly labelled.

## Architecture

```text
React + Vite
   | HTTP and WebSocket
   v
Express backend --- allowlisted tools --- Sequelize --- PostgreSQL
   |
   +--- Ollama on loopback
   +--- optional routing provider (coordinates only)
   +--- INGV and USGS event APIs (manual import, allowlisted hosts)
```

See the [system workflow](docs/system-workflow.md), [stack decision](docs/stack-decision.md), [backend guide](docs/backend.md), [frontend guide](docs/frontend.md), [model setup](docs/local-model-setup.md), and [demo plan](docs/demo-plan.md).

## Requirements

- Node.js 24 LTS
- Docker Compose
- Ollama runtime and model, installed separately for local inference
- Network access for first-time package, runtime, model, and optional map-data downloads

## Setup

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run model:install:local
npm run data:import:europe
```

In one terminal, start the local model server; in another, pull the configured model:

```bash
npm run model:serve
npm run model:pull
```

Optionally import recent earthquake events for the map's events mode (requires network access to INGV and USGS); importing both catalogues for the same period enables the cross-check:

```bash
npm run data:import:events -- --source ingv-fdsn --days 7
npm run data:import:events -- --source usgs-fdsn --days 7
```

Then start the app:

```bash
npm run dev
```

The frontend runs at `http://127.0.0.1:5173` (pages: `/`, `/map` with `?mode=events` or `?mode=places`, `/data`, `/model`; the former `/investigation` opens the events mode); the API health endpoint is `http://127.0.0.1:8000/api/v1/healthz`. Model weights, Ollama runtime files, map extracts, and local environment values are excluded from Git. Setup scripts do not run automatically when the app starts. See [model configuration](docs/local-model-setup.md) for environment settings.

## Data and privacy boundaries

The browser talks only to the backend. The backend is the only component that connects to Ollama and PostgreSQL. Model tool calls are validated, read-only, and bounded. Apart from the opt-in voice input, chat text never leaves the machine; the routing provider receives coordinates only. Conversation retention and the single-workspace demo limitations are documented in the [backend guide](docs/backend.md).

OpenStreetMap attribution and source metadata are shown in the app. The optional map tile and routing providers are separate external services; routing sends coordinates only. The demo does not provide user authentication or multi-workspace authorization and should not be used with sensitive data.

## Map and events (demo)

The **Map** page has one map and a side panel with three modes. **Events** searches imported events by period, magnitude, source, and radius, summarizes the period (how many events, the strongest magnitude, the latest), and shows each event's provenance, licence, and nearby OpenStreetMap places. Questions in plain words, such as "events within 30 km of Norcia in the last 3 days", go to the **Assistant**, which calls `search_events` and draws the radius on the same map; "Ask the assistant" on an event or place makes it the selected map point for such a question. On the assistant map, an **Events** layer switch shows the last week's earthquakes behind the chat's results.

- **Data sources.** [INGV](https://terremoti.ingv.it/en) earthquake catalogue (FDSN event service, CC BY 4.0) and the [USGS](https://earthquake.usgs.gov/earthquakes/search/) catalogue (FDSN event service, public domain), imported manually for the same area (`EVENT_IMPORT_BBOX`). Imports are idempotent, audited in `source_sync_runs`, and retried safely. For offline demos, `--source demo-seismic-synthetic` loads generated events labelled as synthetic; synthetic events are never cross-checked.
- **Cross-check.** After each import of a live catalogue, its events are matched with the other catalogue's (within 30 s and 50 km, closest pair first, one pair per event) into `record_matches`. A pair is *confirmed* when magnitudes differ by at most 0.5 and depths by at most 10 km (or 10% for deep events), otherwise a *conflict*. An event without a pair is *only in one catalogue* when the other was imported for that time, and *unchecked* otherwise. USGS lists few European events below about M2.5, so most small INGV events have no USGS pair; this is expected and said in the UI. The events list merges copies (INGV preferred) and can show only confirmed events; the assistant's `search_events` merges them too and tells the model which catalogue confirms each event.
- **Import from the app.** "Import data" opens a dialog with three tabs. *City or area* finds a city through OpenStreetMap Nominatim, shows its extent on a small map, and loads the chosen kinds of places (attractions, museums, parks, restaurants, …) from the Overpass API into its own dataset (`osm-area-<name>`); the assistant can search and plan trips there on its next turn. *Whole region* searches the Geofabrik catalogue ("Lesser Poland", "Bayern", "Luxembourg"), shows the file size and date, then downloads the region and parses it in a separate process with progress in megabytes, the same way the built-in regions were imported. *Events* loads one or more event sources (INGV, USGS, synthetic demo) for 1–30 days. The loaded datasets are on the **Data** page. Closing it keeps the import running in a dock at the side of the page, with a ring and a bar per source, the day being fetched, counts, cancel, and retry for failed sources. Progress arrives over the assistant WebSocket, jobs are stored in `import_jobs`, so the dock reattaches after a reload, and the page refreshes when a job finishes. Starting imports needs `INVESTIGATION_IMPORT_ENABLED=true` (there is no authentication). Overpass and Nominatim are reached only on allowlisted hosts, at most one area import runs at a time with a pause between requests, and an area is limited to `OSM_AREA_MAX_SQUARE_DEGREES` (default 1).
- **API.** `GET /api/v1/investigations/events`, `GET /events/{id}`, `GET /entities/{id}`, `POST /query`, and import jobs (`GET|POST /imports`, `GET /imports/{id}`, `POST /imports/{id}/cancel`); starting imports is disabled by default. See [`contracts/openapi.yaml`](contracts/openapi.yaml).
- **AI boundary.** For a query, the local model may call only `search_events`. Its arguments are strictly validated, place names are resolved to verified OSM settlements, and the database returns the rows. When the model is unavailable or returns an invalid call, a rule-based parser is used and the UI says so.

| Variable | Default | Purpose |
|---|---|---|
| `EVENT_SOURCE_INGV_URL` | INGV FDSN query URL | Must be HTTPS on `webservices.ingv.it` |
| `EVENT_SOURCE_USGS_URL` | USGS FDSN query URL | Must be HTTPS on `earthquake.usgs.gov` |
| `EVENT_IMPORT_BBOX` | `6,35,19,48` | Import area (minLon,minLat,maxLon,maxLat) |
| `EVENT_IMPORT_COOLDOWN_SECONDS` | `600` | Minimum time between imports of one source |
| `EVENT_IMPORT_TIMEOUT_MS` | `20000` | Timeout per upstream attempt |
| `INVESTIGATION_IMPORT_ENABLED` | `false` | Enables `POST /investigations/import/{sourceId}`; there is no authentication |
| `TRUST_PROXY` | `false` | Reverse-proxy hop count for per-client rate limits |

Start with these two documents:

- [Technical decisions](docs/technical-decisions.md): how INGV, USGS, and EMSC compare on licence, coverage, and response format, why INGV is the primary source and USGS the cross-check, how their fields map to the schema, and the matching rules.
- [Demo and review guide](docs/demo-and-review.md): what to try, what each request should return, and where the safety boundaries are.

Also: [extension plan](docs/extension-plan.md) and [known issues and fixes](docs/code-review.md).

## Voice input (demo, opt-in)

Voice input is the only feature that sends data to an external AI service, and it is **off by default**; model inference and chat text stay local, and the routing provider receives coordinates only. Set `VOICE_INPUT_ENABLED=true` and `OPENAI_API_KEY` in `.env` to show a microphone button in the chat composer. The backend relays audio to OpenAI Realtime transcription, and recognized text appears in the composer as you speak. **Audio leaves the local machine while you record**, and the UI shows a notice during recording. The API key stays on the backend, and spending is capped: a process-wide limit on open sessions plus an hourly budget of sessions and recording seconds per client (`VOICE_MAX_CONCURRENT_SESSIONS`, `VOICE_SESSIONS_PER_CLIENT_PER_HOUR`, `VOICE_SECONDS_PER_CLIENT_PER_HOUR`). See the [voice protocol](contracts/websocket.md#voice-input-demo-opt-in) and the [stack decision](docs/stack-decision.md#voice-input-decision).

## Development checks

```bash
npm run typecheck
npm run build
npm test
# PostgreSQL integration tests on a disposable database (created and migrated automatically; name must contain "test"):
TEST_DATABASE_URL=postgres://waypoint:waypoint_dev@127.0.0.1:5433/waypoint_test npm run test:db
```

See [demo rehearsal](docs/demo-rehearsal.md) and [project rules](PROJECT_RULES.md).
