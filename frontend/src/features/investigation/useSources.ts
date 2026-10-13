import type { SourceView } from "@waypoint-ai/shared";
import { useEffect, useState } from "react";
import { loadDataSources } from "../../shared/api/client";

export type SourcesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; sources: SourceView[] };

/** Data sources with their sync status; reloaded whenever `reloadKey` changes. */
export function useSources(reloadKey: number): SourcesState {
  const [state, setState] = useState<SourcesState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    loadDataSources(controller.signal).then(
      (sources) => setState({ status: "ready", sources }),
      () => {
        if (!controller.signal.aborted) setState({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  return state;
}
