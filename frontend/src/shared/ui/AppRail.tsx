import { BrainCircuit, Check, Cpu, Database, House, MapPinned, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { makeT, type Language } from "../i18n";
import type { AppPage } from "../routing";
import Logo from "./Logo";

/**
 * The app's sidebar: the logo, the pages, and at the bottom the status of the model and the connection, the interface
 * language, and the user. Every item sits in the same 40×40 slot on one axis; the rail stays on screen while a page
 * scrolls. Status and language open a small panel beside the rail.
 */
export interface AppRailProps {
  language: Language;
  activePage: AppPage;
  onNavigate(page: AppPage): void;
  onLanguage(language: Language): void;
  demo: boolean;
  modelLabel: string;
  /** The model answers and the connection is open. */
  healthy: boolean;
  statusText: string;
  connectionText: string;
  /** The connection dropped and waits to retry; "Connect now" is offered. */
  reconnecting: boolean;
  onReconnect(): void;
}

const LANGUAGES: Array<[Language, string]> = [["en", "English"], ["ru", "Русский"], ["de", "Deutsch"]];
type Panel = "status" | "language" | null;

export default function AppRail(props: AppRailProps) {
  const { language, activePage, onNavigate } = props;
  const t = makeT(language);
  const [panel, setPanel] = useState<Panel>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // A panel closes on Escape and on a click anywhere else.
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPanel(null); };
    const onPointer = (event: PointerEvent) => { if (!bottom.current?.contains(event.target as Node)) setPanel(null); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", onPointer); };
  }, [panel]);
  const toggle = (next: Exclude<Panel, null>) => setPanel((current) => (current === next ? null : next));

  const pages: Array<[AppPage, string, ReactNode]> = [
    ["home", t("Главная", "Home"), <House size={18} strokeWidth={1.8} />],
    ["workspace", t("Карта: ассистент, события, места", "Map: assistant, events, places"), <MapPinned size={18} strokeWidth={1.8} />],
    ["data", t("Данные", "Data"), <Database size={18} strokeWidth={1.8} />],
    ["model", t("Модель ИИ и обучение", "AI model and training"), <BrainCircuit size={18} strokeWidth={1.8} />],
  ];

  return <aside className="rail" aria-label={t("Навигация", "Navigation")}>
    <div className="rail-slot" data-tip={t("На главную", "Go to home")}>
      <button type="button" className="rail-brand" aria-label={t("На главную", "Go to home")} onClick={() => onNavigate("home")}><Logo size={34} title="" /></button>
    </div>
    <nav className="rail-nav">
      {pages.map(([page, label, icon]) => <div key={page} className="rail-slot" data-tip={label}>
        <button type="button" className={`rail-button${activePage === page ? " active" : ""}`} aria-label={label} aria-current={activePage === page ? "page" : undefined} onClick={() => onNavigate(page)}>{icon}</button>
      </div>)}
    </nav>
    <div className="rail-bottom" ref={bottom}>
      <div className={`rail-slot${panel === "status" ? " open" : ""}`} data-tip={`${props.modelLabel} · ${props.statusText}`}>
        <button type="button" className={`rail-button rail-status-button${props.healthy ? " ok" : ""}`} aria-label={`${props.modelLabel}: ${props.statusText}. ${props.connectionText}`} aria-expanded={panel === "status"} aria-haspopup="dialog" onClick={() => toggle("status")}>
          <Cpu size={17} strokeWidth={1.8} />
          <i className="rail-dot" aria-hidden />
          {props.demo && <span className="rail-demo" aria-hidden>DEMO</span>}
        </button>
        {panel === "status" && <div className="rail-panel" role="dialog" aria-label={t("Состояние", "Status")}>
          <span className="rail-panel-title">{t("Состояние", "Status")}</span>
          <dl className="rail-facts">
            <div><dt>{t("Модель", "Model")}</dt><dd><code>{props.modelLabel}</code></dd></div>
            <div><dt>{t("Статус", "Status")}</dt><dd className={props.healthy ? "ok" : "warn"}><i className="rail-dot" aria-hidden />{props.statusText}</dd></div>
            <div><dt>{t("Сервер", "Server")}</dt><dd>{props.connectionText}</dd></div>
            {props.demo && <div><dt>{t("Режим", "Mode")}</dt><dd>{t("Демо: только синтетические данные", "Demo: synthetic data only")}</dd></div>}
          </dl>
          {props.reconnecting && <button type="button" className="data-text-button" onClick={props.onReconnect}><RefreshCw size={12} />{t("Подключиться сейчас", "Connect now")}</button>}
        </div>}
      </div>
      <div className={`rail-slot${panel === "language" ? " open" : ""}`} data-tip={t("Язык интерфейса", "Interface language")}>
        <button type="button" className="rail-button rail-language-button" aria-label={`${t("Язык интерфейса", "Interface language")}: ${LANGUAGES.find(([code]) => code === language)?.[1]}`} aria-expanded={panel === "language"} aria-haspopup="menu" onClick={() => toggle("language")}>{language.toUpperCase()}</button>
        {panel === "language" && <div className="rail-panel" role="menu" aria-label={t("Язык интерфейса", "Interface language")}>
          <span className="rail-panel-title">{t("Язык интерфейса", "Interface language")}</span>
          {LANGUAGES.map(([code, name]) => <button key={code} type="button" role="menuitemradio" lang={code} aria-checked={language === code} className="rail-option" onClick={() => { props.onLanguage(code); setPanel(null); }}>
            <span className="rail-option-code">{code.toUpperCase()}</span>{name}{language === code && <Check size={13} />}
          </button>)}
        </div>}
      </div>
      <div className="rail-slot" data-tip={t("Профиль", "Profile")}>
        <span className="rail-avatar" aria-label={t("Профиль", "Profile")} role="img">U</span>
      </div>
    </div>
  </aside>;
}
