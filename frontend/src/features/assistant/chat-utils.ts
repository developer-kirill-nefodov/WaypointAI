import type { ConnectionState } from "../../shared/api/client";
import type { ReconnectInfo } from "../../shared/api/assistantSocket";
import { translate, type Language } from "../../shared/i18n";
import type { Message } from "./chat-storage";

export function welcomeMessage(language: Language): Message {
  return { role: "assistant", text: translate(language, "Привет! Я локальный помощник для поиска и изучения геоданных. Опишите, что хотите найти.", "Hi! I’m your local assistant for exploring geospatial data. Tell me what you’d like to find.") };
}

/** The draft typed before dictation started, followed by the transcript. */
export function joinDraft(base: string, transcript: string): string {
  const trimmedBase = base.trimEnd();
  const trimmedTranscript = transcript.trim();
  if (!trimmedBase) return trimmedTranscript;
  if (!trimmedTranscript) return trimmedBase;
  return `${trimmedBase} ${trimmedTranscript}`;
}

export function conversationTitle(messages: Message[], language: Language = "en"): string {
  const firstRequest = messages.find((message) => message.role === "user")?.text.trim();
  if (!firstRequest) return translate(language, "Новый запрос", "New chat");
  return firstRequest.length > 42 ? `${firstRequest.slice(0, 42).trimEnd()}…` : firstRequest;
}

export function formatChatDate(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US", { day: "numeric", month: "short" }).format(timestamp);
}

/** Milliseconds since a performance.now() mark; 0 without one. */
export function elapsedSince(startedAt: number | null): number {
  return startedAt === null ? 0 : Math.max(0, Math.round(performance.now() - startedAt));
}

export function connectionLabel(connection: ConnectionState, reconnect: ReconnectInfo, language: Language): string {
  if (connection === "connected") return translate(language, "Соединение активно", "Connected");
  if (!reconnect) return translate(language, "Подключаемся", "Connecting");
  const seconds = Math.max(1, Math.round(reconnect.retryInMs / 1000));
  if (language === "ru") return `Переподключение через ${seconds} с · попытка ${reconnect.attempt}`;
  if (language === "de") return `Neuverbindung in ${seconds} s · Versuch ${reconnect.attempt}`;
  return `Reconnecting in ${seconds} s · attempt ${reconnect.attempt}`;
}

/** Ends the streaming state of the last message; its partial text stays visible. */
export function endStreaming(messages: Message[]): Message[] {
  const last = messages.at(-1);
  return last?.streaming ? [...messages.slice(0, -1), { role: last.role, text: last.text }] : messages;
}
