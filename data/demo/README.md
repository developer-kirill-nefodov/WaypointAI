# European OpenStreetMap Data

The default setup does not seed synthetic event records. The record-search API remains available for a future explicitly configured dataset, but the demo starts without event fixtures.

The place catalogue is imported from regional OpenStreetMap PBF files into ignored `data/local/` storage. The importer records provider, license, snapshot date, and a local SHA-256 manifest. It imports named POI and address nodes; it does not build map tiles or import way/building geometry.

The default basemap requests visible OpenStreetMap tiles only and displays attribution. Review the provider policy before publishing. Full offline use requires a locally generated tile set.
