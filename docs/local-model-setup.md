# Local Model Setup

This guide describes the implemented Ollama integration and where each responsibility lives.

## Runtime lifecycle

1. `npm run model:install:local` installs the Ollama runtime under ignored `data/local/ollama-runtime/`.
2. `npm run model:serve` starts Ollama on loopback with cloud features disabled.
3. `npm run model:pull` downloads the model named by `OLLAMA_MODEL` into ignored local storage.
4. The backend validates model configuration once in `backend/src/config/model.ts`, composed into `backend/src/config/env.ts`.
5. `backend/src/llm/ollama.provider.ts` calls `/api/chat` and maps readiness, generation, cancellation, and provider errors.
6. `backend/src/assistant/turn.ts` coordinates a turn and calls allowlisted tools. Tools validate inputs and delegate to repositories; the model has no database credentials or SQL access.
7. The browser communicates only with the backend through HTTP and WebSocket.

The install and model download require network access. Inference is local after setup. Map tiles and the optional routing provider are separate network integrations; see [model isolation](local-model-and-isolation.md).

## Configuration

`.env.example` is the setting template; copy values into an ignored `.env` for local overrides.

| Setting | Default | Bounds / behavior |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Must use `localhost`, `127.0.0.1`, or `::1` loopback |
| `OLLAMA_MODEL` | `qwen3:4b-instruct-2507-q4_K_M` | Non-empty local model tag |
| `OLLAMA_NUM_CONTEXT` | `4096` | 512–32768 tokens |
| `OLLAMA_NUM_PREDICT` | `768` | 128–2048 generated tokens |
| `OLLAMA_NUM_BATCH` | `256` | 1–2048 |
| `OLLAMA_TEMPERATURE` | `0.2` | 0–2 |
| `OLLAMA_KEEP_ALIVE` | `60s` | Ollama idle retention duration |

Do not start the model server or download weights automatically as part of application startup. Keep model files and credentials out of Git.

## Module responsibilities

| Path | Responsibility |
|---|---|
| `model/ollama/scripts/install.sh` | Install the local runtime explicitly |
| `model/ollama/scripts/serve.sh` | Start the runtime bound to loopback |
| `model/ollama/scripts/pull-model.sh` | Pull the configured model explicitly |
| `backend/src/config/model.ts` | Validate model-specific environment settings |
| `backend/src/config/env.ts` | Parse and export the complete backend environment |
| `backend/src/llm/ollama.provider.ts` | Ollama transport and response mapping |
| `backend/src/assistant/turn.ts` | Turn coordination and bounded model/tool orchestration |
| `backend/src/tools/` | Allowlisted, validated backend functions |
| `backend/src/data/` | Repository access to local data stores |

Backend and shared NodeNext imports use `.js` specifiers in TypeScript so emitted ESM resolves correctly. Frontend Bundler imports do not need that suffix.

## Request boundary

```text
Browser -> Backend WebSocket -> Assistant coordinator -> Ollama on loopback
                                      |                    |
                                      +-> validated tools -> repositories -> PostgreSQL
```

The model can request only declared tools. The backend validates tool names, arguments, scope, time ranges, and limits before reading data. See [backend architecture](backend.md) and [system workflow](system-workflow.md).
