import { translate, type Language } from "./i18n";

export type AppPage = "home" | "workspace" | "data" | "model";

// Four pages do not justify a router dependency; the History API keeps the page across reloads
// and supports back/forward.
const PAGE_PATHS: Record<AppPage, string> = {
  home: "/",
  workspace: "/map",
  data: "/data",
  model: "/model",
};

type PageLabel = {
  /** Page name for the screen-reader heading. */
  title: [russian: string, english: string];
  /** Uppercase caption under the brand name in the footer. */
  caption: [russian: string, english: string];
};

const PAGE_LABELS: Record<AppPage, PageLabel> = {
  home: {
    title: ["Главная", "Home"],
    caption: ["ОБЗОР РАБОЧЕГО ПРОСТРАНСТВА", "WORKSPACE OVERVIEW"],
  },
  workspace: {
    title: ["Карта", "Map"],
    caption: ["КАРТА · АССИСТЕНТ, СОБЫТИЯ, МЕСТА", "MAP · ASSISTANT, EVENTS, PLACES"],
  },
  data: {
    title: ["Данные", "Data"],
    caption: ["ИМПОРТИРОВАННЫЕ ДАННЫЕ", "IMPORTED DATA"],
  },
  model: {
    title: ["Модель ИИ", "AI model"],
    caption: ["ЛОКАЛЬНЫЙ ПОМОЩНИК", "LOCAL ASSISTANT"],
  },
};

/** The former event explorer is now the map page's events mode. */
const LEGACY_PATHS: Record<string, AppPage> = { "/investigation": "workspace" };

export function pageFromPath(pathname: string): AppPage {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (LEGACY_PATHS[normalized]) return LEGACY_PATHS[normalized];
  const entries = Object.entries(PAGE_PATHS) as Array<[AppPage, string]>;
  const match = entries.find(([, path]) => path === normalized);
  return match?.[0] ?? "home";
}

/** The query a page last had (for example the data page's selected dataset), restored when the rail opens it again. */
const pageSearch: Partial<Record<AppPage, string>> = {};

export function rememberPageSearch(page: AppPage, search: string): void {
  pageSearch[page] = search;
}

export function pathForPage(page: AppPage): string {
  return `${PAGE_PATHS[page]}${pageSearch[page] ?? ""}`;
}

export function pageTitle(page: AppPage, language: Language): string {
  return translate(language, ...PAGE_LABELS[page].title);
}

export function pageCaption(page: AppPage, language: Language): string {
  return translate(language, ...PAGE_LABELS[page].caption);
}

/** Opens a page from outside the app shell (for example from the import dialog); the shell follows popstate. */
export function navigateTo(page: AppPage): void {
  const path = pathForPage(page);
  if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState({ page }, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: { page } }));
}
