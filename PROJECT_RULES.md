# Project rules

## General

- Read this file and the relevant document in `docs/` before making changes.
- Label unconfirmed product requirements and APIs as `proposed` or `demo`.
- Never put real personal or identifying data in Git, fixtures, screenshots, or logs. Demo records must be synthetic.
- One model request is inference, not training. Do not claim the model learns from conversations unless a separate training workflow is implemented and approved.
- Record stack decisions in `docs/stack-decision.md`. Do not add a parallel implementation without updating that decision.
- Leaflet and Natural Earth are implementation choices for this demo.

## Contract sources of truth

- HTTP contracts are defined in `contracts/openapi.yaml`.
- WebSocket message shapes are defined in `contracts/websocket.schema.json`; semantics and examples are in `contracts/websocket.md`.
- Update the frontend, backend, JSON Schema, shared types, and documentation together when the protocol changes.
- REST types are generated into `packages/shared`; WebSocket types are maintained in `packages/shared/src/protocol.ts` alongside the JSON Schema validated by Ajv.
- Use `camelCase` for JSON and TypeScript fields. Map Sequelize fields to database columns explicitly.
- Return structured protocol errors with a `requestId`; never expose stack traces or internal addresses to clients.
- Version breaking changes through `/api/v1`.

## Frontend

- Use React and TypeScript. Keep shared API code and wire types in `frontend/src/shared/`.
- Keep feature code under `frontend/src/features/<feature>/`; do not put all behavior in one page.
- The UI must not call Ollama or connect directly to the database.
- Build maps, lists, counts, and source labels from backend results. Do not fabricate server results in the UI.
- Configure addresses through environment variables. Never put credentials or tokens in the browser bundle.
- Give loading, clarification, empty, error, and disconnected states distinct UI treatments.

## Backend

- Express handlers validate transport input and delegate to domain services.
- Keep orchestration, model adapters, tools, and repositories in their respective `assistant/`, `llm/`, `tools/`, and `data/` modules.
- The backend is the only component that accesses Ollama and data sources.
- The model may call only allowlisted tools. Validate arguments, access scope, types, time ranges, and limits. Never accept model-generated SQL or arbitrary URLs.
- Apply filters, geometry operations, and counts in ordinary validated code using parameterized Sequelize queries. Send the model only the minimum necessary results.
- MVP operations are read-only and must have timeouts and result limits.
- External sources require an explicit allowlist. Do not transmit device IDs, phone numbers, IP addresses, or raw user text without a specific approved need.

## Code style

- Use two spaces for indentation and keep one logical step per line; split long objects, conditionals, and function calls across lines.
- Keep feature behavior in focused modules instead of growing the main request or page component.
- Keep NodeNext backend/shared TypeScript import specifiers ending in `.js`; use extensionless imports in the Vite frontend.
- Keep all system prompts and source comments in English.

## Compatibility and changes

- Never change a WebSocket message on only one side of the connection.
- Document new events, fields, examples, terminal states, and errors in the shared contract.
- Do not add dependencies or services without recording the reason.
- Mark demo and mock behavior clearly in the UI, configuration, and README.
- Do not download a model or start an external service automatically as part of application startup; an administrator manages model deployment separately.
- System prompts, inline code comments, and source documentation must be written in English. User-facing interface copy may be localized.
