import type { Language } from "../../shared/i18n";
import { useElapsed } from "../../shared/useElapsed";
import { formatSeconds } from "./format";

type ElapsedSecondsProps = {
  running: boolean;
  language: Language;
};

/**
 * Live timer as a leaf component, so only this text re-renders every 100 ms.
 * It is hidden from assistive technology so live regions do not announce every tick.
 */
export default function ElapsedSeconds({ running, language }: ElapsedSecondsProps) {
  const elapsedMs = useElapsed(running);
  return <span aria-hidden="true">{formatSeconds(elapsedMs, language)}</span>;
}
