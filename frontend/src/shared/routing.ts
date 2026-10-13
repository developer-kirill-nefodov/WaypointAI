import { translate, type Language } from "./i18n";

export type AppPage = "home" | "workspace" | "investigation" | "model";

// Four pages do not justify a router dependency; the History API keeps the page across reloads
// and supports back/forward.
const PAGE_PATHS: Record<AppPage, string> = {
  home: "/",
  workspace: "/map",
  investigation: "/investigation",
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
    title: ["Карта и чат", "Map and chat"],
    caption: ["КАРТА И ЧАТ", "MAP AND CHAT"],
  },
  investigation: {
    title: ["Обзор событий", "Event explorer"],
    caption: ["ОБЗОР СОБЫТИЙ", "EVENT EXPLORER"],
  },
  model: {
    title: ["Модель ИИ", "AI model"],
    caption: ["ЛОКАЛЬНЫЙ ПОМОЩНИК", "LOCAL ASSISTANT"],
  },
};

export function pageFromPath(pathname: string): AppPage {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const entries = Object.entries(PAGE_PATHS) as Array<[AppPage, string]>;
  const match = entries.find(([, path]) => path === normalized);
  return match?.[0] ?? "home";
}

export function pathForPage(page: AppPage): string {
  return PAGE_PATHS[page];
}

export function pageTitle(page: AppPage, language: Language): string {
  return translate(language, ...PAGE_LABELS[page].title);
}

export function pageCaption(page: AppPage, language: Language): string {
  return translate(language, ...PAGE_LABELS[page].caption);
}
