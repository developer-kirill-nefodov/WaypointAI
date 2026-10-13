# Waypoint AI stack decision

Status: **current demo implementation**. Revisit choices when product requirements or measured constraints change.

## Choices

| Area | Choice | Purpose |
|---|---|---|
| Frontend | React, TypeScript, Vite | Standalone UI and shared types |
| Markdown | `react-markdown`, `remark-gfm` | Safe rendering for lists, tables, links, and formatting; raw HTML is disabled |
| Icons | `lucide-react` | Consistent lightweight SVG icons |
| Map | Leaflet in `widgets/map/` plus Natural Earth 1:110m country shapes | Isolated map adapter with local country borders |
| Road routing | OSRM-compatible trip service, backend proxy | Optimize up to eight verified place stops without sending prompts or names |
| Approximate place names | PostgreSQL `fuzzystrmatch` (contrib extension, enabled by migration) | Resolve near-miss spellings of cities and towns in investigation queries; no new service |
| Event source (demo) | INGV FDSN event service, manual import via backend adapter | Public CC BY 4.0 earthquake events for the investigation workspace; no new dependency. See [technical-decisions.md](technical-decisions.md) |
| Runtime | Node.js 24 LTS, TypeScript | Shared language and type model |
| HTTP | Express | Thin REST routes and middleware |
| Validation | Zod | Runtime validation for domain and tool arguments |
| WebSocket | `ws` on the Express server | Chat messages, status, and streamed responses |
| Database | PostgreSQL, Sequelize v6 | Relational storage with managed migrations |
| Geometry | GeoJSON, Turf.js | Simple MVP geospatial operations; evaluate PostGIS for larger workloads |
| Model runtime | Ollama on loopback | Local inference called only by the backend |
| Model | `qwen3:4b-instruct-2507-q4_K_M` | Current local model for English, Russian, and German requests; weights are downloaded locally and excluded from Git |
| Demo data | Local OSM place snapshot; optional records are not seeded | Keep default map results grounded in imported source data |
| Demo basemap | Configurable OpenStreetMap tile URL | Viewport requests with attribution; can be disabled for offline use |
| Voice input (demo, opt-in) | OpenAI Realtime transcription over a backend WebSocket relay; browser AudioWorklet capture | Live dictation into the composer; disabled by default because audio leaves the machine |

Sequelize v6 is selected as the stable starting line. Moving to v7, currently documented as alpha, requires a separate compatibility decision. Sequelize v6 TypeScript models need explicit type declarations.

## Request flow

```text
React + TypeScript
       │ REST metadata / WebSocket chat
       ▼
Express + TypeScript ── validation
       ├── allowlisted tools → Sequelize → PostgreSQL
       ├── Turf.js → simple geometry operations
       ├── OSRM-compatible route service → optimized road geometry and metrics
       └── Ollama API → Qwen3 4B
       └── results, provenance, and GeoJSON → frontend
```

The frontend never connects to Ollama or PostgreSQL. The model can request only allowlisted backend functions such as `search_records` and `search_places`. The backend validates arguments and executes the query. It does not expose arbitrary SQL, URLs, shell commands, or write operations.

See [the full workflow diagram and component table](system-workflow.md) for the request path, external-service boundaries, and component responsibilities.

## Voice input decision

Status: **demo, opt-in** (`VOICE_INPUT_ENABLED=false` by default).

- **Choice.** The browser captures microphone audio with a native `AudioWorklet` and converts it to 24 kHz mono PCM16. It sends ~100 ms chunks as `voice.*` frames over the existing assistant WebSocket. The backend (`backend/src/voice/`) relays them to the OpenAI Realtime transcription endpoint using the existing `ws` dependency and streams transcript deltas back. No new npm dependencies were added.
- **Why a backend relay.** Project rules forbid credentials in the browser bundle and require external services to be reached only by the backend through an allowlist. Direct browser-to-OpenAI WebRTC or ephemeral client tokens were rejected for this reason.
- **Why OpenAI.** The local model runtime has no streaming speech-to-text. OpenAI Realtime returns incremental transcripts with low latency. The adapter sits behind `TranscriptionProvider`, so a self-hosted engine can replace it later without a protocol change.
- **Privacy trade-off.** While recording, audio is sent to OpenAI. This is the only path where raw user input leaves the machine. The UI says so during recording, the backend does not store or log audio or transcripts, and the transcript is only placed in the composer, never submitted automatically.
- **Limits.** One voice session per connection, `VOICE_MAX_SESSION_SECONDS` (default 120), a connection timeout, a per-session audio volume cap, and frames below the 16 KiB WebSocket payload limit.

## Resource profile

- One local model instance and one concurrent inference.
- Start with a 4096-token context; increase it only after measuring memory and latency.
- Use a 60-second idle unload interval, or set it to zero when memory matters more than warm-start latency.
- Send compact, capped results; do not add an embedding model or vector database to the first version.
- Model file size is not peak RAM usage. Measure peak RAM/VRAM on the deployment machine.

## Contracts and compatibility

- `contracts/openapi.yaml` is the HTTP source of truth.
- `contracts/websocket.schema.json` and `contracts/websocket.md` are the WebSocket source of truth.
- JSON fields use `camelCase`. Update both sides and shared types together.
- Any future synthetic records must be labeled as synthetic; imported public data retains source attribution.
- Use migrations for schema changes. Do not enable destructive automatic `sync` in production.

## Replaceable choices

The map adapter isolates Leaflet, and repositories isolate Sequelize. Keep integrations behind the documented contracts.

## Primary references

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [Express routing](https://expressjs.com/en/guide/routing/)
- [Sequelize v6 documentation](https://sequelize.org/docs/v6/)
- [Sequelize PostgreSQL support](https://sequelize.org/docs/v6/other-topics/dialect-specific-things/)
- [Sequelize TypeScript notes](https://sequelize.org/docs/v6/other-topics/typescript/)
- [Sequelize v7 PostgreSQL dialect](https://sequelize.org/docs/v7/databases/postgres/)
- [Turf.js documentation](https://turfjs.org/docs/getting-started)
- [Qwen3 4B model page](https://ollama.com/library/qwen3%3A4b-instruct-2507-q4_K_M)
- [Leaflet quick start](https://github.com/Leaflet/Leaflet/blob/main/docs/examples/quick-start/index.md)
- [OSRM HTTP API](https://project-osrm.org/docs/v5.24.0/api/#trip-service)
- [Natural Earth](https://www.naturalearthdata.com/)
