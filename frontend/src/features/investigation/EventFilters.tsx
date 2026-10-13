import type { SourceView } from "@waypoint-ai/shared";
import { X } from "lucide-react";
import { makeT, type Language } from "../../shared/i18n";
import { pick, sourceDescription } from "./format";
import type { EventFilterState, NearFilter } from "./types";

const PERIODS = [1, 7, 30, 90];
const MAGNITUDES = [1, 2, 3, 4];

type EventFiltersProps = {
  language: Language;
  filters: EventFilterState;
  sources: SourceView[];
  onChange: (filters: EventFilterState) => void;
};

export default function EventFilters({ language, filters, sources, onChange }: EventFiltersProps) {
  const t = makeT(language);
  const periodLabel = (days: number) => days === 1
    ? t("24 часа", "24 hours")
    : pick(language, { ru: `${days} дней`, en: `${days} days`, de: `${days} Tage` });
  const toggleSource = (id: string) => {
    const sourceIds = filters.sourceIds.includes(id)
      ? filters.sourceIds.filter((value) => value !== id)
      : [...filters.sourceIds, id];
    onChange({ ...filters, sourceIds });
  };
  const changeMagnitude = (value: string) => {
    const minMagnitude = value === "" ? null : Number(value);
    onChange({ ...filters, minMagnitude });
  };
  const sourceSelection = filters.sourceIds.length ? t("выбрано", "selected") : t("все", "all");

  return (
    <div className="investigation-filters" role="group" aria-label={t("Фильтры событий", "Event filters")}>
      <div className="investigation-filter-row">
        <label>
          <span>{t("Период", "Period")}</span>
          <select value={filters.days} onChange={(event) => onChange({ ...filters, days: Number(event.target.value) })}>
            {PERIODS.map((days) => <option key={days} value={days}>{periodLabel(days)}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Магнитуда от", "Min magnitude")}</span>
          <select value={filters.minMagnitude ?? ""} onChange={(event) => changeMagnitude(event.target.value)}>
            <option value="">{t("Любая", "Any")}</option>
            {MAGNITUDES.map((value) => <option key={value} value={value}>M{value}+</option>)}
          </select>
        </label>
      </div>
      {sources.length > 0 && (
        <fieldset className="investigation-source-filter">
          <legend>{t("Источники", "Sources")} · {sourceSelection}</legend>
          {sources.map((source) => (
            <label key={source.id} className={source.mode === "synthetic_local" ? "synthetic" : undefined}>
              <input
                type="checkbox"
                checked={filters.sourceIds.includes(source.id)}
                onChange={() => toggleSource(source.id)}
              />
              <span>
                <strong>{source.label}</strong>
                <small>{sourceDescription(source, language)}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {filters.near && (
        <NearChip
          language={language}
          near={filters.near}
          onRemove={() => onChange({ ...filters, near: null })}
        />
      )}
    </div>
  );
}

type NearChipProps = {
  language: Language;
  near: NearFilter;
  onRemove: () => void;
};

function NearChip({ language, near, onRemove }: NearChipProps) {
  const t = makeT(language);
  const prefix = pick(language, {
    ru: `В радиусе ${near.radiusKm} км от`,
    en: `Within ${near.radiusKm} km of`,
    de: `Im Umkreis von ${near.radiusKm} km um`,
  });
  return (
    <div className="investigation-chip">
      <span>{prefix} <strong>{near.label}</strong></span>
      <button type="button" aria-label={t("Убрать фильтр по области", "Remove area filter")} onClick={onRemove}>
        <X size={13} />
      </button>
    </div>
  );
}
