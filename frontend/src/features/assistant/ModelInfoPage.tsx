import { BrainCircuit, Check, Database, Globe2, Lightbulb, MapPinned, Radar, Route, Search, ShieldCheck, Sparkles } from "lucide-react";
import type { Language } from "../../shared/i18n";
import { translate } from "../../shared/i18n";

type ModelInfoPageProps = {
  language: Language;
  modelLabel: string | null;
  ready: boolean;
};

export default function ModelInfoPage({ language, modelLabel, ready }: ModelInfoPageProps) {
  const t = (ru: string, en: string) => translate(language, ru, en);
  const model = modelLabel ?? "qwen3:4b-instruct-2507-q4_K_M";
  const toolCards = [
    { icon: Search, name: "search_records", description: t("Ищет записи по словам, категории и периоду, включая импортированные землетрясения INGV.", "Searches records by keyword, category, and date range, including imported INGV earthquake events.") },
    { icon: Database, name: "get_record_details", description: t("Показывает подробности одной записи по точному идентификатору.", "Loads the details of one record by its exact ID.") },
    { icon: MapPinned, name: "search_places", description: t("Ищет реальные места из снимков OpenStreetMap по названию, категории, стране или городу.", "Finds real places in OpenStreetMap snapshots by name, category, country, or city.") },
    { icon: Globe2, name: "list_sources", description: t("Возвращает доступные источники, их охват, даты и сведения об атрибуции.", "Lists available sources, their coverage, snapshot dates, and attribution.") },
    { icon: Radar, name: "search_events", description: t("Ищет землетрясения по городу или выбранной точке, радиусу, периоду и магнитуде; центр находит сервер, на карте рисуется круг.", "Finds earthquakes by settlement or selected point, radius, period, and magnitude; the server resolves the center and the map draws the circle.") },
    { icon: Route, name: "plan_trip", description: t("Составляет план поездки по городам и дням. Модель называет города и число дней, сервер находит их в базе и подбирает точки.", "Creates a trip plan by city and day. The model names the cities and days; the server resolves them and picks every stop.") },
    { icon: Route, name: "edit_trip_plan", description: t("Меняет текущий план поездки: добавляет, убирает и переносит точки и дни. Новые точки выбирает сервер из локальной базы.", "Edits the current trip plan: adds, removes, and moves stops and days. The server picks every new stop from the local database.") },
  ];
  const suggestions = language === "ru" ? [
    "Найди музеи в Берлине и покажи их на карте.",
    "Составь маршрут на один день по Варшаве, пешком.",
    "Какие данные доступны по Румынии и за какой период?",
    "Покажи подробности выбранной точки на карте.",
  ] : language === "de" ? [
    "Finde Museen in Berlin und zeige sie auf der Karte.",
    "Plane eine eintägige Route durch Warschau zu Fuß.",
    "Welche Daten sind für Rumänien verfügbar und welchen Zeitraum decken sie ab?",
    "Zeige Details zum ausgewählten Kartenpunkt.",
  ] : [
    "Find museums in Berlin and show them on the map.",
    "Plan a one-day walking route in Warsaw.",
    "What data is available for Romania, and what period does it cover?",
    "Explain the selected point on the map.",
  ];

  return (
    <div className="model-info-page" aria-label={t("Информация об ИИ-модели", "AI model information")}>
      <section className="model-hero">
        <div className="model-hero-copy">
          <span className="eyebrow">{t("ЛОКАЛЬНЫЙ ПОМОЩНИК", "LOCAL ASSISTANT")}</span>
          <h2>{t("Модель и её возможности", "Model and capabilities")}</h2>
          <p>{t("Модель понимает запрос, а сервер безопасно выполняет поиск по доступным данным и показывает результат на карте.", "The model interprets your request while the server searches available data safely and displays results on the map.")}</p>
        </div>
        <div className={`model-ready-badge${ready ? " is-ready" : ""}`}><span />{ready ? t("Модель подключена", "Model connected") : t("Модель недоступна", "Model unavailable")}</div>
      </section>

      <section className="model-overview-card" aria-labelledby="model-name">
        <div className="model-overview-icon"><BrainCircuit size={22} /></div>
        <div className="model-overview-main">
          <span className="eyebrow">{t("УСТАНОВЛЕННАЯ МОДЕЛЬ", "INSTALLED MODEL")}</span>
          <h3 id="model-name">{model}</h3>
          <p>{t("Семейство Qwen3 · версия Instruct-2507 · локальный запуск через Ollama", "Qwen3 family · Instruct-2507 release · served locally by Ollama")}</p>
        </div>
        <div className="model-specs">
          <div><strong>4.02B</strong><span>{t("параметров · B = миллиард", "parameters · B = billion")}</span></div>
          <div><strong>Q4_K_M</strong><span>{t("4-битная квантовка", "4-bit quantization")}</span></div>
          <div><strong>~2.5 GB</strong><span>{t("размер файла модели", "model file size")}</span></div>
        </div>
      </section>
      <p className="model-size-note">{t("Объём файла модели не равен полному расходу оперативной памяти: использование памяти зависит от длины контекста и нагрузки.", "Model file size is not the total RAM requirement; memory use also depends on context length and workload.")}</p>

      <div className="model-info-grid">
        <section className="model-info-card model-capabilities-card">
          <div className="model-section-title"><span className="model-section-icon"><Sparkles size={16} /></span><div><h3>{t("Что умеет модель", "What the model can do")}</h3><p>{t("Текстовые запросы на русском и английском", "Text requests in Russian and English")}</p></div></div>
          <ul className="model-check-list">
            {[t("Понимать вопрос и задавать уточнения, если не хватает параметров.", "Understand a request and ask for missing details."), t("Вызывать только разрешённые серверные функции для чтения данных.", "Call only allowlisted server functions to read data."), t("Суммировать найденные результаты и связывать их с точками на карте.", "Summarize search results and connect them to map locations."), t("Соблюдать выбранный язык интерфейса при ответе.", "Answer in the language selected in the interface.")].map((item) => <li key={item}><Check size={15} />{item}</li>)}
          </ul>
        </section>

        <section className="model-info-card model-server-card">
          <div className="model-section-title"><span className="model-section-icon"><Route size={16} /></span><div><h3>{t("Планирование поездок", "Trip planning")}</h3><p>{t("Сценарий приложения с проверкой на сервере", "An application workflow validated by the server")}</p></div></div>
          <p>{t("Сервер ищет места в локальном снимке OpenStreetMap, распределяет их по дням и строит дорожный маршрут через настроенный сервис маршрутизации. Для этого сценария не нужно полагаться на выдуманные моделью названия и координаты.", "The server searches the local OpenStreetMap snapshot, groups places by day, and requests a road route from the configured routing service. This avoids relying on place names and coordinates invented by the model.")}</p>
          <p className="model-routing-note">{t("Расчёт дорожного маршрута использует OSRM. В настройках проекта по умолчанию указан публичный сервис; сам запрос к модели и поиск по снимку данных остаются локальными.", "Road routes use OSRM. The project defaults to a public routing service; model inference and searches against the data snapshot remain local.")}</p>
          <span className="model-coverage-label">{t("Доступные области данных", "Available data regions")}</span>
          <div className="model-coverage-tags"><span>Berlin · DE</span><span>Mazovia · PL</span><span>Romania · RO</span><span>Île-de-France · FR</span><span>Central Italy · IT</span><span>Madrid · ES</span></div>
        </section>

        <section className="model-info-card model-tools-card">
          <div className="model-section-title"><span className="model-section-icon"><Database size={16} /></span><div><h3>{t("Функции сервера, доступные модели", "Server tools available to the model")}</h3><p>{t("Только эти пять функций разрешены для вызова из модели", "Only these five functions are allowlisted for model calls")}</p></div></div>
          <div className="model-tool-list">{toolCards.map(({ icon: Icon, name, description }) => <article className="model-tool" key={name}><span className="model-tool-icon"><Icon size={15} /></span><div><h4>{name}</h4><p>{description}</p></div></article>)}</div>
          <div className="model-guardrail"><ShieldCheck size={16} /><span>{t("Функции чтения ограничены серверным списком. У модели нет прямого доступа к базе, SQL или произвольному поиску в интернете.", "Read operations are restricted to server allowlists. The model has no direct database, SQL, or unrestricted web-search access.")}</span></div>
        </section>

        <section className="model-info-card model-tips-card">
          <div className="model-section-title"><span className="model-section-icon"><Lightbulb size={16} /></span><div><h3>{t("Как получать лучшие результаты", "How to get better results")}</h3><p>{t("Добавьте конкретные детали в запрос", "Include specific details in your request")}</p></div></div>
          <ul className="model-tips-list">{suggestions.map((suggestion) => <li key={suggestion}><span>“{suggestion}”</span></li>)}</ul>
          <p className="model-limit-note">{t("Снимки OpenStreetMap могут быть неполными или устаревшими. Уточняйте город и категорию; модель не проверяет актуальное расписание заведений.", "OpenStreetMap snapshots may be incomplete or outdated. Specify the city and category; the model does not verify current opening hours.")}</p>
        </section>
      </div>
    </div>
  );
}
