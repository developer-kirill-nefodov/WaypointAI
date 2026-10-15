import type { SourceView } from "@waypoint-ai/shared";
import { ArrowRight } from "lucide-react";
import { makeT, type Language } from "../../shared/i18n";
import { navigateTo, rememberPageSearch } from "../../shared/routing";
import { useImportState } from "../imports/import-store";
import { formatEventTime } from "./format";
import type { SourcesState } from "./useSources";

type DataStatusProps = {
  language: Language;
  /** Event sources only. */
  sources: SourceView[];
  state: SourcesState["status"];
};

/**
 * One line about the events data: which sources there are and when each was last updated, with a link to the data
 * page. Import history, failures, and cancellations live on the data page, not here.
 */
export default function DataStatus({ language, sources, state }: DataStatusProps) {
  const t = makeT(language);
  const importing = useImportState((value) => value.jobs.some((job) => job.status === "running" && job.params.kind === "events"));
  const openData = () => {
    rememberPageSearch("data", sources.length === 1 ? `?dataset=${encodeURIComponent(sources[0]!.id)}` : "");
    navigateTo("data");
  };
  if (state === "loading") return <p className="investigation-sync">{t("Загружаем источники…", "Loading sources…")}</p>;
  if (state === "error") return <p className="investigation-sync failed">{t("Не удалось загрузить источники.", "Could not load the sources.")}</p>;
  return (
    <p className="investigation-sync">
      <span>
        {t("Данные", "Data")}:{" "}
        {sources.length ? sources.map((source, index) => (
          <span key={source.id}>
            {index > 0 && " · "}
            <strong>{shortName(source)}</strong>
            {source.lastSync?.lastSucceededAt && <> {t("обновлено", "updated")} {formatEventTime(source.lastSync.lastSucceededAt, language)}</>}
          </span>
        )) : t("событий ещё нет", "no events yet")}
        {importing && <> · <em>{t("идёт импорт", "importing")}</em></>}
      </span>
      <button type="button" onClick={openData}>{t("Управлять", "Manage")}<ArrowRight size={11} /></button>
    </p>
  );
}

function shortName(source: SourceView): string {
  if (source.id === "ingv-fdsn") return "INGV";
  if (source.mode === "synthetic_local") return "Demo";
  return source.label.split(" (")[0] ?? source.label;
}
