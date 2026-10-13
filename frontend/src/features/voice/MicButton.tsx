import { LoaderCircle, Mic, MicOff, Square } from "lucide-react";
import { translate, type Language } from "../../shared/i18n";
import type { VoiceIssue, VoiceState } from "./useVoiceInput";

interface MicButtonProps {
  language: Language;
  state: VoiceState;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}

export default function MicButton({ language, state, disabled, onStart, onStop }: MicButtonProps) {
  const t = (ru: string, en: string) => translate(language, ru, en);
  const active = state === "recording" || state === "starting";
  const label = active ? t("Остановить запись", "Stop recording") : t("Голосовой ввод", "Voice input");
  return (
    <button
      type="button"
      className={`voice-button ${state}`}
      aria-pressed={active}
      aria-label={label}
      title={label}
      disabled={disabled || state === "finishing"}
      onClick={active ? onStop : onStart}
    >
      {state === "finishing" || state === "starting" ? <LoaderCircle size={15} className="voice-spinner" aria-hidden="true" /> : active ? <Square size={13} aria-hidden="true" /> : disabled ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
    </button>
  );
}

/** Footer text for the current voice state; null keeps the default local-processing note. */
export function voiceStatusText(language: Language, state: VoiceState, issue: VoiceIssue | null): string | null {
  const t = (ru: string, en: string) => translate(language, ru, en);
  if (state === "starting") return t("Запрашиваю доступ к микрофону…", "Requesting microphone access…");
  if (state === "recording") return t("Запись · аудио отправляется в OpenAI для распознавания", "Recording · audio is sent to OpenAI for transcription");
  if (state === "finishing") return t("Завершаю распознавание…", "Finishing transcription…");
  if (!issue) return null;
  if (issue === "permission_denied") return t("Доступ к микрофону запрещён в браузере", "Microphone access is blocked in the browser");
  if (issue === "no_microphone") return t("Микрофон не найден или занят", "No available microphone was found");
  if (issue === "unsupported") return t("Браузер не поддерживает запись звука", "This browser does not support audio capture");
  if (issue === "disconnected") return t("Соединение прервано, запись остановлена", "Connection lost; recording stopped");
  if (issue === "voice_disabled") return t("Голосовой ввод выключен на сервере", "Voice input is disabled on the server");
  if (issue === "busy") return t("Запись уже идёт в этом соединении", "A recording is already active");
  if (issue === "timeout") return t("Сервис распознавания не ответил вовремя", "Speech recognition did not respond in time");
  if (issue === "provider_unavailable") return t("Сервис распознавания речи недоступен", "Speech recognition is unavailable");
  return t("Не удалось распознать речь", "Speech recognition failed");
}
