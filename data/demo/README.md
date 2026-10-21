# European OpenStreetMap Data

The default setup does not seed event records. Earthquakes are imported on demand from the public INGV and USGS catalogues (`npm run data:import:events` or the app's import dialog); an optional synthetic event set for offline demos is clearly labelled.

The place catalogue is imported from regional OpenStreetMap PBF files into ignored `data/local/` storage. The importer records provider, license, snapshot date, and a local SHA-256 manifest. It imports named POI and address nodes; it does not build map tiles or import way/building geometry. Area imports from the app (Overpass) also take ways and relations as centre points.

The default basemap requests visible OpenStreetMap tiles only and displays attribution. Review the provider policy before publishing. Full offline use requires a locally generated tile set.
