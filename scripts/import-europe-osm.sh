#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/data/local/europe"
mkdir -p "$DATA_DIR"

while IFS='|' read -r code slug label url; do
  [[ -z "$code" ]] && continue
  file="$DATA_DIR/${slug}-latest.osm.pbf"
  partial="$file.part"
  if [[ ! -f "$file" ]]; then
    echo "Downloading $label OSM extract..."
    curl --fail --location --retry 3 --retry-delay 2 --continue-at - --output "$partial" "$url"
    mv "$partial" "$file"
  else
    echo "Using cached extract: $label"
  fi
done <<'AREAS'
DE|berlin|Berlin, Germany|https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
PL|mazowieckie|Mazovian Voivodeship, Poland|https://download.geofabrik.de/europe/poland/mazowieckie-latest.osm.pbf
RO|romania|Romania|https://download.geofabrik.de/europe/romania-latest.osm.pbf
FR|ile-de-france|Ile-de-France, France|https://download.geofabrik.de/europe/france/ile-de-france-latest.osm.pbf
IT|centro|Central Italy|https://download.geofabrik.de/europe/italy/centro-latest.osm.pbf
ES|madrid|Madrid, Spain|https://download.geofabrik.de/europe/spain/madrid-latest.osm.pbf
AREAS

cd "$ROOT"
npm run db:migrate

while IFS='|' read -r code slug label url; do
  [[ -z "$code" ]] && continue
  npm run data:import:osm -w @waypoint-ai/backend -- \
    --file "data/local/europe/${slug}-latest.osm.pbf" \
    --source-id "osm-${code,,}-${slug}" \
    --source-name "OpenStreetMap: ${label} regional extract" \
    --source-url "$url" \
    --country-code "$code" \
    --bbox "-180,-90,180,90"
done <<'AREAS'
DE|berlin|Berlin, Germany|https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf
PL|mazowieckie|Mazovian Voivodeship, Poland|https://download.geofabrik.de/europe/poland/mazowieckie-latest.osm.pbf
RO|romania|Romania|https://download.geofabrik.de/europe/romania-latest.osm.pbf
FR|ile-de-france|Ile-de-France, France|https://download.geofabrik.de/europe/france/ile-de-france-latest.osm.pbf
IT|centro|Central Italy|https://download.geofabrik.de/europe/italy/centro-latest.osm.pbf
ES|madrid|Madrid, Spain|https://download.geofabrik.de/europe/spain/madrid-latest.osm.pbf
AREAS

rm -f "$ROOT/data/local/osm-import-manifest.json"
echo "European OSM import finished for Berlin, Mazovia, Romania, Ile-de-France, central Italy, and Madrid."
