import type { EventDetailsResponse } from "@waypoint-ai/shared";
import { useEffect, useRef, useState } from "react";
import { errorCode, loadEventDetails } from "../../shared/api/investigations";

export type DetailsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; code: string }
  | { status: "ready"; details: EventDetailsResponse };

/** Loads the selected event with its linked places and focuses the details heading once it renders. */
export function useEventDetails(selectedId: string | null) {
  const [details, setDetails] = useState<DetailsState>({ status: "idle" });
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!selectedId) {
      setDetails({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    let focusFrame = 0;
    setDetails({ status: "loading" });
    loadEventDetails(selectedId, controller.signal).then(
      (response) => {
        setDetails({ status: "ready", details: response });
        // Move focus to the dialog heading so keyboard and screen-reader users land on the details.
        focusFrame = requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setDetails({ status: "error", code: errorCode(error) });
      },
    );
    return () => {
      controller.abort();
      cancelAnimationFrame(focusFrame);
    };
  }, [selectedId]);

  return { details, headingRef };
}
