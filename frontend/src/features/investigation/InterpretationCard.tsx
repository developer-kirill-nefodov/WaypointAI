import { Bot, ListChecks, X } from "lucide-react";
import { makeT, type Language } from "../../shared/i18n";
import { formatKm, formatSeconds, pick } from "./format";
import type { QueryResultInfo } from "./types";
import Warning from "./Warning";

/** Why the rule parser was used instead of the model, as [Russian, English]. */
const FALLBACK_LABELS: Record<string, [string, string]> = {
  model_busy: ["модель занята другим запросом", "the model is busy with another request"],
  model_unavailable: ["модель недоступна", "the model is unavailable"],
  model_timeout: ["модель не ответила вовремя", "the model timed out"],
  model_no_tool_call: ["модель не вызвала инструмент", "the model did not call the tool"],
  model_rejected_tool: ["модель запросила неразрешённый инструмент", "the model requested a non-allowlisted tool"],
  model_invalid_arguments: ["модель вернула недопустимые аргументы", "the model returned invalid arguments"],
  model_error: ["модель вернула непредвиденную ошибку", "the model returned an unexpected error"],
};

type InterpretationCardProps = {
  language: Language;
  info: QueryResultInfo;
  onClear: () => void;
};

export default function InterpretationCard({ language, info, onClear }: InterpretationCardProps) {
  const t = makeT(language);
  const { interpretation, resolvedPlace } = info;
  const byModel = interpretation.interpretedBy === "model";
  const fallback = interpretation.fallbackReason ? FALLBACK_LABELS[interpretation.fallbackReason] : null;
  const interpreterLabel = byModel
    ? t("Интерпретировано локальной моделью", "Interpreted by the local model")
    : t("Интерпретировано правилами", "Interpreted by rules");

  return (
    <section className="investigation-interpretation" aria-label={t("Интерпретация запроса", "Query interpretation")}>
      <div className="investigation-interpretation-heading">
        <span className={`investigation-interpreter ${interpretation.interpretedBy}`}>
          {byModel ? <Bot size={12} /> : <ListChecks size={12} />}
          {interpreterLabel}
          <span className="investigation-duration">· {formatSeconds(info.durationMs, language)}</span>
        </span>
        <button type="button" aria-label={t("Сбросить запрос", "Clear query")} onClick={onClear}>
          <X size={13} />
        </button>
      </div>
      <q>{info.text}</q>
      {fallback && <small>{t("Причина", "Reason")}: {t(...fallback)}</small>}
      {interpretation.ignoredPlace && <small>{ignoredPlaceNote(interpretation.ignoredPlace, language)}</small>}
      {resolvedPlace?.match === "approximate" && <small>{approximatePlaceNote(resolvedPlace.name, language)}</small>}
      <div className="investigation-interpretation-chips">
        <code>{interpretation.tool}</code>
        {interpretationChips(info, language).map((chip) => <span key={chip}>{chip}</span>)}
      </div>
      {interpretation.rejectedTools?.length ? (
        <Warning>
          {t(
            "Модель запросила неразрешённые инструменты; они не выполнялись:",
            "The model requested non-allowlisted tools; they were not executed:",
          )}
          {" "}
          {interpretation.rejectedTools.join(", ")}
        </Warning>
      ) : null}
    </section>
  );
}

/** Chips describe the filters the server applied; "default" marks values the request did not mention. */
function interpretationChips(info: QueryResultInfo, language: Language): string[] {
  const t = makeT(language);
  const { interpretation, resolvedPlace, appliedFilters } = info;
  const args = interpretation.arguments;
  const defaultNote = ` (${t("по умолчанию", "default")})`;
  const chips: string[] = [];

  if (args.place) {
    const resolved = resolvedPlace
      ? ` → ${resolvedPlace.match === "approximate" ? "≈ " : ""}${resolvedPlace.name} (${resolvedPlace.category})`
      : "";
    chips.push(`${t("место", "place")}: ${args.place}${resolved}`);
  }
  if (args.nearSelection) chips.push(t("рядом с выбранным событием", "near the selected event"));
  if (appliedFilters.near) {
    const radius = `${t("радиус", "radius")}: ${formatKm(appliedFilters.near.radiusKm, language)}`;
    chips.push(args.radiusKm === undefined ? radius + defaultNote : radius);
  }
  const hours = Math.round((Date.parse(appliedFilters.to) - Date.parse(appliedFilters.from)) / 3_600_000);
  const period = `${t("период", "period")}: ${hours} h`;
  chips.push(args.hours === undefined ? period + defaultNote : period);
  if (appliedFilters.minMagnitude !== undefined) chips.push(`M ≥ ${appliedFilters.minMagnitude}`);
  if (appliedFilters.maxMagnitude !== undefined) chips.push(`M ≤ ${appliedFilters.maxMagnitude}`);
  return chips;
}

function ignoredPlaceNote(place: string, language: Language): string {
  return pick(language, {
    ru: `«${place}» — страна или регион, а не населённый пункт: поиск идёт по всему каталогу без радиуса.`,
    en: `"${place}" is a country or region, not a settlement: the whole catalogue is searched without a radius.`,
    de: `„${place}“ ist ein Land oder eine Region, kein Ort: Es wird der gesamte Katalog ohne Radius durchsucht.`,
  });
}

function approximatePlaceNote(name: string, language: Language): string {
  return pick(language, {
    ru: `Точного совпадения нет; использовано похожее название: ${name}.`,
    en: `No exact match; a similar name was used: ${name}.`,
    de: `Kein exakter Treffer; ein ähnlicher Name wurde verwendet: ${name}.`,
  });
}
