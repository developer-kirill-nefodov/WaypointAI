import type { PlaceView } from "@waypoint-ai/shared";
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { ArrowRight } from "lucide-react";
import { makeT, type Language } from "../../shared/i18n";
import { navigateTo } from "../../shared/routing";
import type { PulseRequest } from "../../widgets/map/MapPanel";
import type { MapScene } from "../../widgets/map/map-scene";
import { CatalogFilterBar, CatalogRows, CatalogStatus, PlaceCard, useCatalog, type Filters } from "../data/catalog";
import type { CatalogPlace } from "../imports/import-api";

type PlacesPanelProps = {
  language: Language;
  onScene: (scene: MapScene) => void;
  selectRef: MutableRefObject<((key: string) => void) | null>;
  onAsk: (place: PlaceView) => void;
};

export function toPlaceView(place: CatalogPlace): PlaceView {
  return {
    id: place.id, sourceId: place.datasetId, name: place.name, category: place.category, countryCode: place.countryCode, city: place.city,
    street: place.street, houseNumber: place.houseNumber, postcode: place.postcode, details: place.details, lat: place.lat, lon: place.lon,
  };
}

/** The places mode of the map page: the place catalog by country, city, and category, shown on the shared map. */
export default function PlacesPanel({ language, onScene, selectRef, onAsk }: PlacesPanelProps) {
  const t = makeT(language);
  const [filters, setFilters] = useState<Filters>({});
  const onFilters = useCallback((change: Partial<Filters>) => setFilters((current) => ({ ...current, ...change })), []);
  const catalog = useCatalog(undefined, filters, onFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Every pick in the list or on the map waves over the place, also when it is picked again.
  const [pulse, setPulse] = useState<PulseRequest | null>(null);
  const select = useCallback((id: string) => {
    setPulse({ key: `place:${id}`, revision: performance.now() });
    setSelectedId(id);
  }, []);
  const highlights = useMemo(() => catalog.rows.map(toPlaceView), [catalog.rows]);
  useEffect(() => {
    selectRef.current = (key: string) => { if (key.startsWith("place:")) select(key.slice("place:".length)); };
    return () => { selectRef.current = null; };
  }, [select, selectRef]);
  useEffect(() => {
    onScene({ records: [], recordSourceModes: {}, highlights, radius: null, focus: null, selectedKey: selectedId ? `place:${selectedId}` : null, sourceLabels: {}, resultsLoaded: Boolean(catalog.first.data), pulse });
  }, [highlights, selectedId, catalog.first.data, pulse, onScene]);
  // The chosen row scrolls into view when it was picked on the map.
  useEffect(() => {
    if (selectedId) document.querySelector(".places-panel .data-rows button.active")?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return <div className="places-panel">
    <div className="panel-heading">
      <div>
        <span className="eyebrow">{t("МЕСТА · OPENSTREETMAP", "PLACES · OPENSTREETMAP")}</span>
        <h2>{t("Каталог мест", "Place catalog")}</h2>
      </div>
      <button type="button" className="data-link-button" onClick={() => navigateTo("data")}>{t("Наборы данных", "Datasets")}<ArrowRight size={11} /></button>
    </div>
    {catalog.countries.loading ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p>
      : !catalog.country ? <p className="data-empty">{t("Мест пока нет. Импортируйте город или регион на странице «Данные».", "No places yet. Import a city or a region on the Data page.")}</p>
        : <>
          <CatalogFilterBar language={language} catalog={catalog} onChange={() => setSelectedId(null)} />
          <CatalogStatus language={language} catalog={catalog} onChange={() => setSelectedId(null)} />
          <CatalogRows language={language} catalog={catalog} selectedId={selectedId} onSelect={select}
            renderSelected={(place) => <PlaceCard language={language} place={place} floating={false} onClose={() => setSelectedId(null)} onAsk={(chosen) => onAsk(toPlaceView(chosen))} />} />
        </>}
  </div>;
}
