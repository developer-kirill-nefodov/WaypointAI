# Waypoint AI Project Guide

Waypoint AI is a self-hosted geospatial assistant demo. The model interprets a request and may ask the backend to run an allowlisted function. The server validates the request, retrieves bounded data, and returns verified results for the UI to display.

## Project documentation

- [System workflow](docs/system-workflow.md)
- [Local model setup](docs/local-model-setup.md)
- [Backend structure and API](docs/backend.md)
- [Frontend structure](docs/frontend.md)
- [HTTP contract](contracts/openapi.yaml)
- [WebSocket contract](contracts/websocket.md)
- [Demo plan](docs/demo-plan.md)
- [Demo rehearsal](docs/demo-rehearsal.md)
- [OpenStreetMap data plan](docs/data-acquisition-plan.md)

Reference media is used only for general domain context. Demo data must remain synthetic, and geographic place data must retain source, license, and snapshot attribution. External integrations belong behind explicit backend allowlists.
