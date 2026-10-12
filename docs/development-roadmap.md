# Development Roadmap

## Current implementation

- React/Vite chat communicates with the backend through WebSocket and offers filters, map results, saved conversation history, cancellation, and EN/RU/DE language settings.
- Express, PostgreSQL/Sequelize, and a local Ollama provider are connected.
- Read-only backend tools provide place search, record search/details, and source metadata. Tool requests are validated and bounded.
- Verified trip plans are assembled from database place rows. Day selection links stops and road routes to the map.
- European OSM extracts are imported region by region. Synthetic event records are not seeded by default.

## Work remaining

### 1. Stabilize and verify the request flow

- Exercise normal, filtered, empty, cancelled, concurrent, and unavailable-model turns.
- Confirm result IDs and source provenance match between WebSocket events, cards, and map layers.
- Keep OpenAPI, WebSocket schema, shared types, and implementation in sync.

### 2. Improve assistant boundaries and answer quality

- Keep repeatable place resolution, scope, sorting, and itinerary selection in deterministic backend code.
- Maintain a compact system prompt and send only relevant verified results to the model.
- Build representative EN/RU/DE quality checks for city/country distinctions, follow-ups, selected places, and empty data.
- Measure latency, memory, and tool-call correctness before changing the model or adding more capabilities.

### 3. Improve dataset coverage

- Publish snapshot manifests with source, license, import date, and coverage region.
- Confirm that UI labels explain partial regional coverage and missing matches.
- Add ways/relations or additional regions only when a concrete scenario requires them.
- Keep imports repeatable and avoid checked-in map extracts.

### 4. Prepare for multi-user data

- Add authenticated users, workspaces, and per-source authorization before introducing sensitive or customer data.
- Use a least-privilege database role and audit reads.
- Define retention and field-minimization rules for model context, chat history, and logs.
- Add a server-side source adapter only after its schema, permissions, licensing, and network boundary are known.

## Current limitations

The demo has one local workspace and no user authentication. The place snapshots may be incomplete or outdated. Road routing is a separate optional service. Polygon filtering and official city boundaries are not available in the current extracts.

See [demo plan](demo-plan.md), [backend guide](backend.md), and [local model isolation](local-model-and-isolation.md).
