import type { SourceView } from "@waypoint-ai/shared";
import { makeT, type Language } from "../../shared/i18n";
import { formatUtc } from "./format";
import type { SourcesState } from "./useSources";
import Warning from "./Warning";

type SyncStatusProps = {
  language: Language;
  /** Event sources only; place snapshots have no import runs to show. */
  sources: SourceView[];
  state: SourcesState["status"];
};

export default function SyncStatus({ language, sources, state }: SyncStatusProps) {
  const t = makeT(language);
  if (state === "loading") {
    return <p className="investigation-sync">{t("Загружаем источники…", "Loading sources…")}</p>;
  }
  if (state === "error") {
    return (
      <p className="investigation-sync failed">
        {t("Не удалось загрузить статус источников.", "Could not load source status.")}
      </p>
    );
  }
  if (!sources.length) {
    return (
      <p className="investigation-sync">
        {t("Источники событий ещё не импортированы.", "No event sources have been imported yet.")}
      </p>
    );
  }
  return (
    <ul className="investigation-sync" aria-label={t("Статус синхронизации", "Sync status")}>
      {sources.map((source) => {
        const sync = source.lastSync;
        const running = sync?.status === "running" ? `${t("импорт идёт", "import running")} · ` : "";
        const synced = sync?.lastSucceededAt
          ? `${t("синхр.", "synced")} ${formatUtc(sync.lastSucceededAt)}`
          : t("не синхронизирован", "never synced");
        return (
          <li key={source.id} className={sync?.status ?? "never"}>
            <i aria-hidden="true" />
            <strong>{source.id}</strong>
            <span>{running}{synced}</span>
          </li>
        );
      })}
    </ul>
  );
}

type FailedImportWarningProps = {
  language: Language;
  sources: SourceView[];
};

/** Shown when an event source's last import failed; the rows are then older imported data. */
export function FailedImportWarning({ language, sources }: FailedImportWarningProps) {
  const t = makeT(language);
  const failed = sources.filter((source) => source.lastSync?.status === "failed");
  if (!failed.length) return null;
  const codes = failed.map((source) => `${source.id}: ${source.lastSync?.errorCode ?? "error"}`).join(", ");
  return (
    <Warning>
      {t(
        "Последний импорт завершился ошибкой; показаны ранее загруженные данные.",
        "The last import failed; previously imported data is shown.",
      )}
      {" "}
      ({codes})
    </Warning>
  );
}
