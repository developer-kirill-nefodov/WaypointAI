import { makeT, type Language } from "../../shared/i18n";
import ElapsedSeconds from "./ElapsedSeconds";
import { formatSeconds, formatUtc, pick } from "./format";
import type { SearchState } from "./useEventSearch";
import Warning from "./Warning";

type ResultsSummaryProps = {
  language: Language;
  search: SearchState;
  refreshing: boolean;
  lastDurationMs: number | null;
  hasSynthetic: boolean;
  hasUnverified: boolean;
};

/** Result count, search window, and timing, followed by data-quality warnings for the rows below. */
export default function ResultsSummary({
  language,
  search,
  refreshing,
  lastDurationMs,
  hasSynthetic,
  hasUnverified,
}: ResultsSummaryProps) {
  const t = makeT(language);
  return (
    <>
      <p className="investigation-summary" aria-live="polite" aria-busy={refreshing}>
        {search.status === "ready" && (
          <>
            <span>
              {pick(language, {
                ru: `Найдено ${search.total}, показано ${search.events.length}`,
                en: `${search.total} found, ${search.events.length} shown`,
                de: `${search.total} gefunden, ${search.events.length} angezeigt`,
              })}
              <SearchTiming language={language} refreshing={refreshing} lastDurationMs={lastDurationMs} />
            </span>
            <small>{formatUtc(search.appliedFilters.from)} — {formatUtc(search.appliedFilters.to)}</small>
          </>
        )}
      </p>
      {hasSynthetic && (
        <Warning>
          {t("В результатах есть синтетические события офлайн-демо.", "Results include synthetic offline-demo events.")}
        </Warning>
      )}
      {hasUnverified && (
        <Warning>
          {t(
            "У части событий нет метаданных источника; они помечены как непроверенные.",
            "Some events have no source metadata; they are marked unverified.",
          )}
        </Warning>
      )}
    </>
  );
}

type SearchTimingProps = {
  language: Language;
  refreshing: boolean;
  lastDurationMs: number | null;
};

/** A live timer while the next result set loads, then how long the last one took. */
function SearchTiming({ language, refreshing, lastDurationMs }: SearchTimingProps) {
  const t = makeT(language);
  if (refreshing) return <> · {t("обновляем…", "updating…")} <ElapsedSeconds running language={language} /></>;
  if (lastDurationMs === null) return null;
  return <> · {formatSeconds(lastDurationMs, language)}</>;
}
