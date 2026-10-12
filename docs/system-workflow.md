# System workflow

This page describes the current local demo architecture. It is suitable for GitHub Markdown: GitHub renders the Mermaid diagram and the component table below.

## Request flow

```mermaid
flowchart LR
    U[User] --> UI[React and Vite UI]
    UI -->|REST: readiness and source metadata| API[Express API]
    UI -->|WebSocket: message, filters, language, selected item| API
    API --> ORCH[Assistant orchestration]
    ORCH --> VALIDATE[Validate protocol, scope, and limits]
    VALIDATE --> ROUTER{Request type}
    ROUTER -->|Travel lookup| PREFETCH[Verified place prefetch]
    ROUTER -->|Open-ended question| MODEL[Local Ollama model]
    MODEL -->|Generated answer| ORCH
    PREFETCH --> REPO
    MODEL -->|Function name and validated arguments| TOOLS
    TOOLS --> REPO[Sequelize repositories]
    REPO --> DB[(PostgreSQL)]
    DB --> TOOLS
    TOOLS -->|Bounded results and source metadata| ORCH
    PREFETCH -->|Verified places and typed itinerary| ORCH
    ORCH -->|Text, map features, itinerary, provenance| UI
    UI --> MAP[Map and selected place details]

    UI -->|Route request with coordinates| API
    API -->|Coordinates only| ROUTE[OSRM-compatible route service]
    ROUTE -->|Road geometry and metrics| API
    API -->|Route response| UI
    UI -->|Viewport tile requests| TILES[Configured map tile provider]

    OSM[OpenStreetMap regional extracts] -->|Manual import command| DB
    ADMIN[Administrator] -->|Explicit setup command| DOWNLOAD[Download Ollama runtime and model weights]
    DOWNLOAD --> MODEL
```

## Component table

| Component | Responsibility | Boundary |
|---|---|---|
| React/Vite frontend | Sends chat requests, displays source evidence, results, and map layers | Does not connect to PostgreSQL or Ollama. Map tiles are fetched from the configured tile provider. |
| Express API and WebSocket | Validates requests, reports readiness, streams status and results | Uses the contracts in [`contracts/openapi.yaml`](../contracts/openapi.yaml) and [`contracts/websocket.md`](../contracts/websocket.md). |
| Assistant orchestration | Chooses the bounded travel workflow or model-assisted tool flow | Applies the active source/date scope and selected map item context. |
| Ollama model | Interprets open-ended requests and may request an available function | Runs locally. It has no database credentials, SQL access, shell access, or general web-search tool. |
| Allowlisted functions | Searches optional configured records, verified OSM places, and source metadata | Function arguments are validated; queries use repositories and bounded results. |
| Sequelize and PostgreSQL | Stores imported places, source metadata, conversations, and optional records | The model never connects to the database directly. |
| Route service | Returns road geometry and route metrics for verified coordinates | The backend sends coordinates only; it does not send chat text, place names, or IDs. The demo endpoint is not guaranteed. |
| OSM snapshot importer | Imports selected regional place extracts into the local database | Run manually. Snapshot coverage can be incomplete or outdated; retain ODbL attribution. |
| Model setup scripts | Install the local Ollama runtime and pull the configured model | Run manually with `npm run model:install:local`, start the server with `npm run model:serve`, then pull weights with `npm run model:pull`. Model weights and runtime files stay in ignored `data/local/`. |

## Data boundaries

- User text reaches the assistant backend over the WebSocket connection. Only the backend sends the prompt and bounded tool results to the local Ollama process.
- The model can request only the functions declared in the server allowlist. The backend validates arguments and executes the relevant repository operation.
- Place search uses locally imported OpenStreetMap snapshots. The model does not browse the internet.
- Routing is a separate backend request to the configured routing provider. In the demo configuration, that provider may be public and receives route coordinates.
- The browser map may request visible tiles from the configured tile provider. These requests do not include chat text or selected place IDs.
- Model runtime files, model weights, local database files, `.env`, imported chat material, and screen recordings must not be committed.

## Related documentation

- [Project setup and model download](../README.md#local-setup)
- [Backend lifecycle and endpoints](backend.md)
- [Frontend and map integration](frontend.md)
- [Model isolation and limitations](local-model-and-isolation.md)
- [Stack decision and request flow](stack-decision.md)
