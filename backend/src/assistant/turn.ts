import type { ClientFrame, PlaceView, RecordView, ServerFrame, ToolName } from "@waypoint-ai/shared";
import { getConversationMessages, saveConversationTurn } from "../data/conversation.repository.js";
import { getPlaceDetails, getRecordDetails, getSources } from "../data/record.repository.js";
import { ALLOWED_TOOLS } from "../tools/allowlist.js";
import { assistantToolDefinitions, executeAssistantTool } from "../tools/assistant-tools.js";
import { chat, OllamaUnavailableError, type ChatMessage } from "../llm/ollama.provider.js";
import { env } from "../config/env.js";
import { explicitTravelCountry, formatTravelPlacePrefetch, inferRecentTravelCountry, isFreshTravelContext, prefetchTravelPlaces, recentTravelContextMessages, type TravelPlacePrefetch } from "./travel-place-prefetch.js";
import { getTripClarification, resolveTripPreferences } from "./trip-clarification.js";
import { buildTripPlan } from "./trip-plan.js";
import type { TripPlan } from "@waypoint-ai/shared";
import { SYSTEM_PROMPT } from "./prompts/system-prompt.js";
import { text, toolLabel } from "./copy.js";
import { formatTripPlanMessage } from "./trip-plan-message.js";
let modelBusy = false;

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
  if (modelBusy) {
    emit({ protocolVersion: 1, type: "turn.error", requestId: frame.requestId, code: "busy", message: text(language, "Помощник уже обрабатывает другой запрос. Попробуйте чуть позже.", "The assistant is already handling another request. Please try again shortly."), retryable: true });
    return;
  }
  modelBusy = true;
  const turnStartedAt = performance.now();
  let turnOutcome: "completed" | "cancelled" | "error" = "error";
  let databaseDurationMs = 0;
  let prefetchDurationMs = 0;
  let toolDurationMs = 0;
  let modelCallCount = 0;
  let modelDurationMs = 0;
  let promptEvaluationDurationMs = 0;
  let generationDurationMs = 0;
  let promptTokenCount = 0;
  let generatedTokenCount = 0;
  let prefetchPlaceCount = 0;
  let found: RecordView[] = [];
  let totalRecords = 0;
  let placesFound: PlaceView[] = [];
  let totalPlaces = 0;
  let listedSourceIds: string[] = [];
  let lastTool: ToolName | undefined;
  let toolCallsExecuted = 0;
  const allowedSourceIds = frame.scope.sourceIds?.slice(0, 20);
  const workspaceId = frame.scope.workspaceId ?? "demo";
  let messages: ChatMessage[] = [];
  let travelPrefetch: TravelPlacePrefetch | null = null;
  let tripPlan: TripPlan | null = null;
  let travelSourceMetadata: Awaited<ReturnType<typeof getSources>> = [];
  try {
    const databaseStartedAt = performance.now();
    const conversationHistory = await getConversationMessages(conversationId, workspaceId);
    const recentUserMessages = conversationHistory.filter((message) => message.role === "user").map((message) => message.content);
    const scopedTravelHistory = recentTravelContextMessages(recentUserMessages);
    const freshTravelRequest = isFreshTravelContext(frame.message, scopedTravelHistory);
    const relevantUserMessages = freshTravelRequest ? [] : scopedTravelHistory;
    if (freshTravelRequest && !explicitTravelCountry(frame.message)) {
      const message = text(language, "Для нового плана выберите страну или укажите город. В локальной базе доступны Германия, Польша, Румыния, Франция, Италия и Испания.", "Choose a country for the new plan or name a city. The local data covers Germany, Poland, Romania, France, Italy, and Spain.");
      const choices = language === "ru" ? [
        { id: "new-de", label: "Новый план: Германия — Берлин" },
        { id: "new-pl", label: "Новый план: Польша — Варшава" },
        { id: "new-ro", label: "Новый план: Румыния — Бухарест" },
        { id: "new-fr", label: "Новый план: Франция — Париж" },
        { id: "new-it", label: "Новый план: Италия — Рим" },
        { id: "new-es", label: "Новый план: Испания — Мадрид" },
      ] : language === "de" ? [
        { id: "new-de", label: "Neuer Plan: Deutschland — Berlin" },
        { id: "new-pl", label: "Neuer Plan: Polen — Warschau" },
        { id: "new-ro", label: "Neuer Plan: Rumänien — Bukarest" },
        { id: "new-fr", label: "Neuer Plan: Frankreich — Paris" },
        { id: "new-it", label: "Neuer Plan: Italien — Rom" },
        { id: "new-es", label: "Neuer Plan: Spanien — Madrid" },
      ] : [
        { id: "new-de", label: "New plan: Germany — Berlin" },
        { id: "new-pl", label: "New plan: Poland — Warsaw" },
        { id: "new-ro", label: "New plan: Romania — Bucharest" },
        { id: "new-fr", label: "New plan: France — Paris" },
        { id: "new-it", label: "New plan: Italy — Rome" },
        { id: "new-es", label: "New plan: Spain — Madrid" },
      ];
      await saveConversationTurn(conversationId, workspaceId, [
        ...conversationHistory,
        { role: "user", content: frame.message },
        { role: "assistant", content: message },
      ]);
      databaseDurationMs += Math.round(performance.now() - databaseStartedAt);
      turnOutcome = "completed";
      emit({ protocolVersion: 1, type: "turn.clarification", requestId: frame.requestId, conversationId, message, choices });
      return;
    }
    const clarification = getTripClarification(frame.message, relevantUserMessages, language);
    if (clarification) {
      await saveConversationTurn(conversationId, workspaceId, [
        ...conversationHistory,
        { role: "user", content: frame.message },
        { role: "assistant", content: clarification.message },
      ]);
      databaseDurationMs += Math.round(performance.now() - databaseStartedAt);
      turnOutcome = "completed";
      emit({ protocolVersion: 1, type: "turn.clarification", requestId: frame.requestId, conversationId, ...clarification });
      return;
    }
    if (/остановить подбор|stop planning/i.test(frame.message)) {
      const message = text(language, "Остановил планирование поездки.", "Trip planning stopped.");
      await saveConversationTurn(conversationId, workspaceId, [
        ...conversationHistory,
        { role: "user", content: frame.message },
        { role: "assistant", content: message },
      ]);
      turnOutcome = "completed";
      emit({ protocolVersion: 1, type: "turn.completed", requestId: frame.requestId, conversationId, assistantMessage: message, appliedFilters: [], result: { total: 0, records: [], places: [], mapFeatures: { type: "FeatureCollection", features: [] } }, sources: [] });
      return;
    }
    const selectedContext = await resolveSelectedMapItem(frame.scope.selectedMapItem, allowedSourceIds, frame.scope.dateRange);
    databaseDurationMs += Math.round(performance.now() - databaseStartedAt);
    const prefetchStartedAt = performance.now();
    travelPrefetch = await prefetchTravelPlaces(frame.message, allowedSourceIds, language, inferRecentTravelCountry(relevantUserMessages), relevantUserMessages);
    prefetchDurationMs = Math.round(performance.now() - prefetchStartedAt);
    if (travelPrefetch) {
      prefetchPlaceCount = travelPrefetch.places.length;
      const sourceMetadataStartedAt = performance.now();
      travelSourceMetadata = await getSources([...new Set(travelPrefetch.places.map((place) => place.sourceId))]);
      databaseDurationMs += Math.round(performance.now() - sourceMetadataStartedAt);
      lastTool = "search_places";
      for (const search of travelPrefetch.searches) {
        toolCallsExecuted += 1;
        emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "searching", label: text(language, "Ищу города и места в локальной выгрузке", "Searching cities and places in the local extract") });
        emit({ protocolVersion: 1, type: "tool.started", requestId: frame.requestId, tool: "search_places", label: `${text(language, "Подборка", "Searching")}: ${search.label}` });
        emit({ protocolVersion: 1, type: "tool.completed", requestId: frame.requestId, tool: "search_places", recordsFound: search.places.length });
      }
      placesFound = travelPrefetch.places;
      totalPlaces = travelPrefetch.places.length;
    }
    if (travelPrefetch?.airportUnavailable && travelPrefetch.airportCode) {
      const message = text(
        language,
        `Аэропорт ${travelPrefetch.airportCode} не найден в импортированном локальном снимке OpenStreetMap. Продолжить подбор мест только в Варшаве, без поиска рядом с аэропортом?`,
        `Airport ${travelPrefetch.airportCode} was not found in the imported local OpenStreetMap snapshot. Should I continue with Warsaw places only, without an airport-radius search?`,
      );
      const saveStartedAt = performance.now();
      await saveConversationTurn(conversationId, workspaceId, [
        ...conversationHistory,
        { role: "user", content: frame.message },
        { role: "assistant", content: message },
      ]);
      databaseDurationMs += Math.round(performance.now() - saveStartedAt);
      turnOutcome = "completed";
      emit({
        protocolVersion: 1, type: "turn.clarification", requestId: frame.requestId, conversationId, message, choices: [
          { id: "city-only", label: text(language, "Продолжить только по местам в Варшаве", "Continue with Warsaw places only") },
          { id: "stop-trip", label: text(language, "Остановить подбор", "Stop planning") },
        ]
      });
      return;
    }
    tripPlan = buildTripPlan(travelPrefetch, resolveTripPreferences([...relevantUserMessages, frame.message]));
    if (tripPlan) {
      const message = formatTripPlanMessage(tripPlan, placesFound, language);
      emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "composing", label: text(language, "Собираю план из проверенных точек", "Building a plan from verified places") });
      const saveStartedAt = performance.now();
      await saveConversationTurn(conversationId, workspaceId, [
        ...conversationHistory,
        { role: "user", content: frame.message },
        { role: "assistant", content: message },
      ]);
      databaseDurationMs += Math.round(performance.now() - saveStartedAt);
      turnOutcome = "completed";
      emit({ protocolVersion: 1, type: "assistant.delta", requestId: frame.requestId, text: message });
      emit({
        protocolVersion: 1, type: "turn.completed", requestId: frame.requestId, conversationId, assistantMessage: message, appliedFilters: [
          ...(allowedSourceIds?.length ? [{ key: "sourceIds", value: allowedSourceIds }] : []),
          ...(frame.scope.dateRange ? [{ key: "dateRange", value: frame.scope.dateRange }] : []),
          { key: "tool", value: "search_places" },
        ], result: {
          total: placesFound.length, records: [], places: placesFound, tripPlan, mapFeatures: {
            type: "FeatureCollection",
            features: placesFound.map((place) => ({ type: "Feature", geometry: { type: "Point", coordinates: [place.lon, place.lat] }, properties: { entityType: "place", id: place.id, sourceId: place.sourceId, label: place.name, category: place.category } })),
          }
        }, sources: travelSourceMetadata
      });
      return;
    }
    messages = [
      { role: "system", content: `${SYSTEM_PROMPT}\nResponse language: ${language === "ru" ? "Russian" : language === "de" ? "German" : "English"}. Always answer in this language.\nAllowed sources: ${allowedSourceIds?.length ? allowedSourceIds.join(", ") : "all available"}. Date range: ${frame.scope.dateRange?.from ?? "not set"} — ${frame.scope.dateRange?.to ?? "not set"}.` },
      ...(freshTravelRequest ? [] : conversationHistory),
      ...(selectedContext ? [{ role: "system" as const, content: `User-selected map object (verified from the local database; use it as the main referent for “this point” or “this place”):\n${JSON.stringify(selectedContext)}` }] : []),
      ...(travelPrefetch ? [{ role: "system" as const, content: `Verified backend prefetch results from the current OSM snapshot. These database rows override conflicting assumptions or older answers in history. Name 2–3 exact matches as snapshot examples, not recommendations. Do not claim that found objects are missing. Source metadata follows so you can state the snapshot date and attribution when relevant.\n${formatTravelPlacePrefetch(travelPrefetch)}\nSource metadata: ${JSON.stringify(travelSourceMetadata)}` }] : []),
      ...(tripPlan ? [{ role: "system" as const, content: `Deterministic trip plan from verified database place IDs. Follow the day numbers and stop IDs exactly. Route status "pending" means no route geometry or road metrics have been returned yet; never imply a route is ready or invent road distance/time. Do not expose raw enum values such as "pending" or "unavailable"; explain in plain language that the driving route is still being calculated or could not be calculated, while keeping verified stops visible. A "partial" plan means local search did not support every day or the bounded search was truncated.\n${JSON.stringify(tripPlan)}` }] : []),
      { role: "user", content: frame.message },
    ];
    const toolsForTurn = travelPrefetch
      ? assistantToolDefinitions.filter((tool) => tool.function.name !== "search_places")
      : assistantToolDefinitions;
    const toolCallLimit = travelPrefetch ? 5 : 3;
    emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "understanding", label: text(language, "Анализирую запрос", "Understanding your request") });
    let finalText = "";
    let finished = false;
    for (let iteration = 0; iteration < 4 && !finished; iteration += 1) {
      const modelCallStartedAt = performance.now();
      const response = await chat(messages, toolsForTurn, signal);
      const modelWallDurationMs = Math.round(performance.now() - modelCallStartedAt);
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
        wallDurationMs: modelWallDurationMs,
        ...response.metrics,
      });
      const assistantMessage = response.message;
      messages.push({ role: "assistant", content: assistantMessage.content ?? "", tool_calls: assistantMessage.tool_calls?.map((call, index) => ({ type: "function", function: { ...call.function, index } })) });
      const calls = assistantMessage.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = assistantMessage.content.trim();
        finished = true;
        break;
      }
      if (iteration === 3) throw new Error("Tool call limit exceeded");
      if (toolCallsExecuted + calls.length > toolCallLimit) throw new Error("Tool call limit exceeded");
      for (const call of calls) {
        toolCallsExecuted += 1;
        const toolCallName = call.function.name;
        if (!ALLOWED_TOOLS.includes(toolCallName as ToolName)) {
          messages.push({ role: "tool", tool_name: toolCallName, content: JSON.stringify({ error: "Tool is not allowlisted." }) });
          continue;
        }
        const toolName = toolCallName as ToolName;
        lastTool = toolName;
        emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "searching", label: text(language, "Ищу в локальной базе", "Searching the local database") });
        emit({ protocolVersion: 1, type: "tool.started", requestId: frame.requestId, tool: toolName, label: toolLabel(toolName, language) });
        const toolStartedAt = performance.now();
        const result = await executeAssistantTool(toolName, call.function.arguments, frame.scope, allowedSourceIds);
        toolDurationMs += Math.round(performance.now() - toolStartedAt);
        messages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(result.content) });
        if (result.records) {
          found = result.records;
          totalRecords = result.totalRecords ?? result.records.length;
        }
        if (result.places) {
          placesFound = [...new Map([...placesFound, ...result.places].map((place) => [place.id, place])).values()];
          totalPlaces = Math.max(totalPlaces, result.totalPlaces ?? result.places.length);
        }
        if (result.sourceIds) listedSourceIds = result.sourceIds;
        emit({ protocolVersion: 1, type: "tool.completed", requestId: frame.requestId, tool: toolName, recordsFound: result.resultsFound });
      }
    }
    if (!finalText) throw new Error("Model did not produce a final response");
    emit({ protocolVersion: 1, type: "turn.status", requestId: frame.requestId, phase: "composing", label: text(language, "Формирую ответ", "Writing the answer") });
    const sourceIds = [...new Set(found.map((record) => record.sourceId))];
    const allSourceIds = [...new Set([...sourceIds, ...placesFound.map((place) => place.sourceId), ...listedSourceIds])];
    const sources = await getSources(allSourceIds);
    messages.push({ role: "assistant", content: finalText });
    await saveConversationTurn(conversationId, workspaceId, messages);
    turnOutcome = "completed";
    emit({ protocolVersion: 1, type: "assistant.delta", requestId: frame.requestId, text: finalText });
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
      ], result: { total: totalRecords + totalPlaces, records: found, places: placesFound, ...(tripPlan ? { tripPlan } : {}), mapFeatures }, sources
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
      prefetchDurationMs,
      toolDurationMs,
      modelCallCount,
      modelDurationMs,
      promptEvaluationDurationMs,
      generationDurationMs,
      promptTokenCount,
      generatedTokenCount,
      prefetchPlaceCount,
    });
    modelBusy = false;
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
