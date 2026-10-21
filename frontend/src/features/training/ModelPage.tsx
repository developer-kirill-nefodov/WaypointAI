import type { EvalRun } from "@waypoint-ai/shared";
import { ArrowRight, ClipboardCheck, Cpu, FlaskConical, NotebookPen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useCachedQuery } from "../../shared/data-cache";
import { makeT, type Language } from "../../shared/i18n";
import { rememberPageSearch } from "../../shared/routing";
import { pick } from "../investigation/format";
import FinetuneTab from "./FinetuneTab";
import { finetuneApi, type FinetuneState } from "./finetune-api";
import JournalTab from "./JournalTab";
import { journalApi, type JournalStats } from "./journal-api";
import OverviewTab from "./OverviewTab";
import QualityTab, { latestPerModel, percent, refreshTraining, type ExamPreset } from "./QualityTab";
import { trainingApi, type TrainingStatus } from "./training-api";

type Tab = "overview" | "quality" | "data" | "finetune";

/** Tabs of the former training page, so its links keep working. */
const LEGACY_TABS: Record<string, Tab> = { model: "overview", exam: "quality", cases: "quality", lessons: "quality", journal: "data", finetune: "finetune" };

/**
 * The model and everything that improves it on one page: what is installed and how a turn uses it, the benchmark,
 * the journal of real turns, and router fine-tuning. The tabs are the only navigation: they stick to the top, keep
 * their content (and scroll position) while another tab is shown, and the header above them never changes height.
 * The improvement cycle is part of the overview.
 */
export default function ModelPage({ language, ready }: { language: Language; ready: boolean }) {
  const t = makeT(language);
  const [tab, setTab] = useState<Tab>(readTab);
  // Tabs opened once stay mounted (hidden), so what was expanded, filtered, or typed is still there on return.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set([readTab()]));
  // Where each tab was scrolled to; a tab opened for the first time starts at the tab bar.
  const scrollPositions = useRef<Partial<Record<Tab, number>>>({});
  const tabsRef = useRef<HTMLElement>(null);
  // "Compare on the benchmark" from fine-tuning opens the benchmark in router mode with that model.
  const [examPreset, setExamPreset] = useState<ExamPreset | null>(null);
  const status = useCachedQuery("training:status", () => trainingApi.status(), 10_000);
  const lessons = useCachedQuery("training:lessons", () => trainingApi.lessons());
  const cases = useCachedQuery("training:cases", () => trainingApi.cases());
  const runs = useCachedQuery("training:runs", () => trainingApi.runs(), 5_000);
  const finetune = useCachedQuery("training:finetune", () => finetuneApi.state(), 30_000);
  const journal = useCachedQuery("training:journal:stats", () => journalApi.list("candidates", 1, 0), 30_000);
  const activeRunId = runs.data?.activeRunId ?? null;
  const editEnabled = status.data?.editEnabled ?? false;

  useEffect(() => {
    // The page used to live at /training; keep the address in step with the page shown.
    if (window.location.pathname.replace(/\/+$/, "") === "/training") window.history.replaceState({ page: "model" }, "", `/model?tab=${tab}`);
  }, [tab]);
  // A running benchmark is polled; everything else refreshes on change.
  useEffect(() => {
    if (!activeRunId) return;
    const timer = window.setInterval(() => refreshTraining("runs"), 2_500);
    return () => window.clearInterval(timer);
  }, [activeRunId]);

  const selectTab = (next: Tab) => {
    if (next === tab) return;
    scrollPositions.current[tab] = window.scrollY;
    setVisited((current) => (current.has(next) ? current : new Set([...current, next])));
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    // The rail opens the page on the tab last used.
    rememberPageSearch("model", `?tab=${next}`);
  };
  useLayoutEffect(() => {
    const saved = scrollPositions.current[tab];
    const section = tabsRef.current;
    if (saved !== undefined) window.scrollTo({ top: saved });
    else if (section) {
      const top = section.getBoundingClientRect().top + window.scrollY - 12;
      if (window.scrollY > top) window.scrollTo({ top });
    }
  }, [tab]);
  const tabs: Array<[Tab, string, ReactNode]> = [
    ["overview", t("Обзор", "Overview"), <Cpu size={13} key="o" />],
    ["quality", t("Качество", "Quality"), <ClipboardCheck size={13} key="q" />],
    ["data", t("Журнал и данные", "Journal and data"), <NotebookPen size={13} key="d" />],
    ["finetune", t("Дообучение", "Fine-tuning"), <FlaskConical size={13} key="f" />],
  ];

  return <div className="data-page training-page model-page">
    <header className="data-header">
      <div className="data-title">
        <span className="eyebrow">{t("ЛОКАЛЬНАЯ МОДЕЛЬ · КАЧЕСТВО · ДООБУЧЕНИЕ", "LOCAL MODEL · QUALITY · FINE-TUNING")}</span>
        <h2>{t("Модель и её обучение", "The model and its training")}</h2>
      </div>
    </header>
    {status.data && !editEnabled && <p className="data-note">{t("Редактирование выключено: задайте TRAINING_ENABLED=true в .env (по умолчанию включено только в development; аутентификации нет).", "Editing is off: set TRAINING_ENABLED=true in .env (on by default only in development; there is no authentication).")}</p>}

    <section className="data-detail model-tabs" ref={tabsRef}>
      <div className="data-tabs" role="tablist">
        {tabs.map(([id, label, icon]) => <button key={id} id={`model-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`model-panel-${id}`} className={tab === id ? "active" : ""} onClick={() => selectTab(id)}>{icon}{label}</button>)}
      </div>
      {visited.has("overview") && <div className="data-tab-body" role="tabpanel" id="model-panel-overview" aria-labelledby="model-tab-overview" hidden={tab !== "overview"}>
        <ImprovementCycle language={language} status={status.data ?? null} runs={runs.data?.runs ?? null} finetune={finetune.data ?? null} journal={journal.data?.stats ?? null} onOpen={selectTab} tabLabels={Object.fromEntries(tabs.map(([id, label]) => [id, label])) as Record<Tab, string>} />
        <OverviewTab language={language} status={status.data ?? null} runs={runs.data?.runs ?? null} lessons={lessons.data ?? null} ready={ready} onOpen={selectTab} />
      </div>}
      {visited.has("quality") && <div className="data-tab-body" role="tabpanel" id="model-panel-quality" aria-labelledby="model-tab-quality" hidden={tab !== "quality"}>
        <QualityTab language={language} status={status.data ?? null} runs={runs.data?.runs ?? null} activeRunId={activeRunId} cases={cases.data ?? null} lessons={lessons.data ?? null} editEnabled={editEnabled} preset={examPreset} />
      </div>}
      {visited.has("data") && <div className="data-tab-body" role="tabpanel" id="model-panel-data" aria-labelledby="model-tab-data" hidden={tab !== "data"}>
        <JournalTab language={language} editEnabled={editEnabled} />
      </div>}
      {visited.has("finetune") && <div className="data-tab-body" role="tabpanel" id="model-panel-finetune" aria-labelledby="model-tab-finetune" hidden={tab !== "finetune"}>
        <FinetuneTab language={language} editEnabled={editEnabled} onCompare={(model) => { setExamPreset({ mode: "router", model, revision: Date.now() }); scrollPositions.current.quality = undefined; selectTab("quality"); }} />
      </div>}
    </section>
  </div>;
}

function readTab(): Tab {
  const value = new URLSearchParams(window.location.search).get("tab") ?? "";
  if (value === "overview" || value === "quality" || value === "data" || value === "finetune") return value;
  return LEGACY_TABS[value] ?? "overview";
}

type Step = { key: string; title: string; value: string; hint: string; state: "done" | "next" | "idle"; tab: Tab; code?: string };

/**
 * Journal → dataset → training → benchmark → in use: where the loop stands and what to do next. The router is
 * recommended only when its latest router-mode run is at least as good as the main model's. It is a status card, not
 * navigation: only the next step has a button, which opens the tab where that step is done.
 */
function ImprovementCycle({ language, status, runs, finetune, journal, onOpen, tabLabels }: { language: Language; status: TrainingStatus | null; runs: EvalRun[] | null; finetune: FinetuneState | null; journal: JournalStats | null; onOpen(tab: Tab): void; tabLabels: Record<Tab, string> }) {
  const t = makeT(language);
  const lastTrained = finetune?.runs.find((run) => run.status === "succeeded") ?? null;
  const training = finetune?.runs.find((run) => run.status === "running") ?? null;
  const latest = latestPerModel(runs ?? []).filter((run) => run.mode === "router");
  const score = (run: EvalRun | undefined) => (run ? run.metrics!.overall.passed / Math.max(1, run.metrics!.overall.total) : null);
  const candidate = lastTrained?.publishedAs ? latest.find((run) => run.model === lastTrained.publishedAs) : undefined;
  const main = latest.find((run) => run.model === status?.model);
  const candidateScore = score(candidate);
  const mainScore = score(main);
  const recommend = candidate && candidateScore !== null && mainScore !== null && candidateScore >= mainScore && status?.routerModel !== candidate.model;
  const steps: Step[] = [
    {
      key: "journal", tab: "data", title: t("Журнал", "Journal"),
      value: journal ? pick(language, { ru: `${journal.candidates} ждут разбора`, en: `${journal.candidates} to review`, de: `${journal.candidates} zu prüfen` }) : "…",
      hint: t("подтверждённые ходы идут в датасет и бенчмарк", "confirmed turns go to the dataset and benchmark"),
      state: journal && journal.candidates > 0 ? "next" : "done",
    },
    {
      key: "dataset", tab: "finetune", title: t("Датасет", "Dataset"),
      value: finetune?.dataset ? pick(language, { ru: `${finetune.dataset.total} примеров`, en: `${finetune.dataset.total} examples`, de: `${finetune.dataset.total} Beispiele` }) : t("не собран", "not built"),
      hint: finetune?.dataset ? t("без вопросов бенчмарка", "benchmark questions left out") : t("соберите на вкладке «Дообучение»", "build it on the Fine-tuning tab"),
      state: finetune?.dataset ? "done" : "next",
    },
    {
      key: "train", tab: "finetune", title: t("Обучение", "Training"),
      value: training ? `${training.step}/${training.totalSteps ?? "…"}` : lastTrained ? lastTrained.baseModel.replace(/^.*\//, "") : t("не было", "none yet"),
      hint: training ? t("идёт обучение LoRA", "LoRA training is running") : lastTrained ? (lastTrained.publishedAs ?? t("не опубликована в Ollama", "not published to Ollama")) : t("LoRA для маршрутизатора", "LoRA for the router"),
      state: training ? "next" : lastTrained?.publishedAs ? "done" : finetune?.dataset ? "next" : "idle",
    },
    {
      key: "check", tab: "quality", title: t("Проверка", "Benchmark"),
      value: candidateScore !== null ? `${percent(candidateScore)}${mainScore !== null ? ` / ${percent(mainScore)}` : ""}` : "—",
      hint: candidateScore !== null ? t("обученная / основная, режим маршрутизатора", "trained / main, router mode") : lastTrained?.publishedAs ? t("запустите бенчмарк обученной модели", "run the benchmark on the trained model") : t("после обучения", "after training"),
      state: candidateScore !== null ? "done" : lastTrained?.publishedAs ? "next" : "idle",
    },
    {
      key: "use", tab: "quality", title: t("Включение", "In use"),
      value: status?.routerModel ?? t("основная модель", "main model"),
      hint: recommend ? t("не хуже основной — можно включить в .env:", "not worse than the main model — enable it in .env:") : status?.routerModel ? t("маршрутизатор включён", "the router is on") : candidate ? t("пока хуже основной — включать рано", "still worse than the main model — not yet") : t("инструмент выбирает основная модель", "the main model chooses the tool"),
      state: status?.routerModel ? "done" : recommend ? "next" : "idle",
      ...(recommend ? { code: `ROUTER_MODEL=${candidate!.model}` } : {}),
    },
  ];
  // Until the state has loaded, show placeholders rather than "not built" or "none".
  const loaded = Boolean(status && runs && finetune);
  const next = loaded ? steps.find((step) => step.state === "next") ?? null : null;
  return <section className="model-cycle-card" aria-labelledby="model-cycle-title">
    <h3 className="data-section-title" id="model-cycle-title">{t("Цикл улучшения", "Improvement cycle")}</h3>
    <ol className="model-cycle">
      {steps.map((step, index) => <li key={step.key} className={loaded || step.key === "journal" ? step.state : "idle"} aria-current={step === next ? "step" : undefined}>
        <span className="model-cycle-index">{index + 1}</span>
        <span className="model-cycle-copy"><small>{step.title}</small><strong>{loaded || step.key === "journal" ? step.value : "…"}</strong><span>{loaded || step.key === "journal" ? step.hint : ""}</span></span>
        {loaded && step.code && <code className="model-cycle-code">{step.code}</code>}
        {step === next && step.tab !== "overview" && <button type="button" className="data-text-button model-cycle-action" onClick={() => onOpen(step.tab)}>{tabLabels[step.tab]}<ArrowRight size={12} /></button>}
      </li>)}
    </ol>
  </section>;
}
