import { invalidateCache } from "../../shared/data-cache";
import type { Translator } from "../../shared/i18n";
import { TrainingRequestError } from "./training-api";

/** Labels, lists, and helpers shared by the model page's training tabs. */

export type RunMode = "first_step" | "router" | "full";
export const TOPICS = ["all", "places", "events", "trips", "sources"] as const;
export const EXAMPLE_TOOLS = ["search_places", "search_events", "list_sources", "plan_trip", "reply"] as const;
export const CASE_TOOLS = [...EXAMPLE_TOOLS, "search_records", "get_record_details", "edit_trip_plan"] as const;
export const ORIGINS = ["generated", "hard", "starter", "manual", "journal"] as const;
export const SKILLS = ["places", "events", "trips", "sources", "reply", "other"] as const;

export const refreshTraining = (what: "lessons" | "cases" | "runs" | "all" = "all") => invalidateCache(what === "all" ? "training:" : `training:${what}`);

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function errorText(error: unknown, t: Translator): string {
  const code = error instanceof TrainingRequestError ? error.code : "request_failed";
  const messages: Record<string, string> = {
    forbidden_text: t("Текст похож на попытку изменить правила, SQL, ссылку или код. Такие уроки не принимаются.", "The text looks like an attempt to change the rules, SQL, a link, or code. Such lessons are refused."),
    invalid_example_args: t("Аргументы не подходят инструменту: используйте только его поля (например, place, а не координаты).", "The arguments do not fit the tool: use only its fields (for example place, not coordinates)."),
    example_needs_tool_or_answer: t("Примеру нужен вызов инструмента, ответ или и то и другое.", "An example needs a tool call, an answer, or both."),
    invalid_lesson: t("Проверьте поля урока.", "Check the lesson's fields."),
    invalid_case: t("Проверьте поля вопроса.", "Check the question's fields."),
    training_disabled: t("Редактирование выключено на сервере (TRAINING_ENABLED).", "Editing is off on the server (TRAINING_ENABLED)."),
    exam_running: t("Экзамен уже идёт.", "An exam is already running."),
    no_cases: t("Нет включённых вопросов экзамена.", "No exam questions are enabled."),
    network_error: t("Сервер недоступен.", "The server is unreachable."),
  };
  return messages[code] ?? t("Не получилось. Попробуйте ещё раз.", "That did not work. Try again.");
}

export function topicLabel(topic: string, t: Translator): string {
  const labels: Record<string, string> = { all: t("всё", "all"), places: t("места", "places"), events: t("события", "events"), trips: t("поездки", "trips"), sources: t("источники", "sources") };
  return labels[topic] ?? topic;
}

export function originLabel(origin: string, t: Translator): string {
  const labels: Record<string, string> = { generated: t("сгенерированные", "generated"), hard: t("трудные", "hard"), starter: t("стартовые", "starter"), manual: t("ручные", "manual"), journal: t("из журнала", "from the journal") };
  return labels[origin] ?? origin;
}

export function skillLabel(skill: string, t: Translator): string {
  const labels: Record<string, string> = { places: t("места", "places"), events: t("события", "events"), trips: t("поездки", "trips"), sources: t("источники", "sources"), reply: t("ответ без данных", "reply"), other: t("другое", "other") };
  return labels[skill] ?? skill;
}

export const modeLabel = (mode: string, t: Translator) => (mode === "first_step" ? t("инструмент", "tool choice") : mode === "router" ? t("маршрутизатор", "router") : t("полный ход", "full turn"));

export function checkLabel(check: string, t: Translator): string {
  const labels: Record<string, string> = {
    completed: t("ответ", "answer"), tool: t("инструмент", "tool"), args: t("аргументы", "arguments"), language: t("язык", "language"),
    mustInclude: t("есть нужное", "includes"), mustNotInclude: t("нет лишнего", "excludes"), citations: t("ссылки", "citations"), citeEachEvent: t("ссылка у каждого события", "each event cited"), maxSentences: t("длина", "length"),
  };
  return labels[check] ?? check;
}
