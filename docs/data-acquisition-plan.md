# Geospatial Data Acquisition

## Goal

Provide a local place catalogue with visible provenance and bounded search for map and itinerary workflows.

The current import covers six selected European areas: Berlin, Mazovia, Romania, Île-de-France, Central Italy, and Madrid. These are regional extracts except for Romania. They are not complete country-wide datasets in all cases. More data can be imported from the app's import dialog: the places of a city or area from the Overpass API (its own dataset, `osm-area-<name>`) or a whole Geofabrik region (`osm-region-<id>`); see the [backend guide](backend.md#import-jobs).

## Current import flow

`npm run data:import:europe` downloads selected Geofabrik PBF extracts, imports them sequentially, writes source manifests, and replaces prior place snapshots after successful imports. PBF files stay under ignored `data/local/europe/`. The importer stores named POI and address nodes and selected airport metadata; it does not retain general way/relation geometry. Backend search is read-only. The map loads local places in the current viewport after sufficient zoom.

Imported fields include names, categories, address fields, coordinates, and a bounded tag allowlist. Optional details such as cuisine, opening hours, wheelchair access, and websites may be sparse. OSM does not provide a universal rating or review field.

## Data layers

| Layer | Contents | Purpose |
|---|---|---|
| Basemap | Streets, water, buildings, borders, or vector tiles | Map orientation |
| Country outline | Bundled Natural Earth country shapes | Show country context without a live boundary lookup |
| Road route | Configured OSRM-compatible routing service | Return road geometry, stop order, distance, and duration for verified coordinates |
| `places` | Named POIs and explicit address points with category, region/city, address, coordinates, and source ID | Place search and map display |
| `records` | Earthquake events imported from INGV and USGS (public catalogues), and optional records from other configured sources; nothing is seeded by default | Event search, cross-checks, and general record search |
| `data_sources` | Provider, license, attribution, snapshot date, and import parameters | Provenance for each dataset |

Do not assume a POI has a complete address. Preserve missing values as missing; never guess them.

## Source and import rules

- Use OpenStreetMap regional PBF files from Geofabrik for the current local catalogue.
- Record source URL, snapshot date, file checksum, ODbL license, and `© OpenStreetMap contributors` attribution.
- Keep downloads and manifests under ignored local storage; do not commit extracts.
- Do not bulk geocode through public Nominatim or prefetch public OSM tiles.
- Review provider tile policies before online use. Offline basemaps require locally built tiles or vector layers.
- The development route endpoint proxies only selected place coordinates. The public OSRM demo host has no availability guarantee; use a managed or self-hosted endpoint for reliable deployment.

## Import quality checks

Confirm coordinates fall in selected regions; OSM type/IDs are unique; latitude and longitude are in the correct order; names and categories are preserved; no address is synthesized; source license, attribution, date, and URL are available through the API; and repeated imports are reproducible.

Import summaries must not include personal data. Any future records dataset requires a documented schema, source, permissions, retention policy, and field minimization before it is connected.

## Assistant integration

- Expose places through bounded, read-only backend functions.
- Filter by source, category, country, city, name, and viewport as supported by shared contracts.
- For selected map items, send only the item ID and kind. Reload the authoritative row on the server and validate source/date scope before adding its card to model context.
- Return consistent map features, place/record rows, and source metadata.
- Keep country, city, place type, and optional record concepts distinct. Do not infer missing attributes, ratings, or travel advice.

## Limitations

Current coverage is incomplete outside the full Romania extract. The region import is node-only and omits many features represented as ways or relations; area imports from Overpass also take ways and relations, as their centre points. Expand the importer only when a concrete query needs that coverage and storage/runtime costs are understood. Before loading any sensitive or customer dataset, implement authentication, workspace authorization, least-privilege database access, and retention controls.
