# Backend workspace

The backend uses Node.js 24 LTS, TypeScript, Express, Zod, PostgreSQL, Sequelize v6, and native WebSocket through `ws`. The local Ollama model is called only by the backend. See [the stack decision](../docs/stack-decision.md), [the backend guide](../docs/backend.md), and [the model and isolation plan](../docs/local-model-and-isolation.md).

From the repository root, create `.env`, start PostgreSQL with `docker compose up -d postgres`, run `npm run db:migrate`, and start development with `npm run dev`. PostgreSQL is published on loopback only. Model installation is a separate administrator action; application startup does not download it.

```text
backend/src/
├── server.ts
├── api/                 # HTTP health/capabilities and WebSocket route
├── assistant/           # turn orchestration and conversation state
├── llm/                 # local model provider adapter
├── tools/               # validated allowlisted functions
├── data/                # repositories and future product connectors
├── models/              # Sequelize models
├── migrations/          # PostgreSQL schema migrations
├── schemas/             # transport and domain validation
└── config/              # environment validation
```

Read `../PROJECT_RULES.md`, the relevant files in `../docs/`, and the contracts in `../contracts/` before changing backend behavior.
