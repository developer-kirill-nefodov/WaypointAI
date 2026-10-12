# Frontend structure and integration

## Stack and design

The application uses React, TypeScript, and Vite, with Leaflet behind the independent `widgets/map/` adapter. The map uses bundled Natural Earth country polygons to outline countries represented by current place results. It automatically requests an optimized road trip through up to eight places from the most represented country. The backend proxies coordinates to an OSRM-compatible service configured by `ROUTING_BASE_URL`; only coordinates are sent, never chat text, place names, or IDs. The default public OSRM demo endpoint is for development and has no availability guarantee; production should use an approved self-hosted endpoint. The Waypoint AI workspace focuses on requests, filters, evidence, and map results. Reference media is domain context, not a UI template. The demo requests visible OSM tiles from the browser and displays attribution. Configure `VITE_MAP_TILES_URL` to use another provider or disable the basemap. In offline mode, the country outlines remain available, but automatic road routes require a reachable routing endpoint. See [the stack decision](stack-decision.md).

## Source structure

```text
frontend/src/
├── app/                  # bootstrap, routes, global providers
├── features/assistant/   # conversation, composer, status, filters, history
├── features/results/    # result rows, evidence, filter chips
├── widgets/map/          # isolated map adapter
├── entities/record/      # shared record view and selection
└── shared/
    ├── api/              # WebSocket client and HTTP metadata client
    ├── i18n.ts           # English, Russian, and German locale preference
    └── ui/               # reusable controls and styles
```

Wire shapes come from `contracts/websocket.schema.json`; shared TypeScript mirrors live in `packages/shared/src/protocol.ts`; semantics and examples are in `contracts/websocket.md`. REST types are generated from `contracts/openapi.yaml` into `packages/shared/src/openapi.generated.ts`.

## WebSocket client flow

1. Load `GET /api/v1/assistant/capabilities` and `/api/v1/data/sources`; display readiness and server-provided source options.
2. Connect to `/api/v1/assistant/ws`, send `session.start`, and wait for `session.ready`.
3. Let the user choose source and date filters and a language (English, Russian, or German). Submit them in `turn.submit.scope` with a unique request ID. Pass the ID and kind of a selected map item; the backend resolves the card from the database and checks its source/date scope.
4. Handle acceptance, status, tool progress, and assistant text; ignore late events for other request IDs and prevent concurrent submissions.
5. Treat completion, clarification, error, and cancellation as terminal states. Restore the current transcript locally and send its conversation ID on each turn.
6. Build map highlights and source provenance from `turn.completed`. Outline country geometry from the local Natural Earth bundle. For two or more verified places, request the backend route endpoint; render returned road geometry, stop order, distance, and estimated duration. Selecting a result opens only returned fields. Do not infer missing values.
7. Trip plans support two map scopes: select the city header to fit and highlight its verified place points, or select a day to fit that day's stops and returned route geometry. Every click requests a fresh fit, including repeated selection of the currently active day. Numbered markers show the selected stop set. Selected places show their day and stop number, along with the metadata returned by the local snapshot. The current extracts include country geometry but no administrative city polygons; label city focus as verified place points, not as an official city boundary.
8. When a new trip needs destination clarification, clear the prior trip result and return the map to its Europe overview so old city POIs do not appear to belong to the new request.
9. If the socket drops, show a disconnected state and a retry action. Do not silently resend a request that the server might have accepted.

## Privacy and accessibility

- Browser code must not call Ollama or public data sources directly.
- Do not place prompts, IDs, or tokens in URL query strings.
- Display only fields returned by the backend.
- Keep the `demoMode=true` badge visible.
- Do not show stack traces, filesystem paths, or provider internals in user-facing errors.
- Support keyboard use and text status in addition to color.
- Request open driving trips from OSRM with the supported `roundtrip=false`, `source=first`, `destination=last` combination. A route line is rendered only when the backend returns valid road geometry; if the provider is unavailable, keep the verified stops visible and offer a retry.
