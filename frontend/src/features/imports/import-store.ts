import { useSyncExternalStore } from "react";
import type { ImportJob, OsmAreaCategory } from "@waypoint-ai/shared";

/** Event sources that can be imported from the app, in the order the dialog lists them. */
export const IMPORT_SOURCES = [
  { id: "ingv-fdsn", label: "INGV", license: "CC BY 4.0" },
  { id: "usgs-fdsn", label: "USGS", license: "Public domain" },
  { id: "demo-seismic-synthetic", label: "Synthetic demo", license: "CC0-1.0" },
] as const;
export const IMPORT_DAY_OPTIONS = [1, 3, 7, 14, 30] as const;

export interface ImportDraft { sourceIds: string[]; days: number }
export type ImportTab = "events" | "area" | "region";
/** Kinds of places offered for an area import, in the order the dialog shows them; the first ones are preselected. */
export const AREA_CATEGORIES: OsmAreaCategory[] = ["attraction", "museum", "gallery", "monument", "park", "restaurant", "cafe", "viewpoint", "castle", "church", "theatre", "bar", "hotel", "transport"];
export const DEFAULT_AREA_CATEGORIES: OsmAreaCategory[] = ["attraction", "museum", "gallery", "monument", "park", "restaurant", "cafe"];

interface ImportState {
  /** Newest first. */
  jobs: ImportJob[];
  importEnabled: boolean | null;
  dialogOpen: boolean;
  /** The job the dialog shows; it keeps running when the dialog is closed. */
  dialogJobId: string | null;
  dockCollapsed: boolean;
  /** Jobs the user closed in the dock; a running one keeps going. */
  dismissed: string[];
  draft: ImportDraft;
  /** When the last WebSocket update arrived; the dock polls the API when updates stop. */
  lastPushAt: number;
  /** Per source, when its import cooldown ends (epoch ms); absent or past means it may run now. */
  cooldownUntil: Record<string, number>;
  tab: ImportTab;
  areaCategories: OsmAreaCategory[];
  /** Largest area an OSM area import may cover, from the server. */
  maxAreaSquareDegrees: number;
}

const STORAGE_KEY = "waypoint-ai:imports:v1";
const listeners = new Set<() => void>();
let state: ImportState = {
  jobs: [],
  importEnabled: null,
  dialogOpen: false,
  dialogJobId: null,
  dockCollapsed: false,
  dismissed: [],
  draft: { sourceIds: ["ingv-fdsn"], days: 7 },
  lastPushAt: 0,
  cooldownUntil: {},
  tab: "events",
  areaCategories: DEFAULT_AREA_CATEGORIES,
  maxAreaSquareDegrees: 1,
  ...readPersisted(),
};

function readPersisted(): Partial<ImportState> {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ImportState> | null;
    if (!value || typeof value !== "object") return {};
    const sourceIds = Array.isArray(value.draft?.sourceIds) ? value.draft.sourceIds.filter((id): id is string => IMPORT_SOURCES.some((source) => source.id === id)) : [];
    const days = IMPORT_DAY_OPTIONS.find((option) => option === value.draft?.days) ?? 7;
    return {
      dockCollapsed: value.dockCollapsed === true,
      dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter((id): id is string => typeof id === "string").slice(-50) : [],
      draft: { sourceIds: sourceIds.length ? sourceIds : ["ingv-fdsn"], days },
      // The former "datasets" tab is now the data page.
      tab: value.tab === "area" || value.tab === "region" || value.tab === "events" ? value.tab : "area",
      areaCategories: Array.isArray(value.areaCategories) && value.areaCategories.length
        ? value.areaCategories.filter((category): category is OsmAreaCategory => AREA_CATEGORIES.includes(category as OsmAreaCategory))
        : DEFAULT_AREA_CATEGORIES,
    };
  } catch {
    return {};
  }
}

function set(next: Partial<ImportState>) {
  state = { ...state, ...next };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ dockCollapsed: state.dockCollapsed, dismissed: state.dismissed, draft: state.draft, tab: state.tab, areaCategories: state.areaCategories }));
  } catch {
    // Storage can be unavailable (private mode); the dock works without it.
  }
  for (const listener of listeners) listener();
}

/** Import jobs and the import UI, shared by the dialog, the dock, and the pages that open them. */
export const importStore = {
  getState: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** A job from the API or the WebSocket; a finished job fires "waypoint:import-finished" once. */
  upsert(job: ImportJob, pushed = false) {
    const previous = state.jobs.find((item) => item.id === job.id);
    // Updates can arrive out of order (WebSocket and polling); an older snapshot never replaces a newer one.
    if (previous && previous.updatedAt > job.updatedAt) return;
    const jobs = previous ? state.jobs.map((item) => item.id === job.id ? job : item) : [job, ...state.jobs].slice(0, 20);
    set({ jobs, ...(pushed ? { lastPushAt: Date.now() } : {}) });
    if (previous?.status === "running" && job.status !== "running") {
      window.dispatchEvent(new CustomEvent("waypoint:import-finished", { detail: job }));
    }
  },
  setImportEnabled: (importEnabled: boolean) => set({ importEnabled }),
  setCooldowns: (seconds: Record<string, number>) => set({
    cooldownUntil: Object.fromEntries(Object.entries(seconds).map(([sourceId, value]) => [sourceId, Date.now() + value * 1000])),
  }),
  openDialog(preset?: Partial<ImportDraft>, tab?: ImportTab) {
    const running = state.dialogJobId ? state.jobs.find((job) => job.id === state.dialogJobId && job.status === "running") : undefined;
    set({ dialogOpen: true, dialogJobId: running?.id ?? null, draft: { ...state.draft, ...preset }, ...(tab ? { tab } : {}) });
  },
  /** Closing never cancels: a running job moves to the dock. */
  closeDialog: () => set({ dialogOpen: false }),
  showJobInDialog: (jobId: string) => set({ dialogOpen: true, dialogJobId: jobId }),
  setDialogJob: (dialogJobId: string | null) => set({ dialogJobId }),
  setDraft: (draft: Partial<ImportDraft>) => set({ draft: { ...state.draft, ...draft } }),
  toggleDock: () => set({ dockCollapsed: !state.dockCollapsed }),
  setTab: (tab: ImportTab) => set({ tab }),
  setAreaCategories: (areaCategories: OsmAreaCategory[]) => set({ areaCategories }),
  setMaxArea: (maxAreaSquareDegrees: number) => set({ maxAreaSquareDegrees }),
  dismiss: (jobId: string) => set({ dismissed: [...state.dismissed, jobId].slice(-50) }),
  dismissAll: (jobIds: string[]) => set({ dismissed: [...new Set([...state.dismissed, ...jobIds])].slice(-50) }),
};

export function useImportState<T>(select: (value: ImportState) => T): T {
  return useSyncExternalStore(importStore.subscribe, () => select(importStore.getState()));
}
