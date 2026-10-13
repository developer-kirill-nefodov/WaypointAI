# Waypoint AI

Waypoint AI is a self-hosted geospatial assistant demo. It turns natural-language place and itinerary requests into verified backend searches, then connects the returned places to map highlights and routes.

![Waypoint AI showing verified Berlin places and a generated route](docs/media/waypoint-ai-route-chat.png)

[![CI](https://github.com/developer-kirill-nefodov/WaypointAI/actions/workflows/ci.yml/badge.svg)](https://github.com/developer-kirill-nefodov/WaypointAI/actions/workflows/ci.yml)

## Why the model can't invent a stop

The assistant can interpret a trip request, but it does not write the final stop list. The backend assembles itineraries from verified place rows already stored in the database. Place names and coordinates come from those rows, while route geometry and distance come from the routing service. When the available data does not contain a matching place, the assistant asks for clarification or reports that no matching stop was found.

The model runs through a locally managed Ollama service. It can request a small allowlist of backend functions; the backend validates each request and queries approved data sources. The model does not receive database credentials, arbitrary SQL, or general internet access.

## What the demo shows

- English, Russian, and German assistant interactions.
- Local inference with an explicit model lifecycle and configurable resource limits.
- Search over imported OpenStreetMap places and clear source coverage metadata.
- Deterministic itinerary stops built from verified place rows, with a route displayed when the configured route service returns one.
- Explicit empty, clarification, model-unavailable, and route-unavailable states.
- Optional live voice dictation (demo, disabled by default). See [Voice input](#voice-input-demo-opt-in).
- An investigation workspace for public event data: imported INGV earthquakes linked to nearby OSM places, a bounded REST API, and natural-language queries in which the model only fills in validated search filters. See [Investigation workspace](#investigation-workspace-demo).

The included OpenStreetMap extracts cover selected regions in Germany, Poland, Romania, France, Italy, and Spain; coverage is not complete in every country. Event records are imported on demand from INGV; an optional synthetic event set for offline demos is clearly labelled.

## Architecture

```text
React + Vite
   | HTTP and WebSocket
   v
Express backend --- allowlisted tools --- Sequelize --- PostgreSQL
   |
   +--- Ollama on loopback
   +--- optional routing provider (coordinates only)
   +--- INGV event API (manual import, allowlisted host)
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

Optionally import recent earthquake events for the investigation workspace (requires network access to INGV):

```bash
npm run data:import:events -- --source ingv-fdsn --days 7
```

Then start the app:

```bash
npm run dev
```

The frontend runs at `http://127.0.0.1:5173` (pages: `/`, `/map`, `/investigation`, `/model`); the API health endpoint is `http://127.0.0.1:8000/api/v1/healthz`. Model weights, Ollama runtime files, map extracts, and local environment values are excluded from Git. Setup scripts do not run automatically when the app starts. See [model configuration](docs/local-model-setup.md) for environment settings.

## Data and privacy boundaries

The browser talks only to the backend. The backend is the only component that connects to Ollama and PostgreSQL. Model tool calls are validated, read-only, and bounded. Conversation retention and the single-workspace demo limitations are documented in the [backend guide](docs/backend.md).

OpenStreetMap attribution and source metadata are shown in the app. The optional map tile and routing providers are separate external services; routing sends coordinates only. The demo does not provide user authentication or multi-workspace authorization and should not be used with sensitive data.

## Investigation workspace (demo)

The **Investigation** page (radar icon) searches imported events by period, magnitude, source, and radius; shows each event's provenance, licence, last sync, and nearby OpenStreetMap places; and accepts natural-language queries such as "events within 30 km of Norcia in the last 3 days".

- **Data source.** [INGV](https://terremoti.ingv.it/en) earthquake catalogue (FDSN event service, CC BY 4.0), imported manually. Imports are idempotent, audited in `source_sync_runs`, and retried safely. For offline demos, `--source demo-seismic-synthetic` loads generated events labelled as synthetic.
- **API.** `GET /api/v1/investigations/events`, `GET /events/{id}`, `GET /entities/{id}`, `POST /query`, and an import trigger that is disabled by default. See [`contracts/openapi.yaml`](contracts/openapi.yaml).
- **AI boundary.** For a query, the local model may call only `search_events`. Its arguments are strictly validated, place names are resolved to verified OSM settlements, and the database returns the rows. When the model is unavailable or returns an invalid call, a rule-based parser is used and the UI says so.

| Variable | Default | Purpose |
|---|---|---|
| `EVENT_SOURCE_INGV_URL` | INGV FDSN query URL | Must be HTTPS on an allowlisted host |
| `EVENT_IMPORT_BBOX` | `6,35,19,48` | Import area (minLon,minLat,maxLon,maxLat) |
| `EVENT_IMPORT_COOLDOWN_SECONDS` | `600` | Minimum time between imports of one source |
| `EVENT_IMPORT_TIMEOUT_MS` | `20000` | Timeout per upstream attempt |
| `INVESTIGATION_IMPORT_ENABLED` | `false` | Enables `POST /investigations/import/{sourceId}`; there is no authentication |
| `TRUST_PROXY` | `false` | Reverse-proxy hop count for per-client rate limits |

Design and review: [extension plan](docs/extension-plan.md), [technical decisions](docs/technical-decisions.md), [code review](docs/code-review.md), [demo and review guide](docs/demo-and-review.md).

## Voice input (demo, opt-in)

Set `VOICE_INPUT_ENABLED=true` and `OPENAI_API_KEY` in `.env` to show a microphone button in the chat composer. The backend relays audio to OpenAI Realtime transcription, and recognized text appears in the composer as you speak. **Audio leaves the local machine while you record**, and the UI shows a notice during recording. The API key stays on the backend. See the [voice protocol](contracts/websocket.md#voice-input-demo-opt-in) and the [stack decision](docs/stack-decision.md#voice-input-decision).

## Development checks

```bash
npm run typecheck
npm run build
npm test
# PostgreSQL integration tests on a disposable database (created and migrated automatically; name must contain "test"):
TEST_DATABASE_URL=postgres://waypoint:waypoint_dev@127.0.0.1:5433/waypoint_test npm run test:db
```

See [demo rehearsal](docs/demo-rehearsal.md) and [project rules](PROJECT_RULES.md).
