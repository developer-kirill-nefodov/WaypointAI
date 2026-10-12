# Local Model and Isolation

## Model runtime

The demo uses `qwen3:4b-instruct-2507-q4_K_M` through a locally managed Ollama runtime. The backend calls Ollama over loopback; the browser never does. Model setup is explicit and documented in [Local Model Setup](local-model-setup.md).

Inference does not train or update model weights. Conversation history is provided as context for later turns and is stored according to the retention behavior documented in [the backend guide](backend.md).

## Resource settings

The model request uses a 4096-token context, up to 768 generated tokens, batch size 256, temperature 0.2, and 60-second keep-alive by default. These values are configurable and validated by `backend/src/config/model.ts`. Ollama is configured for one parallel generation and one loaded model. Model file size is not a peak memory measurement; measure resource use on the machine where it will run.

## Capabilities and limits

The model interprets requests and may request only the backend functions declared in the allowlist. The backend validates function arguments, source/date scope, and result limits before querying PostgreSQL through Sequelize. Place identities and trip stops come from verified local rows. Route geometry and travel metrics come from the configured routing provider.

The model has no direct SQL, database credentials, filesystem, or arbitrary web-search access. It can only reason over data included in the current request context and results returned by those functions. Local inference does not make stale or incomplete data current; source coverage and snapshot dates still matter.

## Isolation boundary

- The browser calls the backend over HTTP and WebSocket.
- The backend is the only application component that accesses Ollama and PostgreSQL.
- Tool calls are read-only, allowlisted, validated, and bounded.
- Optional routing is a separate integration that receives coordinates only.
- Visible basemap tile requests are made by the browser and follow the selected tile provider's policy.

An allowlist alone is not authorization. The current demo has no user login or per-workspace authorization. Before using sensitive or customer data, enforce access control on every request, use a least-privilege database account, minimize model context, and define logging and retention.

## Evaluation

Compare models only against representative tasks. Measure grounded answer accuracy, correct tool selection, latency, peak memory, and CPU/GPU use across English, Russian, and German. More tools can add latency and make routing harder, so add them behind explicit task selection and keep deterministic operations in ordinary backend code.
