import type { EvalRun, RunMetrics, Share } from "@waypoint-ai/shared";
import { useCallback, useRef, useState } from "react";
import { makeT, type Language } from "../../shared/i18n";
import { formatEventTime } from "../investigation/format";
import { percent, skillLabel } from "./training-format";

/** Share of passed questions of every complete run of one mode over time, with its 95% interval. */
export function LearningCurve({ language, runs, selectedId, onSelect }: { language: Language; runs: EvalRun[]; selectedId: string | null; onSelect(id: string): void }) {
  const t = makeT(language);
  // Only complete runs: a cancelled or failed run scored only some of the questions.
  const points = [...runs].filter((run) => run.status === "succeeded" && run.metrics).reverse();
  const [chartRef, width] = useChartWidth();
  if (points.length < 1) return null;
  const height = 150;
  const pad = { left: 34, right: 12, top: 12, bottom: 22 };
  const share = (run: EvalRun) => run.metrics!.overall.passed / Math.max(1, run.metrics!.overall.total);
  const x = (index: number) => pad.left + (points.length === 1 ? (width - pad.left - pad.right) / 2 : (index * (width - pad.left - pad.right)) / (points.length - 1));
  const y = (score: number) => pad.top + (1 - score) * (height - pad.top - pad.bottom);
  const series = (withLessons: boolean) => points.map((run, index) => ({ run, index })).filter(({ run }) => run.withLessons === withLessons);
  const line = (items: ReturnType<typeof series>) => items.map(({ run, index }) => `${x(index)},${y(share(run))}`).join(" ");
  return <figure className="training-curve" ref={chartRef}>
    <figcaption><span className="data-section-title">{t("Кривая качества", "Quality curve")}</span><span className="training-legend"><i className="lessons" />{t("с уроками", "with lessons")}<i />{t("без уроков", "without lessons")}<span>│ {t("полоса — 95% интервал", "bar: 95% interval")}</span></span></figcaption>
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("Доля сданных вопросов по запускам", "Share of passed questions per run")}>
      {[0, 0.5, 1].map((value) => <g key={value}><line x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} className="grid" /><text x={pad.left - 6} y={y(value) + 3} textAnchor="end">{percent(value)}</text></g>)}
      {[false, true].map((withLessons) => <polyline key={String(withLessons)} points={line(series(withLessons))} className={withLessons ? "lessons" : "baseline"} />)}
      {points.map((run, index) => <g key={run.id} className={`point${run.withLessons ? " lessons" : ""}${run.id === selectedId ? " selected" : ""}`} onClick={() => onSelect(run.id)}>
        <line x1={x(index)} x2={x(index)} y1={y(run.metrics!.overall.low)} y2={y(run.metrics!.overall.high)} className="interval" />
        <circle cx={x(index)} cy={y(share(run))} r={run.id === selectedId ? 6 : 4.5} />
        <title>{`${run.label ?? run.model} · ${percent(share(run))} (${percent(run.metrics!.overall.low)}–${percent(run.metrics!.overall.high)}) · ${formatEventTime(run.startedAt, language)}`}</title>
        {(index === points.length - 1 || run.id === selectedId) && <text x={x(index) + 9} y={y(share(run)) + 3}>{percent(share(run))}</text>}
      </g>)}
    </svg>
  </figure>;
}

/** The drawn width of a chart: its SVG is laid out 1:1, so text and lines keep their size on any screen. */
export function useChartWidth(fallback = 640): [(node: Element | null) => void, number] {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    observer.current = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width))); });
    observer.current.observe(node);
  }, []);
  return [ref, width];
}

/** Accuracy per skill and language with intervals, and the change against a compared run of the same mode. */
export function MetricsPanel({ language, metrics, compare }: { language: Language; metrics: RunMetrics; compare?: RunMetrics | null }) {
  const t = makeT(language);
  const row = (name: string, share: Share, before?: Share) => {
    const value = share.total ? share.passed / share.total : 0;
    const delta = before && before.total ? value - before.passed / before.total : null;
    return <li key={name}>
      <span className="training-metric-name">{name}</span>
      <span className="training-metric-bar" title={`${percent(share.low)}–${percent(share.high)}`}>
        <span className="interval" style={{ left: `${share.low * 100}%`, width: `${Math.max(0, share.high - share.low) * 100}%` }} />
        <span className="value" style={{ left: `${value * 100}%` }} />
      </span>
      <span className="training-metric-value">{percent(value)} <small>{share.passed}/{share.total}</small></span>
      <span className={`training-metric-delta${delta === null ? "" : delta > 0.005 ? " up" : delta < -0.005 ? " down" : ""}`}>{delta === null ? "" : `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(Math.round(delta * 100))}`}</span>
    </li>;
  };
  return <div className="training-metrics">
    <ul>
      {row(t("Выбор инструмента", "Tool choice"), metrics.tool, compare?.tool)}
      {row(t("Аргументы", "Arguments"), metrics.args, compare?.args)}
    </ul>
    <ul>{Object.entries(metrics.bySkill).map(([skill, share]) => row(skillLabel(skill, t), share, compare?.bySkill[skill]))}</ul>
    <ul>{Object.entries(metrics.byLanguage).map(([code, share]) => row(code.toUpperCase(), share, compare?.byLanguage[code]))}</ul>
  </div>;
}
