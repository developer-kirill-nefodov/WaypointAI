# Backend workspace

The backend uses Node.js 24 LTS, TypeScript, Express, Zod, PostgreSQL, Sequelize v6, and native WebSocket through `ws`. The local Ollama model is called only by the backend. See [the stack decision](../docs/stack-decision.md), [the backend guide](../docs/backend.md), and [the model and isolation plan](../docs/local-model-and-isolation.md).

From the repository root, create `.env`, start PostgreSQL with `docker compose up -d postgres`, run `npm run db:migrate`, and start development with `npm run dev`. PostgreSQL is published on loopback only. Model installation is a separate administrator action; application startup does not download it.

```text
backend/
├── database/migrations/ # PostgreSQL schema migrations (sequelize-cli)
├── test/                # unit tests and the PostgreSQL integration test
└── src/
    ├── server.ts        # Express app, routes, WebSocket, startup and shutdown
    ├── setup/           # wiring of import jobs and of the training routes and services
    ├── api/             # HTTP routes (assistant, data, investigations, training, fine-tuning, teacher, journal) and WebSocket
    ├── assistant/       # turn orchestration, router, lessons, citations, trip plans
    ├── llm/             # local model provider adapter
    ├── tools/           # validated allowlisted functions
    ├── data/            # repositories
    ├── services/        # imports, benchmark, exam runner, LoRA trainer, model packages, teacher
    ├── sources/         # INGV, USGS, synthetic events; OpenStreetMap services
    ├── voice/           # opt-in speech-to-text relay
    ├── cli/             # manual OSM and event import commands
    ├── models/          # Sequelize models
    ├── schemas/         # transport and domain validation
    └── config/          # environment validation
```

Read `../PROJECT_RULES.md`, the relevant files in `../docs/`, and the contracts in `../contracts/` before changing backend behavior.
