import type { ClarificationField, ClientFrame, PlaceView, RecordView, ServerFrame, ToolName, TripPlan } from "@waypoint-ai/shared";
import { env } from "../config/env.js";
import { placeCoverage } from "../data/coverage.js";
import { getConversationMessages, getConversationPlaceIds, getConversationTripPlan, saveConversationTurn as saveTurnToHistory, type HistoryMessage } from "../data/conversation.repository.js";
import { recordTurn as journalTurn, type NewJournalEntry } from "../data/journal.repository.js";
import { getPlacesByIds, getSources } from "../data/record.repository.js";
import { enabledLessons, markLessonsApplied } from "../data/training.repository.js";
import { acquireInference, releaseInference } from "../llm/inference-gate.js";
import { chat, OllamaUnavailableError, type ChatMessage, type ChatOptions, type ToolDefinition } from "../llm/ollama.provider.js";
import { ALLOWED_TOOLS } from "../tools/allowlist.js";
import { assistantToolDefinitions, executeAssistantTool, type SearchArea, type ToolExecutionResult } from "../tools/assistant-tools.js";
import { EDIT_TRIP_PLAN_TOOL, editTripPlanToolDefinition } from "../tools/edit-trip-plan.js";
import { PLAN_TRIP_TOOL, planTripToolDefinition } from "../tools/plan-trip.js";
import { REPLY_TOOL, replyToolDefinition } from "../tools/reply.js";
import { ROUTE_PLACES_TOOL, routePlacesArgsValid, routePlacesToolDefinition } from "../tools/route-places.js";
import { normalizeToolArguments } from "../tools/search-events.js";
import { CitationRegistry, stripCitationRefs } from "./citations.js";
import { text, toolLabel } from "./copy.js";
import { buildLessonBlock, type AppliedLesson, type Lesson } from "./lessons.js";
import type { FollowUpContext } from "./follow-ups.js";
import { templateFollowUps, type FollowUpFacts } from "./follow-up-templates.js";
import { formatPlaceResultsMessage } from "./place-results-message.js";
import { classifyPlanIntent, type PlanIntent } from "./plan-intent.js";
import { executePlanTrip } from "./plan-trip.js";
import { buildRoutePlan, formatRoutePlacesMessage } from "./route-places.js";
import { parseRouterOutput, ROUTER_FORMAT, routerMessages } from "./router.js";
import { describePlanForModel, type TripPlanChange } from "./trip-plan-edit.js";
import { formatTripPlanEditMessage, formatTripPlanMessage } from "./trip-plan-message.js";
import { currentPlanPrompt, replyPrompt, selectedItemPrompt, systemPrompt, toolRequiredPrompt } from "./turn-prompts.js";
import { TurnMetrics, TurnReporter } from "./turn-reporter.js";
import { mapFeatures, notProcessedText, placeFeature, toolFailedDetail, turnFailure } from "./turn-result.js";
import { buildClarificationFields, eventDetailsQuestion, eventDetailsToAsk, tripDetailsQuestion, tripHasDays } from "./clarification.js";
import { applyAnswers, eventSources, planTripDependencies, resolveSelectedMapItem, runTripPlanEdit, selectionPoint, toolStepLabel } from "./turn-tools.js";

/** A router answer is one short JSON object. */
const ROUTER_MAX_TOKENS = 160;
/** A tool call needs well under this many tokens; a plain-text first answer is cut here and retried. */
const FIRST_STEP_MAX_TOKENS = 160;
/** Answers without data are short; the cap keeps a chatty reply from taking a minute on a laptop GPU. */
const REPLY_MAX_TOKENS = 320;
/** Tool calls one turn may make in total; the model gets at most four rounds. */
const TOOL_CALL_LIMIT = 4;

/** The journal is local working data; it can be switched off (JOURNAL_ENABLED=false). */
const recordTurn: typeof journalTurn = (entry) => (env.JOURNAL_ENABLED ? journalTurn(entry) : Promise.resolve());

export interface TurnOptions {
  /** Lessons to apply; null applies none (an exam run without lessons). Defaults to the enabled lessons. */
  lessons?: Lesson[] | null;
  /** Called with the lessons that reached the model. */
  onLessons?: (applied: AppliedLesson[]) => void;
  /** Called for every tool the model calls, with its parsed arguments (exam checks). */
  onToolCall?: (tool: string, args: unknown) => void;
  /** Exam turns are not stored in the conversation history. */
  ephemeral?: boolean;
  /**
   * Benchmark turns stop at the model's first tool call: the calls are reported through onToolCall and nothing is
   * executed or answered. A first answer without a tool call ends the turn too.
   */
  firstStepOnly?: boolean;
  /** Another installed model for this turn (benchmark comparisons); set only by the server. */
  model?: string;
  /**
   * The model that picks the first tool call from the short router prompt (assistant/router.ts); null uses the full
   * prompt. Defaults to ROUTER_MODEL. Set only by the server.
   */
  routerModel?: string | null;
  /** Called when the turn ends with an answer, with what follow-up suggestions are written from (chat turns only). */
  onFollowUp?: (context: FollowUpContext) => void;
}

type SubmitFrame = Extract<ClientFrame, { type: "turn.submit" }>;
type JournalCall = { tool: string; args: unknown; error?: string | null; resultCount?: number | null };
type ToolCall = NonNullable<ChatMessage["tool_calls"]>[number];
type EditablePlan = { plan: TripPlan; places: PlaceView[] };
type ToolOutcome = {
  lastPlaceSearch: { search: NonNullable<ToolExecutionResult["placeSearch"]>; places: PlaceView[]; total: number } | null;
  usedOtherDataTool: boolean;
  editedPlan: (EditablePlan & { changes: TripPlanChange[] }) | null;
  createdPlan: EditablePlan | null;
  /** The created plan is a route through the places of a search, not a planned trip. */
  routedPlaces: boolean;
  /** A question with one-time filters, asked instead of guessing a missing detail. */
  clarification: { message: string; fields: ClarificationField[] } | null;
};

export async function processTurn(
  submitted: SubmitFrame, conversationId: string, signal: AbortSignal,
  sendFrame: (event: ServerFrame) => void,
  options: TurnOptions = {},
): Promise<void> {
  const reporter = new TurnReporter(submitted.requestId, sendFrame);
  const emit = (event: ServerFrame) => reporter.emit(event);
  const language = submitted.scope.language ?? "en";
  // Values chosen in the fields of a clarification: checked against the server's options, applied to this turn only.
  const { frame, answered } = await applyAnswers(submitted, language);
  const refuse = (code: "source_unavailable" | "invalid_message" | "busy", message: string, retryable: boolean) => emit({ protocolVersion: 1, type: "turn.error", requestId: frame.requestId, code, message, retryable });
  if (frame.scope.polygonIds?.length) {
    refuse("source_unavailable", text(language, "Фильтр по области пока не подключён к данным сервера.", "Area filtering is not connected to the server data yet."), false);
    return;
  }
  if (frame.scope.dateRange?.from && frame.scope.dateRange.to && Date.parse(frame.scope.dateRange.from) > Date.parse(frame.scope.dateRange.to)) {
    refuse("invalid_message", text(language, "Начало периода должно быть раньше его окончания.", "The start date must be before the end date."), false);
    return;
  }
  if (!(await acquireInference())) {
    refuse("busy", text(language, "Помощник уже обрабатывает другой запрос. Попробуйте чуть позже.", "The assistant is already handling another request. Please try again shortly."), true);
    return;
  }

  const metrics = new TurnMetrics();
  const saveConversationTurn: typeof saveTurnToHistory = options.ephemeral ? async () => {} : saveTurnToHistory;
  // What the journal keeps of this turn: each tool call with its outcome, and how the turn ended.
  const journalCalls: JournalCall[] = [];
  const journal = { placeNotFound: null as string | null, retriedWithoutTool: false };
  let turnOutcome: "completed" | "cancelled" | "error" = "error";
  let found: RecordView[] = [];
  let totalRecords = 0;
  let placesFound: PlaceView[] = [];
  let searchArea: SearchArea | undefined;
  let totalPlaces = 0;
  let listedSourceIds: string[] = [];
  let lastTool: ToolName | undefined;
  let toolCallsExecuted = 0;
  // Refs (E1, P1) for the rows the model sees, so the answer can cite them and the server can check each citation.
  const citations = new CitationRegistry();
  const allowedSourceIds = frame.scope.sourceIds?.slice(0, 20);
  const workspaceId = frame.scope.workspaceId ?? "demo";
  let messages: ChatMessage[] = [];
  // The plan this conversation already shows; when set, the turn edits it instead of planning from scratch.
  let editablePlan: EditablePlan | null = null;
  let history: ChatMessage[] = [];
  // What this turn adds to the history after the user's message: each executed tool call with a short summary of its
  // result. The model then sees on later turns that answers came from tools, instead of answer texts to imitate.
  const historyCalls: HistoryMessage[] = [];
  const recordCall = (name: string, args: unknown, summary: Record<string, unknown>, placeIds?: string[]) => {
    historyCalls.push({ role: "assistant", content: "", tool_calls: [{ type: "function", function: { name, arguments: args } }] });
    historyCalls.push({ role: "tool", tool_name: name, content: JSON.stringify(summary), ...(placeIds?.length ? { placeIds } : {}) });
  };
  const turnHistory = (answer: string | null): HistoryMessage[] => [
    { role: "user", content: frame.message },
    ...historyCalls,
    // The fallback text of a failed turn is not kept: a small model would repeat it on the next turn.
    ...(answer && answer !== notProcessedText(language) ? [{ role: "assistant" as const, content: answer }] : []),
  ];

  const emitTripPlan = async (plan: TripPlan, places: PlaceView[], message: string, tool: ToolName) => {
    const sources = await getSources(plan.sourceIds);
    // The model sees the stored plan in full on the next turn, so history keeps only the reply's first paragraph
    // (what was built or changed) and the small context window is not filled with stop lists.
    await saveConversationTurn(conversationId, workspaceId, turnHistory(message.split("\n\n")[0]!), plan);
    turnOutcome = "completed";
    reporter.sections(message);
    followUp(message, `trip plan: ${plan.cities?.map((city) => city.name).join(", ") || plan.city}, ${plan.totalDays} days, ${plan.travelMode === "driving" ? "driving route per day" : "places only"}`, "trip");
    emit({
      protocolVersion: 1, type: "turn.completed", requestId: frame.requestId, conversationId, assistantMessage: message, appliedFilters: [
        ...(allowedSourceIds?.length ? [{ key: "sourceIds", value: allowedSourceIds }] : []),
        { key: "tool", value: tool },
      ], result: {
        total: places.length, records: [], places, tripPlan: plan, mapFeatures: { type: "FeatureCollection", features: places.map(placeFeature) },
      }, sources,
      suggestions: templateFollowUps({ topic: "trip", days: plan.totalDays, travelMode: plan.travelMode }, language),
    });
  };
  const callModel = async (callMessages: ChatMessage[], tools: ToolDefinition[], callOptions: ChatOptions = {}) => {
    const startedAt = performance.now();
    reporter.models.add(callOptions.model ?? options.model ?? env.OLLAMA_MODEL);
    const onToken = reporter.modelProgress();
    const response = await chat(callMessages, tools, signal, { ...(options.model ? { model: options.model } : {}), onToken, ...callOptions });
    metrics.addModelCall(response.metrics);
    console.info("Assistant model call performance", {
      requestId: frame.requestId,
      call: metrics.modelCallCount,
      model: env.OLLAMA_MODEL,
      wallDurationMs: Math.round(performance.now() - startedAt),
      ...response.metrics,
    });
    return response;
  };
  let streamed = false;
  const streamDelta = (fragment: string) => {
    streamed = true;
    reporter.delta(fragment);
  };
  const followUp = (answer: string, onMap: string | null, topic: FollowUpContext["topic"]) => options.onFollowUp?.({
    requestId: frame.requestId,
    language,
    question: submitted.message.slice(0, 400),
    previousQuestion: [...history].reverse().find((entry) => entry.role === "user")?.content.slice(0, 300) ?? null,
    answer: stripCitationRefs(answer).slice(0, 600),
    onMap,
    topic,
  });

  try {
    const databaseStartedAt = performance.now();
    const conversationHistory = await getConversationMessages(conversationId, workspaceId);
    history = conversationHistory;
    // The plan already on the map; the model decides whether this message changes it, replaces it, or is unrelated.
    const storedTripPlan = await getConversationTripPlan(conversationId, workspaceId);
    if (storedTripPlan) {
      editablePlan = { plan: storedTripPlan, places: await getPlacesByIds([...new Set(storedTripPlan.days.flatMap((day) => day.stopPlaceIds))]) };
    }
    const coverage = await placeCoverage().catch(() => "the imported regions");
    const selectedContext = await resolveSelectedMapItem(frame.scope.selectedMapItem, allowedSourceIds, frame.scope.dateRange);
    // Lessons are optional: a missing table or a database error must not stop the answer.
    const lessons = options.lessons === null ? null : buildLessonBlock(options.lessons ?? await enabledLessons().catch((error: unknown) => {
      console.warn("Lessons unavailable", { error: error instanceof Error ? error.message : error });
      return [];
    }), frame.message);
    metrics.addSince("database", databaseStartedAt);
    const planForModel = editablePlan ? describePlanForModel(editablePlan.plan, editablePlan.places) : null;
    messages = [
      { role: "system", content: systemPrompt(coverage, language, allowedSourceIds, frame.scope.dateRange) },
      ...(lessons ? [{ role: "system" as const, content: lessons.content }] : []),
      ...conversationHistory,
      ...(selectedContext ? [{ role: "system" as const, content: selectedItemPrompt(selectedContext) }] : []),
      ...(planForModel ? [{ role: "system" as const, content: currentPlanPrompt(planForModel) }] : []),
      { role: "user", content: frame.message },
    ];
    if (lessons) {
      const titles = lessons.applied.map((lesson) => lesson.title).join("; ");
      reporter.step(text(language, `Применены уроки: ${lessons.applied.length}`, `Lessons applied: ${lessons.applied.length}`)).done(titles);
      options.onLessons?.(lessons.applied);
      if (!options.ephemeral) void markLessonsApplied(lessons.applied.map((lesson) => lesson.id)).catch(() => undefined);
    }
    reporter.status("understanding", text(language, "Анализирую запрос", "Understanding your request"));
    // With a plan on the map, the model first classifies the message; the answering call then gets only the tools
    // that fit, which a small model uses far more reliably than the full list.
    let planIntent: PlanIntent | null = null;
    if (planForModel) {
      const intentStep = reporter.step(text(language, "Определяю, что сделать с планом на карте", "Working out what to do with the plan on the map"));
      planIntent = (await classifyPlanIntent(planForModel, conversationHistory, frame.message, (callMessages, format) => callModel(callMessages, [], { format }))).intent;
      intentStep.done(planIntent === "change_plan" ? text(language, "изменить план", "change the plan") : planIntent === "new_trip" ? text(language, "новая поездка", "a new trip") : text(language, "вопрос или поиск", "a question or a search"));
      console.info("Assistant plan intent", { requestId: frame.requestId, intent: planIntent });
    }
    if (planIntent === "change_plan") {
      // Earlier edits are stored as plain confirmations ("Added to day 1: …") because history drops tool calls.
      // A small model imitates them and confirms the next change in text without calling the tool, so the edit
      // call sees the user's messages and the current plan only.
      messages = messages.filter((entry) => entry.role === "system" || entry.role === "user");
    }
    const toolsForTurn = planIntent === "change_plan"
      ? [editTripPlanToolDefinition, replyToolDefinition]
      : planIntent === "new_trip"
        ? [planTripToolDefinition, replyToolDefinition]
        : editablePlan
          ? [planTripToolDefinition, editTripPlanToolDefinition, ...assistantToolDefinitions, routePlacesToolDefinition, replyToolDefinition]
          : [planTripToolDefinition, ...assistantToolDefinitions, routePlacesToolDefinition, replyToolDefinition];
    let finalText = "";
    let finished = false;
    let retriedWithoutTool = false;
    // What the tool calls produced; kept in one object because the tools run in closures.
    const produced: ToolOutcome = { lastPlaceSearch: null, usedOtherDataTool: false, editedPlan: null, createdPlan: null, routedPlaces: false, clarification: null };
    // A question this turn asked already is not asked again when the user answers it in their own words.
    const lastAssistant = [...conversationHistory].reverse().find((entry) => entry.role === "assistant" && !entry.tool_calls?.length)?.content ?? "";
    let replyRequested = false;
    let thinking = reporter.step(text(language, "Понимаю запрос", "Understanding the request"));
    const routerModel = options.routerModel === undefined ? env.ROUTER_MODEL ?? null : options.routerModel;
    const routeFirstStep = async (model: string) => {
      const response = await callModel(routerMessages(frame.message, Boolean(selectedContext)), [], { format: ROUTER_FORMAT, maxTokens: ROUTER_MAX_TOKENS, model });
      const decision = parseRouterOutput(response.message.content);
      console.info("Assistant router decision", { requestId: frame.requestId, model, ...(decision.ok ? { tool: decision.tool } : { error: decision.error }) });
      if (!decision.ok) return null;
      // A reply needs no tool, so the turn continues as if the model had called reply.
      return { ...response, message: { role: "assistant" as const, content: "", tool_calls: [{ function: { name: decision.tool, arguments: decision.args } }] } };
    };
    /** Runs one allowlisted tool with its status line, start and end frames, and progress step. */
    const runTool = async <T>(toolName: ToolName, call: ToolCall, statusLabel: string, execute: () => Promise<T>) => {
      reporter.status("searching", statusLabel);
      emit({ protocolVersion: 1, type: "tool.started", requestId: frame.requestId, tool: toolName, label: toolLabel(toolName, language) });
      const step = reporter.step(toolStepLabel(toolName, call.function.arguments, language));
      const startedAt = performance.now();
      const outcome = await execute();
      metrics.addSince("tool", startedAt);
      return { outcome, step, completed: (recordsFound: number) => emit({ protocolVersion: 1, type: "tool.completed", requestId: frame.requestId, tool: toolName, recordsFound }) };
    };
    const planTrip = async (call: ToolCall, journalCall: JournalCall) => {
      const { outcome, step, completed } = await runTool(PLAN_TRIP_TOOL, call, text(language, "Собираю план из проверенных точек", "Building a plan from verified places"),
        () => executePlanTrip(call.function.arguments, planTripDependencies(allowedSourceIds), allowedSourceIds));
      console.info("Assistant plan_trip call", { requestId: frame.requestId, arguments: call.function.arguments, outcome: outcome.kind });
      if (outcome.kind === "error") {
        journalCall.error = String(outcome.error).slice(0, 120);
        step.fail(toolFailedDetail(language));
      } else {
        if (outcome.kind === "planned") produced.createdPlan = { plan: outcome.plan, places: outcome.places };
        if (outcome.kind === "ask_route_mode") {
          const askDays = !answered.has("days") && !tripHasDays(call.function.arguments);
          produced.clarification = { message: tripDetailsQuestion(outcome.cities, askDays, language), fields: buildClarificationFields(askDays ? ["days", "travel"] : ["travel"], language) };
        }
        step.done(outcome.kind === "planned" ? text(language, `${outcome.plan.totalDays} дн., ${outcome.places.length} точек`, `${outcome.plan.totalDays} days, ${outcome.places.length} stops`) : text(language, "нужно выбрать маршрут", "route choice needed"));
      }
      messages.push({ role: "tool", tool_name: PLAN_TRIP_TOOL, content: JSON.stringify(outcome.kind === "error" ? { error: outcome.error } : { ok: true }) });
      if (outcome.kind !== "ask_route_mode") recordCall(PLAN_TRIP_TOOL, normalizeToolArguments(call.function.arguments), outcome.kind === "error" ? { error: outcome.error } : { ok: true, days: outcome.plan.totalDays, stops: outcome.places.length });
      completed(outcome.kind === "planned" ? outcome.places.length : 0);
    };
    const editTripPlan = async (call: ToolCall, journalCall: JournalCall) => {
      const current: { plan: TripPlan; places: PlaceView[]; changes?: TripPlanChange[] } | null = produced.editedPlan ?? editablePlan;
      const { outcome, step, completed } = await runTool(EDIT_TRIP_PLAN_TOOL, call, text(language, "Изменяю план поездки", "Updating the trip plan"),
        () => runTripPlanEdit(current, call.function.arguments, allowedSourceIds));
      console.info("Assistant edit_trip_plan call", { requestId: frame.requestId, arguments: call.function.arguments, ok: outcome.ok, ...(outcome.ok ? {} : { error: outcome.error }) });
      if (outcome.ok) {
        produced.editedPlan = { plan: outcome.plan, places: outcome.places, changes: [...(current?.changes ?? []), ...outcome.changes] };
        step.done();
      } else {
        journalCall.error = String(outcome.error).slice(0, 120);
        step.fail(toolFailedDetail(language));
      }
      messages.push({ role: "tool", tool_name: EDIT_TRIP_PLAN_TOOL, content: JSON.stringify(outcome.ok ? { ok: true, changes: outcome.changes } : { error: outcome.error }) });
      recordCall(EDIT_TRIP_PLAN_TOOL, normalizeToolArguments(call.function.arguments), outcome.ok ? { ok: true } : { error: outcome.error });
      completed(outcome.ok ? outcome.places.length : 0);
    };
    const routePlaces = async (call: ToolCall, journalCall: JournalCall) => {
      const { outcome, step, completed } = await runTool(ROUTE_PLACES_TOOL, call, text(language, "Строю маршрут по найденным местам", "Building a route through the found places"), async () => {
        if (!routePlacesArgsValid(call.function.arguments)) return { error: "route_places takes no arguments." };
        // The places of a search in this turn, or else those of the conversation's latest place search.
        let places = produced.lastPlaceSearch?.places ?? [];
        let label = produced.lastPlaceSearch?.search.city ?? null;
        if (!places.length) {
          const ids = await getConversationPlaceIds(conversationId, workspaceId);
          const byId = new Map((await getPlacesByIds(ids)).map((place) => [place.id, place]));
          places = ids.flatMap((id) => byId.get(id) ?? []);
          label = lastSearchCity(history);
        }
        if (places.length < 2) return { error: "There are no found places in this conversation to route through. Ask what to search for, or call search_places first." };
        const plan = buildRoutePlan(places, label);
        return { plan, places };
      });
      if ("error" in outcome) {
        journalCall.error = outcome.error;
        step.fail(toolFailedDetail(language));
      } else {
        produced.createdPlan = outcome;
        produced.routedPlaces = true;
        step.done(text(language, `${outcome.places.length} точек`, `${outcome.places.length} stops`));
      }
      messages.push({ role: "tool", tool_name: ROUTE_PLACES_TOOL, content: JSON.stringify("error" in outcome ? { error: outcome.error } : { ok: true }) });
      recordCall(ROUTE_PLACES_TOOL, {}, "error" in outcome ? { error: outcome.error } : { ok: true, days: outcome.plan.totalDays, stops: outcome.places.length });
      completed("error" in outcome ? 0 : outcome.places.length);
    };
    const searchData = async (toolName: ToolName, call: ToolCall, journalCall: JournalCall) => {
      // An earthquake search without a period would show the default week; the user picks the details instead.
      // Exam turns answer as asked, and a question already asked is not repeated.
      const missing = toolName === "search_events" && !options.ephemeral && !answered.has("period") && !frame.scope.dateRange?.from && !frame.scope.dateRange?.to && lastAssistant !== eventDetailsQuestion(language)
        ? eventDetailsToAsk(call.function.arguments, frame.message) : null;
      if (missing) {
        const sources = await eventSources().catch(() => []);
        produced.clarification = { message: eventDetailsQuestion(language), fields: buildClarificationFields([...missing, ...(sources.length > 1 ? ["sources" as const] : [])], language, sources) };
        messages.push({ role: "tool", tool_name: toolName, content: JSON.stringify({ askedUser: missing }) });
        reporter.step(toolStepLabel(toolName, call.function.arguments, language)).done(text(language, "нужны детали", "details needed"));
        return;
      }
      const { outcome: result, step, completed } = await runTool(toolName, call, text(language, "Ищу в локальной базе", "Searching the local database"),
        () => executeAssistantTool(toolName, call.function.arguments, frame.scope, allowedSourceIds, selectionPoint(selectedContext), frame.message));
      messages.push({ role: "tool", tool_name: toolName, content: JSON.stringify(citations.annotate(result.content, result)) });
      const resultError = result.content && typeof result.content === "object" && "error" in result.content ? String((result.content as { error: unknown }).error) : null;
      journalCall.error = resultError?.slice(0, 120) ?? null;
      journalCall.resultCount = resultError ? null : result.resultsFound;
      if (resultError === "place_not_found") journal.placeNotFound = String((result.content as { place?: unknown }).place ?? "").slice(0, 100) || null;
      if (result.records) {
        found = result.records;
        totalRecords = result.totalRecords ?? result.records.length;
      }
      if (result.placeSearch) produced.lastPlaceSearch = { search: result.placeSearch, places: result.places ?? [], total: result.totalPlaces ?? 0 };
      else produced.usedOtherDataTool = true;
      if (result.places) {
        placesFound = [...new Map([...placesFound, ...result.places].map((place) => [place.id, place])).values()];
        totalPlaces = Math.max(totalPlaces, result.totalPlaces ?? result.places.length);
      }
      if (result.sourceIds) listedSourceIds = result.sourceIds;
      if (result.searchArea) searchArea = result.searchArea;
      recordCall(toolName, normalizeToolArguments(call.function.arguments), historySummary(result, resultError), result.placeSearch ? result.places?.map((place) => place.id) : undefined);
      completed(result.resultsFound);
      if (resultError !== null) step.fail(toolFailedDetail(language));
      else step.done(text(language, `найдено: ${result.resultsFound}`, `found: ${result.resultsFound}`));
    };
    const placeResults = (search: NonNullable<typeof produced.lastPlaceSearch>) => formatPlaceResultsMessage(search.search, search.places, search.total, language, (place) => citations.citePlace(place));

    for (let iteration = 0; iteration < 4 && !finished; iteration += 1) {
      // After events, records, or sources were fetched, the model's answer is the reply itself, so it is streamed.
      // First steps are not: a plain-text first answer may be withheld, and place and plan replies come from rows.
      const streamAnswer = toolCallsExecuted > 0 && produced.usedOtherDataTool;
      const writing = streamAnswer ? reporter.step(text(language, "Пишу ответ", "Writing the answer")) : null;
      // The first call only has to choose a tool; a short token budget stops a small model that starts writing a
      // long plain-text answer instead (that text would be withheld anyway) from costing a minute.
      // The router picks the first call from a short prompt; a reply, an invalid answer, or a plan on the map (which
      // needs the plan in the prompt) goes the usual way.
      const routed = iteration === 0 && !retriedWithoutTool && routerModel && !editablePlan ? await routeFirstStep(routerModel) : null;
      const response = routed ?? await callModel(messages, toolsForTurn, {
        ...(streamAnswer ? { onDelta: streamDelta } : {}),
        ...(toolCallsExecuted === 0 && !retriedWithoutTool && planIntent !== "other" ? { maxTokens: FIRST_STEP_MAX_TOKENS } : {}),
      });
      thinking.done();
      writing?.done();
      const assistantMessage = response.message;
      messages.push({ role: "assistant", content: assistantMessage.content ?? "", tool_calls: assistantMessage.tool_calls?.map((call, index) => ({ type: "function", function: { ...call.function, index } })) });
      const calls = assistantMessage.tool_calls ?? [];
      if (options.firstStepOnly) {
        for (const call of calls) options.onToolCall?.(call.function.name, normalizeToolArguments(call.function.arguments));
        turnOutcome = "completed";
        emit({ protocolVersion: 1, type: "turn.completed", requestId: frame.requestId, conversationId, assistantMessage: calls.length ? "" : assistantMessage.content.trim(), appliedFilters: [], result: { total: 0, records: [], mapFeatures: { type: "FeatureCollection", features: [] } }, sources: [] });
        return;
      }
      if (calls.length === 0) {
        // The first step must be a tool call: a data tool, or reply for messages that need no data. A plain-text
        // first answer skipped the lookup and could name places that are not in the database, so it is retried once.
        if (toolCallsExecuted === 0 && !retriedWithoutTool) {
          retriedWithoutTool = true;
          journal.retriedWithoutTool = true;
          console.warn("Assistant answered without a tool call; retrying", { requestId: frame.requestId, text: assistantMessage.content.slice(0, 300) });
          // The unverified text is dropped so it is neither shown nor stored in the history.
          messages.pop();
          thinking = reporter.step(text(language, "Уточняю, какие данные нужны", "Checking which data is needed"));
          messages.push({ role: "system", content: toolRequiredPrompt(Boolean(editablePlan)) });
          continue;
        }
        // After the retry, a plain-text first answer is still unverified: it may claim a change or name places that
        // no tool returned, so it is not shown. Text after tool results is the normal final answer.
        // After an empty place search the model may answer in text; the answer still comes from the search.
        if (produced.lastPlaceSearch && !produced.usedOtherDataTool) {
          finalText = placeResults(produced.lastPlaceSearch);
          messages.splice(messages.length - 1, 1, { role: "assistant", content: finalText.split("\n\n")[0]! });
          finished = true;
          break;
        }
        const unverified = toolCallsExecuted === 0 && planIntent !== "other";
        finalText = unverified ? notProcessedText(language) : assistantMessage.content.trim();
        if (unverified) {
          console.warn("Assistant answered without a tool call twice; reply withheld", { requestId: frame.requestId, text: assistantMessage.content.slice(0, 300) });
          messages.splice(messages.length - 1, 1, { role: "assistant", content: finalText });
        }
        finished = true;
        break;
      }
      if (iteration === 3) throw new Error("Tool call limit exceeded");
      if (toolCallsExecuted + calls.length > TOOL_CALL_LIMIT) throw new Error("Tool call limit exceeded");
      for (const call of calls) {
        toolCallsExecuted += 1;
        const toolCallName = call.function.name;
        console.info("Assistant tool call", { requestId: frame.requestId, iteration, tool: toolCallName, arguments: call.function.arguments });
        options.onToolCall?.(toolCallName, normalizeToolArguments(call.function.arguments));
        const journalCall: JournalCall = { tool: toolCallName, args: normalizeToolArguments(call.function.arguments) };
        journalCalls.push(journalCall);
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
        if (toolName === PLAN_TRIP_TOOL) await planTrip(call, journalCall);
        else if (toolName === EDIT_TRIP_PLAN_TOOL) await editTripPlan(call, journalCall);
        else if (toolName === ROUTE_PLACES_TOOL) await routePlaces(call, journalCall);
        else await searchData(toolName, call, journalCall);
        if (produced.clarification) break;
      }
      // A new or edited plan is described from verified rows; the model is not asked to retell it.
      if (finished || produced.createdPlan || produced.editedPlan || produced.clarification) break;
      // Place results are listed from the rows as well, so the answer cannot name places the search did not return.
      // An empty first search goes back to the model once, which can retry with another spelling or kind.
      if (produced.lastPlaceSearch && !produced.usedOtherDataTool && (produced.lastPlaceSearch.places.length || iteration > 0)) {
        finalText = placeResults(produced.lastPlaceSearch);
        placesFound = produced.lastPlaceSearch.places;
        totalPlaces = produced.lastPlaceSearch.total;
        messages.push({ role: "assistant", content: finalText.split("\n\n")[0]! + (produced.lastPlaceSearch.places.length ? ` ${produced.lastPlaceSearch.places.map((place) => place.name).join("; ")}` : "") });
        finished = true;
        break;
      }
    }
    if (replyRequested) {
      // The model chose to answer without data. The answer is written by a separate, tool-free call with a short
      // prompt: given the full prompt, which says every answer starts with a tool call, a small model writes a tool
      // call as text instead of an answer.
      messages.pop();
      const writing = reporter.step(text(language, "Пишу ответ", "Writing the answer"));
      const response = await callModel([
        { role: "system", content: replyPrompt(language, planForModel, coverage) },
        ...(lessons ? [{ role: "system" as const, content: lessons.content }] : []),
        ...messages.filter((entry) => (entry.role === "user" || entry.role === "assistant") && !entry.tool_calls?.length),
      ], [], { maxTokens: REPLY_MAX_TOKENS, onDelta: streamDelta });
      writing.done();
      finalText = response.message.content.trim();
      // A tool call written as text is not an answer; the streamed text is replaced by the final message.
      if (!finalText || /^[a-z_]+\s*[({]/i.test(finalText)) finalText = notProcessedText(language);
      messages.push({ role: "assistant", content: finalText });
    }
    if (produced.clarification) {
      const { message, fields } = produced.clarification;
      await saveConversationTurn(conversationId, workspaceId, [{ role: "user", content: frame.message }, { role: "assistant", content: message }]);
      turnOutcome = "completed";
      emit({ protocolVersion: 1, type: "turn.clarification", requestId: frame.requestId, conversationId, message, choices: [], fields });
      return;
    }
    const { createdPlan: newPlan, editedPlan: changedPlan } = produced;
    if (newPlan || changedPlan) reporter.step(text(language, "Собираю ответ из проверенных данных", "Assembling the answer from verified data")).done();
    if (newPlan) {
      if (produced.routedPlaces) await emitTripPlan(newPlan.plan, newPlan.places, formatRoutePlacesMessage(newPlan.plan, newPlan.places, language), ROUTE_PLACES_TOOL);
      else await emitTripPlan(newPlan.plan, newPlan.places, formatTripPlanMessage(newPlan.plan, newPlan.places, language), PLAN_TRIP_TOOL);
      return;
    }
    if (changedPlan) {
      await emitTripPlan(changedPlan.plan, changedPlan.places, formatTripPlanEditMessage(changedPlan.changes, changedPlan.plan, changedPlan.places, language), EDIT_TRIP_PLAN_TOOL);
      return;
    }
    if (!finalText) throw new Error("Model did not produce a final response");
    const cited = citations.resolve(finalText);
    finalText = cited.text;
    reporter.status("composing", text(language, "Формирую ответ", "Writing the answer"));
    // A follow-up that searched nothing keeps the current plan on the map.
    const keepPlan = editablePlan && !found.length && !placesFound.length && !searchArea ? editablePlan : null;
    if (keepPlan) {
      placesFound = keepPlan.places;
      totalPlaces = keepPlan.places.length;
    }
    const sourceIds = [...new Set(found.map((record) => record.sourceId))];
    const allSourceIds = [...new Set([...sourceIds, ...placesFound.map((place) => place.sourceId), ...listedSourceIds])];
    const sources = await getSources(allSourceIds);
    // A place list is kept as its first line and the names; the rows themselves are in the tool summary.
    const placeAnswer = produced.lastPlaceSearch && !produced.usedOtherDataTool ? finalText.split("\n\n")[0]! : null;
    await saveConversationTurn(conversationId, workspaceId, turnHistory(stripCitationRefs(placeAnswer ?? finalText)));
    turnOutcome = "completed";
    if (!streamed) reporter.sections(finalText);
    const keptPlan = keepPlan ? `trip plan: ${keepPlan.plan.city}, ${keepPlan.plan.totalDays} days` : null;
    // What the follow-ups are built from: the turn's last search and its validated arguments.
    const followUpFacts = (): FollowUpFacts => {
      if (lastTool === "search_events") {
        const args = ([...journalCalls].reverse().find((call) => call.tool === "search_events")?.args ?? {}) as { hours?: unknown; minMagnitude?: unknown; place?: unknown };
        return {
          topic: "events",
          place: searchArea?.label ?? (typeof args.place === "string" ? args.place.slice(0, 100) : null),
          radiusKm: searchArea?.radiusKm ?? null,
          hours: typeof args.hours === "number" ? args.hours : null,
          minMagnitude: typeof args.minMagnitude === "number" ? args.minMagnitude : null,
        };
      }
      if (keepPlan) return { topic: "trip", days: keepPlan.plan.totalDays, travelMode: keepPlan.plan.travelMode };
      const search = produced.lastPlaceSearch;
      if (search && !produced.usedOtherDataTool) {
        const city = search.search.city ?? search.places.find((place) => place.city)?.city ?? null;
        return { topic: "places", city, kind: search.search.kind, shown: search.places.length, total: search.total, offset: search.search.offset };
      }
      return { topic: "other" };
    };
    followUp(finalText, found.length
      ? `${totalRecords} earthquakes${searchArea ? ` within ${searchArea.radiusKm} km of ${searchArea.label}` : ""}`
      : placesFound.length && !keepPlan
        ? `${totalPlaces} places (${[...new Set(placesFound.map((place) => place.category?.split(":").at(-1)).filter(Boolean))].slice(0, 3).join(", ")}) in ${[...new Set(placesFound.map((place) => place.city).filter(Boolean))].slice(0, 2).join(", ") || "the found area"}`
        : keptPlan, found.length ? "events" : placesFound.length && !keepPlan ? "places" : keepPlan ? "trip" : "other");
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
        ...(keepPlan ? { tripPlan: keepPlan.plan } : {}),
        ...(searchArea ? { searchArea } : {}),
        mapFeatures: mapFeatures(found, placesFound),
      }, sources,
      ...(cited.citations.length ? { citations: cited.citations, citationsMode: cited.citationsMode } : {}),
      suggestions: templateFollowUps(followUpFacts(), language),
    });
  } catch (error) {
    if (signal.aborted) {
      turnOutcome = "cancelled";
      emit({ protocolVersion: 1, type: "turn.cancelled", requestId: frame.requestId });
      return;
    }
    const code = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : error instanceof OllamaUnavailableError ? "model_unavailable" : "internal_error";
    console.error("Assistant turn failed", { requestId: frame.requestId, error: error instanceof Error ? error.stack ?? error.message : error });
    emit({ protocolVersion: 1, type: "turn.error", requestId: frame.requestId, code, message: turnFailure(code, frame.requestId, language), retryable: true });
  } finally {
    if (!options.ephemeral) {
      void recordTurn(journalEntry(frame, { conversationId, workspaceId, model: options.model ?? env.OLLAMA_MODEL, calls: journalCalls, ending: reporter.ending, ...journal, durationMs: metrics.elapsedMs() }))
        .catch((error: unknown) => console.warn("Journal write failed", { error: error instanceof Error ? error.message : error }));
    }
    console.info("Assistant turn performance", { requestId: frame.requestId, outcome: turnOutcome, model: env.OLLAMA_MODEL, ...metrics.summary() });
    releaseInference();
  }
}

/** What the history keeps of a search: counts and names, enough for "more", "these places", or "the same again". */
function historySummary(result: ToolExecutionResult, error: string | null): Record<string, unknown> {
  if (error) return { error };
  if (result.placeSearch) {
    const places = result.places ?? [];
    return { total: result.totalPlaces ?? places.length, shown: places.length, ...(result.placeSearch.offset ? { offset: result.placeSearch.offset } : {}), places: places.map((place) => place.name) };
  }
  if (result.records) return { total: result.totalRecords ?? result.records.length, shown: result.records.length, ...(result.searchArea ? { area: `${result.searchArea.radiusKm} km around ${result.searchArea.label}` } : {}) };
  if (result.sourceIds) return { sources: result.sourceIds.length };
  return { found: result.resultsFound };
}

/** The city of the conversation's latest place search, as the model named it. */
function lastSearchCity(history: ChatMessage[]): string | null {
  for (const entry of [...history].reverse()) {
    const call = entry.tool_calls?.find((item) => item.function.name === "search_places");
    if (!call) continue;
    const args = normalizeToolArguments(call.function.arguments) as { city?: unknown } | null;
    return typeof args?.city === "string" ? args.city.slice(0, 120) : null;
  }
  return null;
}

/** The journal row of a turn: its tool calls with their outcomes, how it ended, and the signals of a likely failure. */
function journalEntry(frame: SubmitFrame, turn: {
  conversationId: string; workspaceId: string; model: string; calls: JournalCall[]; ending: TurnReporter["ending"];
  placeNotFound: string | null; retriedWithoutTool: boolean; durationMs: number;
}): NewJournalEntry {
  const dataCalls = turn.calls.filter((call) => call.tool !== REPLY_TOOL && call.tool !== "list_sources");
  return {
    requestId: frame.requestId,
    conversationId: turn.conversationId,
    workspaceId: turn.workspaceId,
    language: frame.scope.language ?? "en",
    message: frame.message,
    model: turn.model,
    toolCalls: turn.calls,
    firstTool: turn.calls[0]?.tool ?? null,
    outcome: turn.ending.cancelled ? "cancelled" : turn.ending.errorCode ? "error" : turn.ending.clarification ? "clarification" : "completed",
    errorCode: turn.ending.errorCode,
    signals: {
      ...(dataCalls.some((call) => call.resultCount === 0) ? { emptyResult: true } : {}),
      ...(turn.placeNotFound ? { placeNotFound: turn.placeNotFound } : {}),
      ...(turn.calls.some((call) => call.error && /invalid|unknown|unsupported/i.test(call.error)) ? { invalidArgs: true } : {}),
      ...(turn.retriedWithoutTool ? { retriedWithoutTool: true } : {}),
    },
    durationMs: turn.durationMs,
  };
}
