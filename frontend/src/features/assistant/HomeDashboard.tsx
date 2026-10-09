import { Activity, ArrowRight, BrainCircuit, CircleHelp, Database, MapPinned, MessageSquareText, Sparkles } from "lucide-react";
import type { SourceView } from "@waypoint-ai/shared";
import type { ConnectionState } from "../../shared/api/client";
import { translate, type Language } from "../../shared/i18n";

type HomeDashboardProps = {
  language: Language;
  modelLabel: string | null;
  modelReady: boolean;
  connection: ConnectionState;
  sources: SourceView[];
  sourcesLoading: boolean;
  sourcesFailed: boolean;
  resultsLoaded: boolean;
  resultCount: number;
  lastQuery: string;
  onOpenWorkspace: () => void;
  onOpenModel: () => void;
  onChoosePrompt: (prompt: string) => void;
};

export default function HomeDashboard({ language, modelLabel, modelReady, connection, sources, sourcesLoading, sourcesFailed, resultsLoaded, resultCount, lastQuery, onOpenWorkspace, onOpenModel, onChoosePrompt }: HomeDashboardProps) {
  const t = (ru: string, en: string) => translate(language, ru, en);
  const publicSources = sources.filter((source) => source.mode === "public_snapshot");
  const readySources = sources.filter((source) => source.status !== "unavailable");
  const prompts = language === "ru" ? [
    { label: "Найти места", prompt: "Найди музеи в Берлине и покажи их на карте", icon: MapPinned },
    { label: "Собрать маршрут", prompt: "Составь маршрут по Берлину на 1 день, на машине, только из локальной базы", icon: Activity },
    { label: "Посмотреть источники", prompt: "Какие источники данных доступны?", icon: Database },
  ] : language === "de" ? [
    { label: "Orte finden", prompt: "Finde Museen in Berlin und zeige sie auf der Karte", icon: MapPinned },
    { label: "Route planen", prompt: "Plane eine eintägige Autofahrt durch Berlin nur mit lokalen Daten", icon: Activity },
    { label: "Datenquellen ansehen", prompt: "Welche Datenquellen sind verfügbar?", icon: Database },
  ] : [
    { label: "Find places", prompt: "Find museums in Berlin and show them on the map", icon: MapPinned },
    { label: "Plan a route", prompt: "Plan a one-day driving route in Berlin using only the local database", icon: Activity },
    { label: "Explore data sources", prompt: "What data sources are available?", icon: Database },
  ];
  const stats = [
    { icon: BrainCircuit, label: t("Модель ИИ", "AI model"), value: modelReady ? t("Подключена", "Connected") : t("Недоступна", "Unavailable"), detail: modelLabel ?? t("Имя модели не получено", "Model name unavailable"), tone: modelReady ? "good" : "warning", onClick: onOpenModel },
    { icon: Database, label: t("Источники данных", "Data sources"), value: sourcesLoading ? "…" : String(sources.length), detail: sourcesLoading ? t("Загружаю источники", "Loading sources") : t("доступно в рабочем пространстве", "available to the workspace"), tone: "neutral", onClick: onOpenWorkspace },
    { icon: MapPinned, label: t("Снимки OpenStreetMap", "OpenStreetMap snapshots"), value: sourcesLoading ? "…" : String(publicSources.length), detail: t("региональные наборы данных", "regional data snapshots"), tone: "neutral", onClick: onOpenWorkspace },
    { icon: Activity, label: t("Результаты последнего поиска", "Latest search results"), value: resultsLoaded ? resultCount.toLocaleString(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US") : "—", detail: resultsLoaded ? t("места", "places") : t("поиск ещё не запускался", "no search run in this session"), tone: "neutral", onClick: onOpenWorkspace },
  ];

  return (
    <div className="dashboard-page">
      <section className="dashboard-welcome">
        <div className="dashboard-welcome-copy"><span className="eyebrow">{t("ОБЗОР РАБОЧЕГО ПРОСТРАНСТВА", "WORKSPACE OVERVIEW")}</span><h2>{t("Добро пожаловать в Waypoint AI", "Welcome to Waypoint AI")}</h2><p>{t("Задавайте вопросы о местах и доступных локальных данных. Помощник ищет по разрешённым источникам, а карта показывает найденные точки.", "Ask about places and available local data. The assistant searches approved sources and plots matching results on the map.")}</p></div>
        <button type="button" className="dashboard-primary-action" onClick={onOpenWorkspace}><MessageSquareText size={16} /><span>{t("Открыть карту и чат", "Open map and chat")}</span><ArrowRight size={15} /></button>
      </section>

      <section className="dashboard-stats" aria-label={t("Статистика рабочего пространства", "Workspace statistics")}>
        {stats.map(({ icon: Icon, label, value, detail, tone, onClick }) => <button type="button" className={`dashboard-stat-card ${tone}`} key={label} onClick={onClick}><span className="dashboard-stat-icon"><Icon size={17} /></span><span className="dashboard-stat-label">{label}</span><strong>{value}</strong><small>{detail}</small></button>)}
      </section>

      <div className="dashboard-content-grid">
        <section className="dashboard-card dashboard-sources-card">
          <div className="dashboard-section-heading"><span className="dashboard-section-icon"><Database size={17} /></span><div><h3>{t("Источники данных", "Data sources")}</h3><p>{t("Состав и готовность подключённых наборов", "Connected datasets and their readiness")}</p></div><span className="dashboard-count">{sourcesLoading ? "…" : readySources.length}/{sources.length}</span></div>
          {sourcesLoading && sources.length === 0 ? <p className="dashboard-empty">{t("Загружаю список источников…", "Loading data sources…")}</p> : sourcesFailed && sources.length === 0 ? <p className="dashboard-empty is-warning">{t("Не удалось получить список источников. Проверьте соединение с сервером.", "Could not load sources. Check the server connection.")}</p> : sources.length ? <div className="dashboard-source-list">{sources.map((source) => <article className="dashboard-source" key={source.id}><span className={`dashboard-source-dot${source.status === "unavailable" ? " is-offline" : ""}`} /><span className="dashboard-source-copy"><strong>{source.label}</strong><small>{source.mode === "public_snapshot" ? t("Снимок OpenStreetMap", "OpenStreetMap snapshot") : source.mode === "synthetic_local" ? t("Синтетические демо-данные", "Synthetic demo data") : source.mode}</small></span><span className={`dashboard-source-status${source.status === "unavailable" ? " is-offline" : ""}`}>{source.status === "unavailable" ? t("Недоступен", "Unavailable") : t("Готов", "Ready")}</span>{source.snapshotDate && <time dateTime={source.snapshotDate}>{source.snapshotDate}</time>}</article>)}</div> : <p className="dashboard-empty">{t("Источники пока не подключены.", "No data sources are connected yet.")}</p>}
          {publicSources.length > 0 && <p className="dashboard-source-footnote">{t("Снимки OSM региональные и могут быть неполными или устаревшими.", "OSM snapshots cover specific regions and may be incomplete or outdated.")}</p>}
        </section>

        <div className="dashboard-side-column">
          <section className="dashboard-card dashboard-activity-card">
            <div className="dashboard-section-heading"><span className="dashboard-section-icon"><Activity size={17} /></span><div><h3>{t("Последняя активность", "Recent activity")}</h3><p>{t("Состояние этого рабочего сеанса", "Current workspace session")}</p></div></div>
            <div className="dashboard-activity-row"><span className={`dashboard-state-dot ${connection}`} /><span>{connection === "connected" ? t("Связь с сервером активна", "Server connection active") : connection === "connecting" ? t("Подключаюсь к серверу", "Connecting to server") : t("Нет связи с сервером", "Server disconnected")}</span></div>
            {lastQuery ? <div className="dashboard-last-query"><small>{t("Последний запрос", "Last request")}</small><p>{lastQuery}</p></div> : <p className="dashboard-empty">{t("Здесь появится ваш последний запрос.", "Your latest request will appear here.")}</p>}
          </section>

          <section className="dashboard-card dashboard-quick-card">
            <div className="dashboard-section-heading"><span className="dashboard-section-icon"><Sparkles size={17} /></span><div><h3>{t("Попробуйте", "Try a prompt")}</h3><p>{t("Примеры заполнят поле ввода в чате", "Examples are placed into the chat composer")}</p></div></div>
            <div className="dashboard-quick-actions">{prompts.map(({ label, prompt, icon: Icon }) => <button type="button" key={label} onClick={() => onChoosePrompt(prompt)}><Icon size={15} /><span>{label}</span><ArrowRight size={14} /></button>)}</div>
            <button type="button" className="dashboard-help-link" onClick={onOpenModel}><CircleHelp size={14} /><span>{t("Что может помощник?", "What can the assistant do?")}</span><ArrowRight size={13} /></button>
          </section>
        </div>
      </div>
    </div>
  );
}
