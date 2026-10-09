import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology } from "topojson-specification";
import countriesTopologyJson from "world-atlas/countries-110m.json";

const isoNumericByAlpha2: Record<string, string> = {
  DE: "276",
  PL: "616",
  RO: "642",
  FR: "250",
  IT: "380",
  ES: "724",
};

const topology = countriesTopologyJson as unknown as Topology;
const countryCollection = feature(topology, topology.objects.countries) as FeatureCollection<Geometry>;

export function countryBoundary(countryCode: string): Feature<Geometry> | null {
  const numericCode = isoNumericByAlpha2[countryCode.toUpperCase()];
  if (!numericCode) return null;
  return countryCollection.features.find((country) => String(country.id) === numericCode) ?? null;
}
