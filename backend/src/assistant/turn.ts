import type { ClientFrame, PlaceView, RecordView, ServerFrame, ToolName } from "@waypoint-ai/shared";
import { getConversationMessages, getConversationTripPlan, saveConversationTurn } from "../data/conversation.repository.js";
import { getPlaceDetails, getPlacesByIds, getRecordDetails, getSources, searchNearbyPlaces, searchPlaces } from "../data/record.repository.js";
import { ALLOWED_TOOLS } from "../tools/allowlist.js";
import { assistantToolDefinitions, executeAssistantTool, type SearchArea, type ToolExecutionResult } from "../tools/assistant-tools.js";
import { formatPlaceResultsMessage } from "./place-results-message.js";
import { chat, OllamaUnavailableError, type ChatMessage, type ChatOptions, type ToolDefinition } from "../llm/ollama.provider.js";

/** A tool call needs well under this many tokens; a plain-text first answer is cut here and retried. */
const FIRST_STEP_MAX_TOKENS = 160;
/** Answers without data are short; the cap keeps a chatty reply from taking a minute on a laptop GPU. */
const REPLY_MAX_TOKENS = 320;
import { env } from "../config/env.js";
import { releaseInference, tryAcquireInference } from "../llm/inference-gate.js";
import { resolveSettlement } from "../data/settlement.repository.js";
import type { TripPlan } from "@waypoint-ai/shared";
import { SYSTEM_PROMPT } from "./prompts/system-prompt.js";
import { text, toolLabel } from "./copy.js";
import { formatTripPlanEditMessage, formatTripPlanMessage } from "./trip-plan-message.js";
import { applyTripPlanEdits, describePlanForModel, parseEditTripPlanArgs, type TripPlanChange, type TripStopFinder } from "./trip-plan-edit.js";
import { executePlanTrip, type PlanTripDependencies } from "./plan-trip.js";
import { EDIT_TRIP_PLAN_TOOL, editTripPlanToolDefinition } from "../tools/edit-trip-plan.js";
import { PLAN_TRIP_TOOL, planTripToolDefinition } from "../tools/plan-trip.js";
import { REPLY_TOOL, replyToolDefinition } from "../tools/reply.js";
import { classifyPlanIntent, type PlanIntent } from "./plan-intent.js";

export async function processTurn(
  frame: Extract<ClientFrame, { type: "turn.submit" }>, conversationId: string, signal: AbortSignal,
  emit: (event: ServerFrame) => void,
): Promise<void> {
  const language = frame.scope.language ?? "en";
  if (frame.scope.polygonIds?.length) {
    emit({ protocolVersion: 1, type: "turn.error", requestId: frame.requestId, code: "source_unavailable", message: text(language, "Фильтр по области пока не подключён к данным сервера.", "Area filtering is not connected to the server data yet."), retryable: false });
    return;
  }
  if (frame.scope.dateRange?.from && frame.scope.dateRange.to && Date.parse(frame.scope.dateRange.from) > Date.parse(frame.scope.dateRange.to)) {
    emit({ protocolVersion: 1, type: "turn.error", requestId: frame.requestId, code: "invalid_message", message: text(language, "Начало периода должно быть раньше его окончания.", "The start date must be before the end date."), retryable: false });
    return;
  }
  if (!tryAcquireInference()) {
    emit({ protocolVersion: 1, type: "turn.error", requestId: frame.requestId, code: "busy", message: text(language, "Помощник уже обрабатывает другой запрос. Попробуйте чуть позже.", "The assistant is already handling another request. Please try again shortly."), retryable: true });
    return;
  }
  const turnStartedAt = performance.now();
  let turnOutcome: "completed" | "cancelled" | "error" = "error";
  let databaseDurationMs = 0;
  let toolDurationMs = 0;
  let modelCallCount = 0;
  let modelDurationMs = 0;
  let promptEvaluationDurationMs = 0;
  let generationDurationMs = 0;
  let promptTokenCount = 0;
  let generatedTokenCount = 0;
  let found: RecordView[] = [];
  let totalRecords = 0;
  let placesFound: PlaceView[] = [];
  let searchArea: SearchArea | undefined;
  let totalPlaces = 0;
  let listedSourceIds: string[] = [];
  let lastTool: ToolName | undefined;
  let toolCallsExecuted = 0;
  const allowedSourceIds = frame.scope.sourceIds?.slice(0, 20);
  const workspaceId = frame.scope.workspaceId ?? "demo";
  let messages: ChatMessage[] = [];
  let tripPlan: TripPlan | null = null;
  // The plan this conversation already shows; when set, the turn edits it instead of planning from scratch.
  let editablePlan: { plan: TripPlan; places: PlaceView[] } | null = null;
  let history: ChatMessage[] = [];
  let stepCount = 0;
  /** One line of the progress feed the chat shows while the turn runs. */
  const startStep = (label: string) => {
    const stepId = `step-${++stepCount}`;
    const send = (state: "running" | "done" | "failed", detail?: string) => emit({ protocolVersion: 1, type: "turn.step", requestId: frame.requestId, stepId, label: label.slice(0, 160), state, ...(detail ? { detail: detail.slice(0, 160) } : {}) });
    send("running");
    return { done: (detail?: string) => send("done", detail), fail: (detail?: string) => send("failed", detail) };
  };
  /** Replies assembled from database rows go out section by section, in the order they were built. */
  const emitSections = (message: string) => {
    const sections = message.split("\n\n");
    sections.forEach((section, index) => emit({ protocolVersion: 1, type: "assistant.delta", requestId: frame.requestId, text: index < sections.length - 1 ? `${section}\n\n` : section }));
  };
  const emitTripPlan = async (plan: TripPlan, places: PlaceView[], message: string, tool: ToolName) => {
    const sources = await getSources(plan.sourceIds);
    // The model sees the stored plan in full on the next turn, so history keeps only the reply's first paragraph
    // (what was built or changed) and the small context window is not filled with stop lists.
    await saveConversationTurn(conversationId, workspaceId, [...history, { role: "user", content: frame.message }, { role: "assistant", content: message.split("\n\n")[0]! }], plan);
    turnOutcome = "completed";
    emitSections(message);
    emit({
      protocolVersion: 1, type: "turn.completed", requestId: frame.requestId, conversationId, assistantMessage: message, appliedFilters: [
        ...(allowedSourceIds?.length ? [{ key: "sourceIds", value: allowedSourceIds }] : []),
        { key: "tool", value: tool },
      ], result: {
        total: places.length, records: [], places, tripPlan: plan, mapFeatures: {
          type: "FeatureCollection",
          features: places.map((place) => ({ type: "Feature", geometry: { type: "Point", coordinates: [place.lon, place.lat] }, properties: { entityType: "place", id: place.id, sourceId: place.sourceId, label: place.name, category: place.category } })),
        },
      }, sources,
    });
  };
  try {
    const databaseStartedAt = performance.now();
    const conversationHistory = await getConversationMessages(conversationId, workspaceId);
    history = conversationHistory;
    // The plan already on the map; the model decides whether this message changes it, replaces it, or is unrelated.
    const storedTripPlan = await getConversationTripPlan(conversationId, workspaceId);
    if (storedTripPlan) {
      editablePlan = { plan: storedTripPlan, places: await getPlacesByIds([...new Set(storedTripPlan.days.flatMap((day) => day.stopPlaceIds))]) };
    }
    const selectedContext = await resolveSelectedMapItem(frame.scope.selectedMapItem, allowedSourceIds, frame.scope.dateRange);
    databaseDurationMs += Math.round(performance.now() - databaseStartedAt);
    messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\nResponse language: ${language === "ru" ? "Russian" : language === "de" ? "German" : "English"}. Always answer in this language.\nAllowed sources: ${allowedSourceIds?.length ? allowedSourceIds.join(", ") : "all available"}. Date range: ${frame.scope.dateRange?.from ?? "not set"} — ${frame.scope.dateRange?.to ?? "not set"}.` },
      ...conversationHistory,
      ...(selectedContext ? [{ role: "system" as const, content: `User-selected map object (verified from the local database; use it as the main referent for “this point” or “this place”):\n${JSON.stringify(selectedContext)}` }] : []),
      ...(editablePlan ? [{ role: "system" as const, content: `Current trip plan shown on the map (stops from the local database). To change it, call ${EDIT_TRIP_PLAN_TOOL} once per change, naming stops by ref or name; to plan other cities from scratch, call ${PLAN_TRIP_TOOL}.\n${describePlanForModel(editablePlan.plan, editablePlan.places)}` }] : []),
      { role: "user", content: frame.message },
    ];
    const toolCallLimit = 4;
    emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "understanding", label: text(language, "Анализирую запрос", "Understanding your request") });
    const callModel = async (callMessages: ChatMessage[], tools: ToolDefinition[], options: ChatOptions = {}) => {
      const startedAt = performance.now();
      const response = await chat(callMessages, tools, signal, options);
      modelCallCount += 1;
      modelDurationMs += response.metrics.totalDurationMs;
      promptEvaluationDurationMs += response.metrics.promptEvaluationDurationMs;
      generationDurationMs += response.metrics.generationDurationMs;
      promptTokenCount += response.metrics.promptTokenCount;
      generatedTokenCount += response.metrics.generatedTokenCount;
      console.info("Assistant model call performance", {
        requestId: frame.requestId,
        call: modelCallCount,
        model: env.OLLAMA_MODEL,
        wallDurationMs: Math.round(performance.now() - startedAt),
        ...response.metrics,
      });
      return response;
    };
    // With a plan on the map, the model first classifies the message; the answering call then gets only the tools
    // that fit, which a small model uses far more reliably than the full list.
    let planIntent: PlanIntent | null = null;
    if (editablePlan) {
      const intentStep = startStep(text(language, "Определяю, что сделать с планом на карте", "Working out what to do with the plan on the map"));
      planIntent = (await classifyPlanIntent(describePlanForModel(editablePlan.plan, editablePlan.places), conversationHistory, frame.message, (callMessages, format) => callModel(callMessages, [], { format }))).intent;
      intentStep.done(planIntent === "change_plan" ? text(language, "изменить план", "change the plan") : planIntent === "new_trip" ? text(language, "новая поездка", "a new trip") : text(language, "вопрос или поиск", "a question or a search"));
      console.info("Assistant plan intent", { requestId: frame.requestId, intent: planIntent });
    }
    if (planIntent === "change_plan") {
      // Earlier edits are stored as plain confirmations ("Added to day 1: …") because history drops tool calls.
      // A small model imitates them and confirms the next change in text without calling the tool, so the edit
      // call sees the user's messages and the current plan only.
      messages = messages.filter((entry, index) => index === 0 || entry.role !== "assistant");
    }
    const toolsForTurn = planIntent === "change_plan"
      ? [editTripPlanToolDefinition, replyToolDefinition]
      : planIntent === "new_trip"
        ? [planTripToolDefinition, replyToolDefinition]
        : editablePlan
          ? [planTripToolDefinition, editTripPlanToolDefinition, ...assistantToolDefinitions, replyToolDefinition]
          : [planTripToolDefinition, ...assistantToolDefinitions, replyToolDefinition];
    let finalText = "";
    let finished = false;
    let retriedWithoutTool = false;
    let lastPlaceSearch: { search: NonNullable<ToolExecutionResult["placeSearch"]>; places: PlaceView[]; total: number } | null = null;
    let usedOtherDataTool = false;
    let editedPlan: { plan: TripPlan; places: PlaceView[]; changes: TripPlanChange[] } | null = null;
    let createdPlan: { plan: TripPlan; places: PlaceView[] } | null = null;
    let routeModeQuestion: string[] | null = null;
    let replyRequested = false;
    let streamed = false;
    let thinking = startStep(text(language, "Понимаю запрос", "Understanding the request"));
    for (let iteration = 0; iteration < 4 && !finished; iteration += 1) {
      // After events, records, or sources were fetched, the model's answer is the reply itself, so it is streamed.
      // First steps are not: a plain-text first answer may be withheld, and place and plan replies come from rows.
      const streamAnswer = toolCallsExecuted > 0 && usedOtherDataTool;
      const writing = streamAnswer ? startStep(text(language, "Пишу ответ", "Writing the answer")) : null;
      // The first call only has to choose a tool; a short token budget stops a small model that starts writing a
      // long plain-text answer instead (that text would be withheld anyway) from costing a minute.
      const response = await callModel(messages, toolsForTurn, {
        ...(streamAnswer ? { onDelta: (fragment: string) => {
          streamed = true;
          emit({ protocolVersion: 1, type: "assistant.delta", requestId: frame.requestId, text: fragment });
        } } : {}),
        ...(toolCallsExecuted === 0 && !retriedWithoutTool && planIntent !== "other" ? { maxTokens: FIRST_STEP_MAX_TOKENS } : {}),
      });
      thinking.done();
      writing?.done();
      const assistantMessage = response.message;
      messages.push({ role: "assistant", content: assistantMessage.content ?? "", tool_calls: assistantMessage.tool_calls?.map((call, index) => ({ type: "function", function: { ...call.function, index } })) });
      const calls = assistantMessage.tool_calls ?? [];
      if (calls.length === 0) {
        // The first step must be a tool call: a data tool, or reply for messages that need no data. A plain-text
        // first answer skipped the lookup and could name places that are not in the database, so it is retried once.
        if (toolCallsExecuted === 0 && !retriedWithoutTool) {
          retriedWithoutTool = true;
          console.warn("Assistant answered without a tool call; retrying", { requestId: frame.requestId, text: assistantMessage.content.slice(0, 300) });
          // The unverified text is dropped so it is neither shown nor stored in the history.
          messages.pop();
          thinking = startStep(text(language, "Уточняю, какие данные нужны", "Checking which data is needed"));
          messages.push({ role: "system", content: `Answer by calling a tool.${editablePlan ? ` If the user wants to change the current trip plan, call ${EDIT_TRIP_PLAN_TOOL}.` : ""} Use a data tool when the reply depends on places, events, records, sources, or a trip plan; call ${REPLY_TOOL} only when no data is needed. Never name places or facts that a tool did not return.` });
          continue;
        }
        // After the retry, a plain-text first answer is still unverified: it may claim a change or name places that
        // no tool returned, so it is not shown. Text after tool results is the normal final answer.
        // After an empty place search the model may answer in text; the answer still comes from the search.
        if (lastPlaceSearch && !usedOtherDataTool) {
          finalText = formatPlaceResultsMessage(lastPlaceSearch.search, lastPlaceSearch.places, lastPlaceSearch.total, language);
          messages.splice(messages.length - 1, 1, { role: "assistant", content: finalText.split("\n\n")[0]! });
          finished = true;
          break;
        }
        const unverified = toolCallsExecuted === 0 && planIntent !== "other";
        finalText = unverified
          ? text(language, "Не получилось обработать запрос. Попробуйте сформулировать его иначе.", "I could not process this request. Please try rephrasing it.")
          : assistantMessage.content.trim();
        if (unverified) {
          console.warn("Assistant answered without a tool call twice; reply withheld", { requestId: frame.requestId, text: assistantMessage.content.slice(0, 300) });
          messages.splice(messages.length - 1, 1, { role: "assistant", content: finalText });
        }
        finished = true;
        break;
      }
      if (iteration === 3) throw new Error("Tool call limit exceeded");
      if (toolCallsExecuted + calls.length > toolCallLimit) throw new Error("Tool call limit exceeded");
      for (const call of calls) {
        toolCallsExecuted += 1;
        const toolCallName = call.function.name;
        console.info("Assistant tool call", { requestId: frame.requestId, iteration, tool: toolCallName, arguments: call.function.arguments });
        if (toolCallName === REPLY_TOOL) {
          replyRequested = true;
          finished = true;
          break;
        }
        if (!ALLOWED_TOOLS.includes(toolCallName as ToolName)) {
          messages.push({ role: "tool", tool_name: toolCallName, content: JSON.stringify({ error: "Tool is not allowlisted." }) });
          continue;
        }
        const toolName = toolCallName as ToolName;
        lastTool = toolName;
        if (toolName === PLAN_TRIP_TOOL) {
          emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "searching", label: text(language, "Собираю план из проверенных точек", "Building a plan from verified places") });
          emit({ protocolVersion: 1, type: "tool.started", requestId: frame.requestId, tool: toolName, label: toolLabel(toolName, language) });
          const toolStep = startStep(toolStepLabel(toolName, call.function.arguments, language));
          const toolStartedAt = performance.now();
          const outcome = await executePlanTrip(call.function.arguments, planTripDependencies(allowedSourceIds), allowedSourceIds);
          toolDurationMs += Math.round(performance.now() - toolStartedAt);
          console.info("Assistant plan_trip call", { requestId: frame.requestId, arguments: call.function.arguments, outcome: outcome.kind });
          if (outcome.kind === "planned") createdPlan = { plan: outcome.plan, places: outcome.places };
          if (outcome.kind === "ask_route_mode") routeModeQuestion = outcome.cities;
          if (outcome.kind === "error") toolStep.fail(text(language, "не получилось, уточняю", "did not work, checking"));
          else toolStep.done(outcome.kind === "planned" ? text(language, `${outcome.plan.totalDays} дн., ${outcome.places.length} точек`, `${outcome.plan.totalDays} days, ${outcome.places.length} stops`) : text(language, "нужно выбрать маршрут", "route choice needed"));
          messages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(outcome.kind === "error" ? { error: outcome.error } : { ok: true }) });
          emit({ protocolVersion: 1, type: "tool.completed", requestId: frame.requestId, tool: toolName, recordsFound: outcome.kind === "planned" ? outcome.places.length : 0 });
          continue;
        }
        if (toolName === EDIT_TRIP_PLAN_TOOL) {
          emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "searching", label: text(language, "Изменяю план поездки", "Updating the trip plan") });
          emit({ protocolVersion: 1, type: "tool.started", requestId: frame.requestId, tool: toolName, label: toolLabel(toolName, language) });
          const toolStep = startStep(toolStepLabel(toolName, call.function.arguments, language));
          const toolStartedAt = performance.now();
          const current: { plan: TripPlan; places: PlaceView[]; changes?: TripPlanChange[] } | null = editedPlan ?? editablePlan;
          const outcome = await runTripPlanEdit(current, call.function.arguments, allowedSourceIds);
          toolDurationMs += Math.round(performance.now() - toolStartedAt);
          console.info("Assistant edit_trip_plan call", { requestId: frame.requestId, arguments: call.function.arguments, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
          if (outcome.ok) editedPlan = { plan: outcome.plan, places: outcome.places, changes: [...(current?.changes ?? []), ...outcome.changes] };
          if (outcome.ok) toolStep.done();
          else toolStep.fail(text(language, "не получилось, уточняю", "did not work, checking"));
          messages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(outcome.ok ? { ok: true, changes: outcome.changes } : { error: outcome.error }) });
          emit({ protocolVersion: 1, type: "tool.completed", requestId: frame.requestId, tool: toolName, recordsFound: outcome.ok ? outcome.places.length : 0 });
          continue;
        }
        emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "searching", label: text(language, "Ищу в локальной базе", "Searching the local database") });
        emit({ protocolVersion: 1, type: "tool.started", requestId: frame.requestId, tool: toolName, label: toolLabel(toolName, language) });
        const toolStep = startStep(toolStepLabel(toolName, call.function.arguments, language));
        const toolStartedAt = performance.now();
        const result = await executeAssistantTool(
          toolName,
          call.function.arguments,
          frame.scope,
          allowedSourceIds,
          selectionPoint(selectedContext),
          frame.message,
        );
        toolDurationMs += Math.round(performance.now() - toolStartedAt);
        messages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(result.content) });
        if (result.records) {
          found = result.records;
          totalRecords = result.totalRecords ?? result.records.length;
        }
        if (result.placeSearch) lastPlaceSearch = { search: result.placeSearch, places: result.places ?? [], total: result.totalPlaces ?? 0 };
        else usedOtherDataTool = true;
        if (result.places) {
          placesFound = [...new Map([...placesFound, ...result.places].map((place) => [place.id, place])).values()];
          totalPlaces = Math.max(totalPlaces, result.totalPlaces ?? result.places.length);
        }
        if (result.sourceIds) listedSourceIds = result.sourceIds;
        if (result.searchArea) searchArea = result.searchArea;
        emit({ protocolVersion: 1, type: "tool.completed", requestId: frame.requestId, tool: toolName, recordsFound: result.resultsFound });
        if (result.content && typeof result.content === "object" && "error" in result.content) toolStep.fail(text(language, "не получилось, уточняю", "did not work, checking"));
        else toolStep.done(text(language, `найдено: ${result.resultsFound}`, `found: ${result.resultsFound}`));
      }
      // A new or edited plan is described from verified rows; the model is not asked to retell it.
      if (finished || createdPlan || editedPlan || routeModeQuestion) break;
      // Place results are listed from the rows as well, so the answer cannot name places the search did not return.
      // An empty first search goes back to the model once, which can retry with another spelling or kind.
      if (lastPlaceSearch && !usedOtherDataTool && (lastPlaceSearch.places.length || iteration > 0)) {
        finalText = formatPlaceResultsMessage(lastPlaceSearch.search, lastPlaceSearch.places, lastPlaceSearch.total, language);
        placesFound = lastPlaceSearch.places;
        totalPlaces = lastPlaceSearch.total;
        messages.push({ role: "assistant", content: finalText.split("\n\n")[0]! + (lastPlaceSearch.places.length ? ` ${lastPlaceSearch.places.map((place) => place.name).join("; ")}` : "") });
        finished = true;
        break;
      }
    }
    if (replyRequested) {
      // The model chose to answer without data. The answer is written by a separate, tool-free call with a short
      // prompt: given the full prompt, which says every answer starts with a tool call, a small model writes a tool
      // call as text instead of an answer.
      messages.pop();
      const writing = startStep(text(language, "Пишу ответ", "Writing the answer"));
      const response = await callModel([
        { role: "system", content: replyPrompt(language, editablePlan ? describePlanForModel(editablePlan.plan, editablePlan.places) : null) },
        ...messages.filter((entry) => (entry.role === "user" || entry.role === "assistant") && !entry.tool_calls?.length),
      ], [], { maxTokens: REPLY_MAX_TOKENS, onDelta: (fragment) => {
        streamed = true;
        emit({ protocolVersion: 1, type: "assistant.delta", requestId: frame.requestId, text: fragment });
      } });
      writing.done();
      finalText = response.message.content.trim();
      // A tool call written as text is not an answer; the streamed text is replaced by the final message.
      if (!finalText || /^[a-z_]+\s*[({]/i.test(finalText)) {
        finalText = text(language, "Не получилось обработать запрос. Попробуйте сформулировать его иначе.", "I could not process this request. Please try rephrasing it.");
      }
      messages.push({ role: "assistant", content: finalText });
    }
    if (routeModeQuestion) {
      const cities = routeModeQuestion.join(", ");
      const message = language === "ru" ? `Сейчас приложение умеет строить только автомобильный маршрут. Построить его по дням (${cities})?`
        : language === "de" ? `Die App kann nur Autorouten berechnen. Soll ich für jeden Tag eine Autoroute hinzufügen (${cities})?`
          : `The app can calculate driving routes only. Should I add a driving route for each day (${cities})?`;
      await saveConversationTurn(conversationId, workspaceId, [...history, { role: "user", content: frame.message }, { role: "assistant", content: message }]);
      turnOutcome = "completed";
      emit({
        protocolVersion: 1, type: "turn.clarification", requestId: frame.requestId, conversationId, message, choices: [
          { id: "route-driving", label: text(language, "Да, автомобильный маршрут", "Yes, use a driving route") },
          { id: "route-none", label: text(language, "Нет, только список мест", "No, places only") },
        ],
      });
      return;
    }
    if (createdPlan || editedPlan) startStep(text(language, "Собираю ответ из проверенных данных", "Assembling the answer from verified data")).done();
    if (createdPlan) {
      await emitTripPlan(createdPlan.plan, createdPlan.places, formatTripPlanMessage(createdPlan.plan, createdPlan.places, language), PLAN_TRIP_TOOL);
      return;
    }
    if (editedPlan) {
      const message = formatTripPlanEditMessage(editedPlan.changes, editedPlan.plan, editedPlan.places, language);
      await emitTripPlan(editedPlan.plan, editedPlan.places, message, EDIT_TRIP_PLAN_TOOL);
      return;
    }
    if (!finalText) throw new Error("Model did not produce a final response");
    emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "composing", label: text(language, "Формирую ответ", "Writing the answer") });
    // A follow-up that searched nothing keeps the current plan on the map.
    const keepPlan = editablePlan && !found.length && !placesFound.length && !searchArea ? editablePlan : null;
    if (keepPlan) {
      tripPlan = keepPlan.plan;
      placesFound = keepPlan.places;
      totalPlaces = keepPlan.places.length;
    }
    const sourceIds = [...new Set(found.map((record) => record.sourceId))];
    const allSourceIds = [...new Set([...sourceIds, ...placesFound.map((place) => place.sourceId), ...listedSourceIds])];
    const sources = await getSources(allSourceIds);
    // The final model reply is already in `messages` from the loop; pushing it again stored every answer twice.
    await saveConversationTurn(conversationId, workspaceId, messages);
    turnOutcome = "completed";
    if (!streamed) emitSections(finalText);
    const mapFeatures = {
      type: "FeatureCollection",
      features: [
        ...found.map((record) => ({ type: "Feature", geometry: { type: "Point", coordinates: [record.lon, record.lat] }, properties: { entityType: "record", id: record.id, sourceId: record.sourceId, label: record.label, placeName: typeof record.attributes.place === "object" && record.attributes.place && "name" in record.attributes.place ? record.attributes.place.name : null, observedAt: record.observedAt, category: typeof record.attributes.category === "string" ? record.attributes.category : record.label } })),
        ...placesFound.map((place) => ({ type: "Feature", geometry: { type: "Point", coordinates: [place.lon, place.lat] }, properties: { entityType: "place", id: place.id, sourceId: place.sourceId, label: place.name, category: place.category } })),
      ],
    };
    emit({
      protocolVersion: 1, type: "turn.completed", requestId: frame.requestId, conversationId, assistantMessage: finalText, appliedFilters: [
        ...(allowedSourceIds?.length ? [{ key: "sourceIds", value: allowedSourceIds }] : []),
        ...(frame.scope.dateRange ? [{ key: "dateRange", value: frame.scope.dateRange }] : []),
        ...(typeof frame.scope.filters?.category === "string" ? [{ key: "category", value: frame.scope.filters.category.slice(0, 120) }] : []),
        ...(lastTool ? [{ key: "tool", value: lastTool }] : []),
      ], result: {
        total: totalRecords + totalPlaces,
        records: found,
        places: placesFound,
        ...(tripPlan ? { tripPlan } : {}),
        ...(searchArea ? { searchArea } : {}),
        mapFeatures,
      }, sources
    });
  } catch (error) {
    if (signal.aborted) {
      turnOutcome = "cancelled";
      emit({ protocolVersion: 1, type: "turn.cancelled", requestId: frame.requestId });
      return;
    }
    const aborted = error instanceof DOMException && error.name === "TimeoutError";
    const modelUnavailable = error instanceof OllamaUnavailableError;
    console.error("Assistant turn failed", { requestId: frame.requestId, error: error instanceof Error ? error.stack ?? error.message : error });
    const errorMessage = aborted ? text(language, "Локальная модель прервала обработку. Попробуйте повторить запрос или разделить его на части.", "The local model interrupted generation. Try again or split the request into smaller parts.") : modelUnavailable ? text(language, "Не удалось подключиться к локальной модели. Проверьте, запущен ли Ollama и загружена ли выбранная модель.", "Could not connect to the local model. Check that Ollama is running and the selected model is installed.") : language === "de" ? `Der Server konnte keine Antwort vorbereiten. Versuchen Sie es erneut. Fehlercode: ${frame.requestId}.` : text(language, `Сервер не смог подготовить ответ. Повторите запрос; если ошибка повторится, передайте разработчику код ${frame.requestId}.`, `The server could not prepare a reply. Try again; if it happens again, share error code ${frame.requestId} with the developer.`);
    emit({ protocolVersion: 1, type: "turn.error", requestId: frame.requestId, code: aborted ? "timeout" : modelUnavailable ? "model_unavailable" : "internal_error", message: errorMessage, retryable: true });
  } finally {
    console.info("Assistant turn performance", {
      requestId: frame.requestId,
      outcome: turnOutcome,
      model: env.OLLAMA_MODEL,
      totalDurationMs: Math.round(performance.now() - turnStartedAt),
      databaseDurationMs,
      toolDurationMs,
      modelCallCount,
      modelDurationMs,
      promptEvaluationDurationMs,
      generationDurationMs,
      promptTokenCount,
      generatedTokenCount,
    });
    releaseInference();
  }
}

async function resolveSelectedMapItem(selection: { type: "place" | "record"; id: string } | undefined, sourceIds: string[] | undefined, dateRange: { from?: string; to?: string } | null | undefined) {
  if (!selection) return null;
  if (selection.type === "place") {
    const place = await getPlaceDetails(selection.id);
    if (!place || (sourceIds?.length && !sourceIds.includes(place.sourceId))) return { unavailable: true, reason: "The selected place is not part of the active source scope." };
    return { type: "place", ...place };
  }
  const record = await getRecordDetails(selection.id);
  if (!record || (sourceIds?.length && !sourceIds.includes(record.sourceId))) return { unavailable: true, reason: "The selected record was not found in the active source scope." };
  const at = Date.parse(record.observedAt);
  if ((dateRange?.from && at < Date.parse(dateRange.from)) || (dateRange?.to && at > Date.parse(dateRange.to))) return { unavailable: true, reason: "The selected record is outside the active date range." };
  return { type: "record", ...record };
}

/** Center for "near this point" searches: only a verified, in-scope selected map item. */
function selectionPoint(selected: Awaited<ReturnType<typeof resolveSelectedMapItem>>): { lat: number; lon: number; label: string } | null {
  if (!selected || !("lat" in selected)) return null;
  return {
    lat: selected.lat,
    lon: selected.lon,
    label: "name" in selected ? selected.name : selected.label,
  };
}

/** New stops for plan edits: nearest named places of the requested kinds, widening the radius when too few are close. */
function tripStopFinder(sourceIds: string[] | undefined): TripStopFinder {
  return async ({ center, categories, count, excludeIds }) => {
    let candidates: PlaceView[] = [];
    for (const radiusMeters of [2_500, 6_000, 15_000]) {
      const results = await Promise.all(categories.map((category) => searchNearbyPlaces({ category, sourceIds, center, radiusMeters, limit: 50 })));
      const lists = results.map((result) => (result.places as PlaceView[]).filter((place) => /\p{L}/u.test(place.name) && !excludeIds.has(place.id)));
      // Interleave categories so a mixed request gets some of each.
      const merged: PlaceView[] = [];
      for (let position = 0; position < 50; position += 1) for (const list of lists) if (list[position]) merged.push(list[position]!);
      candidates = [...new Map(merged.map((place) => [place.id, place])).values()];
      if (candidates.length >= count) break;
    }
    return candidates.slice(0, count);
  };
}

async function runTripPlanEdit(state: { plan: TripPlan; places: PlaceView[] } | null, rawArgs: unknown, sourceIds: string[] | undefined) {
  if (!state) return { ok: false as const, error: "There is no trip plan in this conversation yet. Ask which city and how many days to plan." };
  const parsed = parseEditTripPlanArgs(rawArgs);
  if (!parsed.success) return { ok: false as const, error: "Invalid edit_trip_plan arguments. Use only the documented operations and fields." };
  return applyTripPlanEdits(state.plan, state.places, parsed.data.operations, tripStopFinder(sourceIds));
}

/** Database lookups behind plan_trip: settlements, the airport row, and places around it. */
function planTripDependencies(sourceIds: string[] | undefined): PlanTripDependencies {
  return {
    resolveSettlement,
    findAirport: async (code) => (await searchPlaces({ airportCode: code, sourceIds, limit: 1 })).places[0] as PlaceView | undefined ?? null,
    findNearAirport: async (center, radiusMeters, count) => {
      const lists = await Promise.all(["tourism:attraction", "tourism:museum"].map((category) => searchNearbyPlaces({ category, sourceIds, center, radiusMeters, limit: count })));
      const places = [...new Map(lists.flatMap((list) => list.places as PlaceView[]).filter((place) => /\p{L}/u.test(place.name)).map((place) => [place.id, place])).values()].slice(0, count);
      return { places, distancesMeters: Object.assign({}, ...lists.map((list) => list.distancesMeters)) };
    },
  };
}

/** A short progress line for a tool call, from the validated-or-not arguments; only plain values are shown. */
function toolStepLabel(tool: ToolName, rawArgs: unknown, language: "en" | "ru" | "de"): string {
  let args: Record<string, unknown> = {};
  try { args = (typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs) as Record<string, unknown> ?? {}; } catch { args = {}; }
  const plain = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value).slice(0, 40) : null);
  const details = tool === "plan_trip" && Array.isArray(args.cities)
    ? [args.cities.map((city) => plain((city as { name?: unknown })?.name ?? city)).filter(Boolean).join(", "), args.totalDays ? text(language, `${plain(args.totalDays)} дн.`, `${plain(args.totalDays)} days`) : null]
    : tool === "edit_trip_plan"
      ? [plain(args.op), args.day ? text(language, `день ${plain(args.day)}`, `day ${plain(args.day)}`) : null, plain(args.category)]
      : [plain(args.kind), plain(args.category), plain(args.query), plain(args.city), plain(args.place), args.radiusKm ? `${plain(args.radiusKm)} km` : null];
  const summary = details.filter((value) => value && value !== "any").join(" · ");
  return summary ? `${toolLabel(tool, language)}: ${summary}` : toolLabel(tool, language);
}

/** Prompt for writing an answer that needs no data: what the app can do, and the trip plan if one is shown. */
function replyPrompt(language: "en" | "ru" | "de", plan: string | null): string {
  return `You are Waypoint AI, a local map assistant. Answer the user's last message in ${language === "ru" ? "Russian" : language === "de" ? "German" : "English"} in at most four short sentences of plain text. Do not call or name tools and do not write code or JSON.
What the app can do: find places and sights in the local OpenStreetMap snapshots (Berlin, Mazovia, Romania, Île-de-France, Central Italy, the Madrid region); build and edit multi-day trip plans with a driving route per day; search imported INGV earthquakes by place, radius, period, and magnitude; describe the data sources.
Use only facts from this conversation${plan ? " and the trip plan below" : ""}; never name places, events, or numbers that are not there.${plan ? `\nCurrent trip plan: ${plan}` : ""}`;
}
