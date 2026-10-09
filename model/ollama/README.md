# Ollama Runtime

Use the root npm scripts to manage the optional local model runtime:

```sh
npm run model:install:local
npm run model:serve
npm run model:pull
```

The runtime and model weights live under ignored `data/local/`. The service binds to `127.0.0.1:11434`; the backend also accepts IPv6 loopback (`::1`) when configured explicitly. Inference limits are validated in `backend/src/config/model.ts` and sent per request by the provider.

Stop the server with Ctrl+C. Installation and model download are explicit administrative actions and are not run during app startup. See [local model setup](../../docs/local-model-setup.md) for settings, request flow, and troubleshooting context.
