import { useEffect } from "react";

/**
 * Closes open `<details>` popovers on a click outside them, and all of them on Escape (focus returns to the last
 * one's summary).
 */
export function usePopoverDismiss(): void {
  useEffect(() => {
    const closePopovers = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      document.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((popover) => {
        if (!popover.contains(target)) popover.open = false;
      });
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openPopovers = [...document.querySelectorAll<HTMLDetailsElement>("details[open]")];
      openPopovers.forEach((popover) => { popover.open = false; });
      openPopovers.at(-1)?.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closePopovers);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closePopovers);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
}
