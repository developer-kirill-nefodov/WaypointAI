import { useCallback, useEffect, useState } from "react";
import { pageFromPath, pathForPage, rememberPageSearch, type AppPage } from "../../shared/routing";

export type MapMode = "assistant" | "events" | "places";

const currentPath = () => window.location.pathname.replace(/\/+$/, "");

/** The map page's mode from the address: `/map?mode=events`; the former `/investigation` page opens the events mode. */
function readMapMode(): MapMode {
  if (currentPath() === "/investigation") return "events";
  if (currentPath() !== "/map") return "assistant";
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "events" || mode === "places" ? mode : "assistant";
}

const withItem = <T,>(set: Set<T>, item: T) => (set.has(item) ? set : new Set([...set, item]));

/**
 * The open page and the map page's mode, kept in the address and the browser history. Pages and modes stay mounted
 * after their first visit (`visitedPages`, `visitedModes`), so Leaflet, filters, and results are not rebuilt on every
 * switch.
 */
export function useAppNavigation() {
  const [activePage, setActivePageState] = useState<AppPage>(() => pageFromPath(window.location.pathname));
  const [visitedPages, setVisitedPages] = useState<Set<AppPage>>(() => new Set([activePage]));
  const [mapMode, setMapModeState] = useState<MapMode>(readMapMode);
  const [visitedModes, setVisitedModes] = useState<Set<MapMode>>(() => new Set([readMapMode()]));

  const showPage = useCallback((page: AppPage) => {
    setActivePageState(page);
    setVisitedPages((current) => withItem(current, page));
  }, []);
  const showMode = useCallback((mode: MapMode) => {
    setMapModeState(mode);
    setVisitedModes((current) => withItem(current, mode));
  }, []);
  const setActivePage = useCallback((page: AppPage) => {
    const path = pathForPage(page);
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState({ page }, "", path);
    showPage(page);
  }, [showPage]);
  const setMapMode = useCallback((mode: MapMode) => {
    showMode(mode);
    const search = mode === "assistant" ? "" : `?mode=${mode}`;
    rememberPageSearch("workspace", search);
    if (window.location.pathname === "/map" && window.location.search !== search) window.history.pushState({ page: "workspace" }, "", `/map${search}`);
  }, [showMode]);

  useEffect(() => {
    // The former event explorer address becomes the map's events mode.
    const mode = readMapMode();
    if (mode !== "assistant") rememberPageSearch("workspace", `?mode=${mode}`);
    if (currentPath() === "/investigation") window.history.replaceState({ page: "workspace" }, "", "/map?mode=events");
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const page = pageFromPath(window.location.pathname);
      showPage(page);
      if (page === "workspace") showMode(readMapMode());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [showPage, showMode]);

  return { activePage, visitedPages, setActivePage, mapMode, visitedModes, setMapMode };
}
