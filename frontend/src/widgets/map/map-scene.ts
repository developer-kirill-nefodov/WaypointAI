import type { PlaceView, RecordView } from "@waypoint-ai/shared";
import type { MapFocusPoint, RecordSourceModes, SearchRadius } from "./MapPanel";

/** What a side panel of the map page asks the shared map to show while that panel is active. */
export interface MapScene {
  records: RecordView[];
  recordSourceModes: RecordSourceModes;
  highlights: PlaceView[];
  radius: SearchRadius | null;
  focus: MapFocusPoint | null;
  selectedKey: string | null;
  sourceLabels: Record<string, string>;
  resultsLoaded: boolean;
}

export const EMPTY_SCENE: MapScene = { records: [], recordSourceModes: {}, highlights: [], radius: null, focus: null, selectedKey: null, sourceLabels: {}, resultsLoaded: false };
