import type { EvalRun, Lesson } from "@waypoint-ai/shared";
import { ArrowRight, BrainCircuit, Check, CircleDashed, Database, ExternalLink, Globe2, Lightbulb, MapPinned, MessageSquare, Radar, Route, Search, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language } from "../../shared/i18n";
import { navigateTo } from "../../shared/routing";
import { formatEventTime, pick } from "../investigation/format";
import { finetuneApi } from "./finetune-api";
import { MetricsPanel, percent } from "./QualityTab";
import { trainingApi, type TrainingStatus } from "./training-api";

type Props = {
  language: Language;
  status: TrainingStatus | null;
  runs: EvalRun[] | null;
  lessons: Lesson[] | null;
  ready: boolean;
  onOpen(tab: "quality" | "finetune"): void;
};

/**
 * The model at a glance, from live data: what is installed (Ollama's metadata), how a chat turn uses it, how good the
 * latest benchmark says it is, how it was trained, and what it may do.
 */
export default function OverviewTab({ language, status, runs, lessons, ready, onOpen }: Props) {
  const t = makeT(language);
  const card = useCachedQuery("training:model", () => trainingApi.model(), 10 * 60_000);
  const model = card.data;
  const number = (value: number | null | undefined) => (value === null || value === undefined ? "—" : value.toLocaleString(language));
  // The main model's latest complete run; the router candidates are compared on the Quality tab.
  const complete = runs?.filter((run) => run.status === "succeeded" && run.metrics) ?? [];
  const latest = complete.find((run) => run.model === status?.model) ?? complete[0] ?? null;
  const routerModel = status?.routerModel ?? null;

  return <div className="model-overview">
    <section className="model-passport">
      <div className="model-passport-head">
        <span className="model-overview-icon"><BrainCircuit size={20} /></span>
        <div>
          <span className="eyebrow">{t("ОСНОВНАЯ МОДЕЛЬ", "MAIN MODEL")}</span>
          <h3><code>{model?.name ?? status?.model ?? "…"}</code></h3>
          <p>{[model?.family, model?.version, model?.finetune].filter(Boolean).join(" · ") || t("локальный запуск через Ollama", "served locally by Ollama")}</p>
        </div>
        <span className={`model-ready-badge${ready ? " is-ready" : ""}`}><span />{ready ? t("Модель подключена", "Model connected") : t("Модель недоступна", "Model unavailable")}</span>
      </div>
      {card.error !== undefined && !model ? <p className="data-note">{t("Ollama не отвечает: паспорт появится, когда модель будет запущена.", "Ollama is not responding: the card appears once the model is running.")}</p>
        : !model ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p>
          : <dl className="training-facts">
            <div><dt>{t("Параметры", "Parameters")}</dt><dd>{model.parameterCount ? `${number(model.parameterCount)} (${model.parameterSize ?? "—"})` : model.parameterSize ?? "—"}</dd></div>
            <div><dt>{t("Файл", "File")}</dt><dd>{[model.format?.toUpperCase(), model.quantization].filter(Boolean).join(" · ") || "—"}</dd></div>
            <div><dt>{t("Архитектура", "Architecture")}</dt><dd>{pick(language, { ru: `${number(model.architecture.layers)} слоёв · ${number(model.architecture.attentionHeads)} голов внимания (${number(model.architecture.keyValueHeads)} KV) · эмбеддинг ${number(model.architecture.embeddingLength)}`, en: `${number(model.architecture.layers)} layers · ${number(model.architecture.attentionHeads)} attention heads (${number(model.architecture.keyValueHeads)} KV) · embedding ${number(model.architecture.embeddingLength)}`, de: `${number(model.architecture.layers)} Schichten · ${number(model.architecture.attentionHeads)} Attention-Köpfe (${number(model.architecture.keyValueHeads)} KV) · Embedding ${number(model.architecture.embeddingLength)}` })}</dd></div>
            <div><dt>{t("Контекст", "Context")}</dt><dd>{pick(language, { ru: `до ${number(model.contextLength)} токенов, в приложении ${number(model.settings.contextLength)}`, en: `up to ${number(model.contextLength)} tokens, ${number(model.settings.contextLength)} in this app`, de: `bis ${number(model.contextLength)} Token, in der App ${number(model.settings.contextLength)}` })}</dd></div>
            <div><dt>{t("Запуск", "Runtime")}</dt><dd>{pick(language, { ru: `Ollama ${model.runtimeVersion ?? "—"} · температура ${model.settings.temperature} · ответ до ${model.settings.maxAnswerTokens} токенов · держать в памяти ${model.settings.keepAlive}`, en: `Ollama ${model.runtimeVersion ?? "—"} · temperature ${model.settings.temperature} · answers up to ${model.settings.maxAnswerTokens} tokens · kept loaded ${model.settings.keepAlive}`, de: `Ollama ${model.runtimeVersion ?? "—"} · Temperatur ${model.settings.temperature} · Antworten bis ${model.settings.maxAnswerTokens} Token · geladen ${model.settings.keepAlive}` })}</dd></div>
            <div><dt>{t("Маршрутизатор", "Router")}</dt><dd>{routerModel ? <code>{routerModel}</code> : t("не включён: инструмент выбирает основная модель", "off: the main model chooses the tool")}</dd></div>
            <div><dt>{t("Умеет", "Capabilities")}</dt><dd>{model.capabilities.join(", ") || "—"}</dd></div>
            <div><dt>{t("Лицензия", "Licence")}</dt><dd>{model.license ?? "—"}{model.licenseUrl && <> · <a href={model.licenseUrl} target="_blank" rel="noreferrer noopener">{t("текст", "text")} <ExternalLink size={10} /></a></>}</dd></div>
            <div><dt>{t("Установлена", "Installed")}</dt><dd>{model.installedAt ? formatEventTime(model.installedAt, language) : "—"}</dd></div>
          </dl>}
      <p className="model-size-note">{t("Объём файла модели не равен полному расходу памяти: он зависит и от длины контекста.", "The model file size is not the total memory use: context length adds to it.")}</p>
    </section>

    <TurnFlow language={language} mainModel={status?.model ?? null} routerModel={routerModel} />

    <section className="model-quality-card">
      <div className="model-card-head">
        <h3 className="data-section-title">{t("Качество по бенчмарку", "Benchmark quality")}</h3>
        <button type="button" className="training-link" onClick={() => onOpen("quality")}>{t("Сравнение и разбор", "Comparison and breakdown")} <ArrowRight size={11} /></button>
      </div>
      {!runs ? <p className="data-empty">{t("Загружаю…", "Loading…")}</p> : !latest ? <p className="data-empty">{t("Бенчмарк ещё не запускался.", "The benchmark has not run yet.")}</p> : <>
        <div className="model-quality-score">
          <strong>{percent(latest.metrics!.overall.passed / Math.max(1, latest.metrics!.overall.total))}</strong>
          <span>{pick(language, { ru: `${latest.metrics!.overall.passed} из ${latest.metrics!.overall.total} вопросов · 95%: ${percent(latest.metrics!.overall.low)}–${percent(latest.metrics!.overall.high)}`, en: `${latest.metrics!.overall.passed} of ${latest.metrics!.overall.total} questions · 95%: ${percent(latest.metrics!.overall.low)}–${percent(latest.metrics!.overall.high)}`, de: `${latest.metrics!.overall.passed} von ${latest.metrics!.overall.total} Fragen · 95 %: ${percent(latest.metrics!.overall.low)}–${percent(latest.metrics!.overall.high)}` })}<br /><small>{latest.label ?? latest.model} · {formatEventTime(latest.startedAt, language)}</small></span>
        </div>
        <MetricsPanel language={language} metrics={latest.metrics!} />
      </>}
    </section>

    <TrainingPath language={language} model={model ?? null} lessons={lessons} routerModel={routerModel} onOpen={onOpen} />

    <Capabilities language={language} />
  </div>;
}

/** How one chat turn runs, with the step that picks the tool shown for the current configuration. */
function TurnFlow({ language, mainModel, routerModel }: { language: Language; mainModel: string | null; routerModel: string | null }) {
  const t = makeT(language);
  const steps: Array<{ icon: ReactNode; title: string; detail: string; model?: string | null }> = [
    { icon: <MessageSquare size={15} />, title: t("Вопрос", "Question"), detail: t("на русском, английском или немецком", "in Russian, English, or German") },
    routerModel
      ? { icon: <Route size={15} />, title: t("Маршрутизатор", "Router"), detail: t("короткий промпт → JSON {tool, args}, проверка схемой", "a short prompt → JSON {tool, args}, checked by the schema"), model: routerModel }
      : { icon: <Route size={15} />, title: t("Выбор инструмента", "Tool choice"), detail: t("основная модель по полному промпту", "the main model, from the full prompt"), model: mainModel },
    { icon: <Wrench size={15} />, title: t("Сервер", "Server"), detail: t("разрешённый инструмент, параметризованный SQL, локальная база", "an allowlisted tool, parameterized SQL, the local database") },
    { icon: <Sparkles size={15} />, title: t("Ответ", "Answer"), detail: t("по найденным данным, со ссылками [E1] на строки", "from the data found, citing rows as [E1]"), model: mainModel },
  ];
  return <section className="model-flow">
    <h3 className="data-section-title">{t("Как проходит ход", "How a turn runs")}</h3>
    <ol>{steps.map((step) => <li key={step.title}>
      <span className="model-flow-icon">{step.icon}</span>
      <strong>{step.title}</strong>
      {step.model && <code>{step.model}</code>}
      <small>{step.detail}</small>
    </li>)}</ol>
  </section>;
}

function TrainingPath({ language, model, lessons, routerModel, onOpen }: { language: Language; model: Awaited<ReturnType<typeof trainingApi.model>> | null; lessons: Lesson[] | null; routerModel: string | null; onOpen(tab: "finetune"): void }) {
  const t = makeT(language);
  const finetune = useCachedQuery("training:finetune", () => finetuneApi.state(), 30_000);
  const loraRuns = finetune.data?.runs ?? [];
  const trained = loraRuns.filter((run) => run.status === "succeeded");
  const training = loraRuns.find((run) => run.status === "running");
  const developer = model?.family ?? t("разработчик модели", "the model's developer");
  const enabled = lessons?.filter((lesson) => lesson.enabled).length ?? 0;
  const stages: Array<{ title: string; who: ReactNode; state: "done" | "ours" | "todo"; body: ReactNode }> = [
    { title: t("Предобучение", "Pre-training"), who: developer, state: "done", body: <>{t("Базовая модель училась предсказывать текст на большом корпусе. Состав данных и объём описывает разработчик.", "The base model learned to predict text on a large corpus. The developer describes the data and its size.")}{model?.modelUrl && <> <a href={model.modelUrl} target="_blank" rel="noreferrer noopener">{t("Карточка модели", "Model card")} <ExternalLink size={10} /></a></>}</> },
    { title: model?.finetune ? `${t("Донастройка", "Fine-tuning")}: ${model.finetune}${model.version ? ` ${model.version}` : ""}` : t("Донастройка", "Fine-tuning"), who: developer, state: "done", body: t("Донастройка на инструкциях и диалогах: модель отвечает на запросы и вызывает инструменты.", "Tuned on instructions and dialogues: the model answers requests and calls tools.") },
    { title: `${t("Квантизация", "Quantization")}${model?.quantization ? `: ${model.quantization}` : ""}`, who: model?.format ? model.format.toUpperCase() : "GGUF", state: "done", body: t("Веса сжаты примерно до 4 бит, чтобы модель работала на ноутбуке. Качество немного ниже, чем у полной модели.", "Weights are compressed to about 4 bits so the model runs on a laptop, at a small cost in quality.") },
    {
      title: t("Дообучение маршрутизатора (LoRA)", "Router fine-tuning (LoRA)"),
      who: routerModel ? `${t("используется", "in use")}: ${routerModel}` : training ? t("идёт обучение", "training") : trained.length ? pick(language, { ru: `обучено моделей: ${trained.length}, не включено`, en: `${trained.length} trained, not in use`, de: `${trained.length} trainiert, nicht aktiv` }) : t("не проводилось", "not done"),
      state: routerModel ? "ours" : training || trained.length ? "done" : "todo",
      body: <>{t("Маленькая модель учится выбирать инструмент и аргументы по короткому промпту на синтетических вопросах из базы и подтверждённых ходах журнала. Её включают, только если бенчмарк показывает, что она не хуже основной.", "A small model learns to choose the tool and its arguments from a short prompt, on synthetic questions from the database and confirmed journal turns. It is used only if the benchmark shows it is not worse than the main model.")} <button type="button" className="training-link" onClick={() => onOpen("finetune")}>{t("Дообучение", "Fine-tuning")} <ArrowRight size={11} /></button></>,
    },
    { title: t("Уроки в промпте", "Prompt lessons"), who: pick(language, { ru: `включено: ${enabled}`, en: `${enabled} on`, de: `${enabled} aktiv` }), state: enabled ? "done" : "todo", body: t("Правила и примеры добавляются в запрос к основной модели; веса не меняются.", "Rules and examples are added to the main model's request; weights do not change.") },
  ];
  return <section className="model-path">
    <h3 className="data-section-title">{t("Путь обучения", "Training path")}</h3>
    <ol className="training-stages">{stages.map((stage) => <li key={stage.title} className={stage.state}>
      <span className="training-stage-mark">{stage.state === "todo" ? <CircleDashed size={13} /> : <Check size={13} />}</span>
      <div><strong>{stage.title}</strong><small>{stage.who}</small><p>{stage.body}</p></div>
    </li>)}</ol>
  </section>;
}

function Capabilities({ language }: { language: Language }) {
  const t = makeT(language);
  const tools = [
    { icon: Search, name: "search_records", description: t("Ищет записи по словам, категории и периоду, включая импортированные землетрясения.", "Searches records by keyword, category, and date range, including imported earthquakes.") },
    { icon: Database, name: "get_record_details", description: t("Показывает подробности одной записи по точному идентификатору.", "Loads the details of one record by its exact ID.") },
    { icon: MapPinned, name: "search_places", description: t("Ищет места из снимков OpenStreetMap по названию, категории, стране или городу.", "Finds places in OpenStreetMap snapshots by name, category, country, or city.") },
    { icon: Globe2, name: "list_sources", description: t("Возвращает доступные источники, их охват, даты и атрибуцию.", "Lists available sources, their coverage, dates, and attribution.") },
    { icon: Radar, name: "search_events", description: t("Ищет землетрясения INGV и USGS у города или точки, по радиусу, периоду и магнитуде, с перекрёстной проверкой.", "Finds INGV and USGS earthquakes near a town or point by radius, period, and magnitude, cross-checked between catalogues.") },
    { icon: Route, name: "plan_trip", description: t("Составляет план поездки: модель называет города и дни, сервер находит их и подбирает точки.", "Plans a trip: the model names the cities and days; the server resolves them and picks the stops.") },
    { icon: Route, name: "edit_trip_plan", description: t("Меняет текущий план: добавляет, убирает и переносит точки и дни.", "Edits the current plan: adds, removes, and moves stops and days.") },
  ];
  const suggestions = ({
    ru: ["Найди музеи в Кракове и покажи их на карте.", "Составь маршрут на один день по Варшаве, пешком.", "Землетрясения сильнее 3 у Норчи за неделю.", "Какие данные доступны и за какой период?"],
    en: ["Find museums in Kraków and show them on the map.", "Plan a one-day walking route in Warsaw.", "Earthquakes above magnitude 3 near Norcia this week.", "What data is available, and for what period?"],
    de: ["Finde Museen in Kraków und zeige sie auf der Karte.", "Plane eine eintägige Route durch Warschau zu Fuß.", "Erdbeben über Magnitude 3 bei Norcia diese Woche.", "Welche Daten sind verfügbar und für welchen Zeitraum?"],
  } satisfies Record<Language, string[]>)[language];
  return <section className="model-capabilities">
    <details>
      <summary><span className="data-section-title">{t("Инструменты, доступные модели", "Tools available to the model")}</span><small>{tools.length}</small></summary>
      <div className="model-tool-list">{tools.map(({ icon: Icon, name, description }) => <article className="model-tool" key={name}><span className="model-tool-icon"><Icon size={15} /></span><div><h4>{name}</h4><p>{description}</p></div></article>)}</div>
    </details>
    <div className="model-guardrail"><ShieldCheck size={16} /><span>{t("Модель вызывает только инструменты из этого списка; сервер проверяет аргументы схемой. У модели нет доступа к базе, SQL или интернету.", "The model calls only the tools in this list; the server checks their arguments with a schema. The model has no access to the database, SQL, or the internet.")}</span></div>
    <div className="model-tips">
      <span className="data-section-title"><Lightbulb size={13} /> {t("Как спрашивать", "How to ask")}</span>
      <ul className="model-tips-list">{suggestions.map((suggestion) => <li key={suggestion}>“{suggestion}”</li>)}</ul>
      <p className="model-limit-note">{t("Снимки OpenStreetMap бывают неполными; модель не проверяет часы работы. Какие города и каталоги загружены — на странице «Данные».", "OpenStreetMap snapshots can be incomplete; the model does not check opening hours. Which cities and catalogues are loaded is on the Data page.")} <button type="button" className="training-link" onClick={() => navigateTo("data")}>{t("Данные", "Data")} <ArrowRight size={11} /></button></p>
    </div>
  </section>;
}
