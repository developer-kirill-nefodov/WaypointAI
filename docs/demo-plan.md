# Waypoint AI Demo Plan

## Goal

Demonstrate a complete local assistant workflow: ask for a short city visit, clarify missing details, retrieve verified places through backend functions, and show the same places and route on the map.

## Scenario: city visit

1. Open the workspace and show model readiness and the active local model.
2. Ask for a two-day visit to Warsaw with a preference such as museums or parks.
3. If airport or duration is ambiguous, answer the assistant's clarification.
4. Show that places come from the local OpenStreetMap snapshot, with source and coverage metadata.
5. Select a day to fit its stops and route on the map; select a stop to inspect its verified place details.
6. Ask a follow-up about a selected place or the itinerary. The backend supplies only scoped, bounded results through allowlisted functions.
7. If the local dataset or route provider cannot answer, show the explicit empty or unavailable state rather than inventing facts.

## What the demo demonstrates

- Inference runs through a locally managed Ollama runtime.
- The model can request a small allowlist of server functions; it does not access SQL, credentials, or arbitrary internet URLs.
- Place names, coordinates, itinerary stop IDs, and road geometry come from backend data and configured providers.
- The map uses local country geometry and verified place results. Road routing is a separate service and can be unavailable.

## Current limits

- OSM extracts cover selected European regions and may be incomplete or stale.
- The public routing endpoint is for development and has no availability guarantee.
- The demo has no account authentication or workspace authorization for real multi-user data.
- Model responses are inference, not training; conversations do not update model weights.

See [system workflow](system-workflow.md), [model setup](local-model-setup.md), and [demo rehearsal](demo-rehearsal.md).
