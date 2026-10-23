import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Activity, MapPin, MessageSquare } from "lucide-react";
import type { Citation, ClarificationAnswer, PlaceView, RecordView, SourceView, SuggestedRequest, TripPlan, SearchArea } from "@waypoint-ai/shared";
import MapPanel, { type MapLayers, type PulseRequest } from "../../widgets/map/MapPanel";
import { EMPTY_SCENE, type MapScene } from "../../widgets/map/map-scene";
import { useCachedQuery } from "../../shared/data-cache";
import { eventQueryParams, searchEvents } from "../../shared/api/investigations";
import { clearAssistantHistory, loadCapabilities, loadDataSources, type Capabilities, type ConnectionState } from "../../shared/api/client";
import { createAssistantConnection, type AssistantConnection, type ReconnectInfo } from "../../shared/api/assistantSocket";
import { readLanguage, saveLanguage, translate, type Language } from "../../shared/i18n";
import { pageTitle } from "../../shared/routing";
import AppRail from "../../shared/ui/AppRail";
import { usePopoverDismiss } from "../../shared/ui/usePopoverDismiss";
import MicButton, { voiceStatusText } from "../voice/MicButton";
import { isVoiceFrame, useVoiceInput } from "../voice/useVoiceInput";
import { AnswerFeedback } from "../training/JournalTab";
import ImportLayer from "../imports/ImportLayer";
import { importStore } from "../imports/import-store";
import HomeDashboard from "./HomeDashboard";
import { compactResult, lastUserMessage, readSavedConversation, writeSavedConversation, type ChatResult, type Message, type SavedChat, type TurnStep } from "./chat-storage";
import { connectionLabel, conversationTitle, elapsedSince, endStreaming, joinDraft, welcomeMessage } from "./chat-utils";
import { applyProgressFrame, applyStepFrame, finishSteps } from "./turn-steps";
import { useAppNavigation } from "./useAppNavigation";
import { useChatScroll } from "./useChatScroll";
import { ChatComposer, ChatHeader } from "./ChatControls";
import { ClarificationForm, SuggestionChips } from "./ChatFollowUps";
import { AnswerCard, LiveTurnCard, UserBubble } from "./ChatCards";
import CitationList from "./CitationList";
import { contextSuggestions, starterSuggestions } from "./suggestions";

const MarkdownMessage = lazy(() => import("./MarkdownMessage"));
/** The server gives up on follow-ups after 45 s; the client waits a little longer before showing its own. */
const FOLLOW_UPS_WAIT_MS = 50_000;
// The events and places modes of the map page and the other pages load on first use, so they do not grow the
// initial bundle.
const EventsPanel = lazy(() => import("../investigation/EventsPanel"));
const PlacesPanel = lazy(() => import("../map/PlacesPanel"));
const DataPage = lazy(() => import("../data/DataPage"));
const ModelPage = lazy(() => import("../training/ModelPage"));

/** The question offered for a place or event handed to the assistant. */
const askQuestion = (language: Language, kind: "place" | "record") => kind === "record"
  ? translate(language, "Были ли ещё землетрясения в радиусе 30 км от выбранной точки на карте за последние 30 дней?", "Were there other earthquakes within 30 km of the selected map point in the last 30 days?")
  : translate(language, "Были ли землетрясения в радиусе 50 км от выбранной точки на карте за последние 30 дней?", "Were there earthquakes within 50 km of the selected map point in the last 30 days?");

export default function AssistantWorkspace() {
  const [language, setLanguage] = useState<Language>(readLanguage);
  const { activePage, visitedPages, setActivePage, mapMode, visitedModes, setMapMode } = useAppNavigation();
  const [savedConversation] = useState(() => readSavedConversation(welcomeMessage(language)));
  const socketRef = useRef<WebSocket | null>(null);
  const requestStartedAtRef = useRef<number | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [reconnectInfo, setReconnectInfo] = useState<ReconnectInfo>(null);
  // Radius applied by the search_events tool in the latest answer; drawn on the map.
  const [searchArea, setSearchArea] = useState<SearchArea | null>(savedConversation.result?.searchArea ?? null);
  // Bumped on every successful (re)connect so readiness and sources are reloaded after a server restart.
  const [metadataVersion, setMetadataVersion] = useState(0);
  const connectionRef = useRef<AssistantConnection | null>(null);
  const connectedBeforeRef = useRef(false);
  const [pending, setPending] = useState(false);
  /** When the running turn was sent (epoch ms), for the live card's timer. */
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [turnSteps, setTurnSteps] = useState<TurnStep[]>([]);
  const turnStepsRef = useRef<TurnStep[]>([]);
  const [messages, setMessages] = useState<Message[]>(savedConversation.messages);
  const [localChatId, setLocalChatId] = useState(savedConversation.id);
  const [recentChats, setRecentChats] = useState<SavedChat[]>(savedConversation.recentChats);
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const voiceBaseDraftRef = useRef("");
  const applyVoiceTranscript = useCallback((transcript: string) => {
    setDraft(joinDraft(voiceBaseDraftRef.current, transcript));
  }, []);
  const voice = useVoiceInput({ socketRef, connection, language, onTranscript: applyVoiceTranscript });
  const voiceFrameHandlerRef = useRef(voice.handleFrame);
  const focusComposerOnWorkspaceRef = useRef(false);
  const [conversationId, setConversationId] = useState<string | null>(savedConversation.conversationId);
  const [historyClearWarning, setHistoryClearWarning] = useState<string | null>(null);
  const [historyResetPending, setHistoryResetPending] = useState(false);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourceLoadFailed, setSourceLoadFailed] = useState(false);
  const [appliedFilters, setAppliedFilters] = useState<Array<Record<string, unknown>>>(savedConversation.result?.appliedFilters ?? []);
  const [resultSources, setResultSources] = useState<SourceView[]>(savedConversation.result?.sources ?? []);
  const [mapPlaces, setMapPlaces] = useState<PlaceView[]>(savedConversation.result?.places ?? []);
  const [mapRecords, setMapRecords] = useState<RecordView[]>(savedConversation.result?.records ?? []);
  const [tripPlan, setTripPlan] = useState<TripPlan | null>(savedConversation.result?.tripPlan ?? null);
  const [resultsLoaded, setResultsLoaded] = useState(Boolean(savedConversation.result));
  const [selectedResultKey, setSelectedResultKey] = useState<string | null>(null);
  // A place or event handed to the assistant from another mode or page: shown and selected on the map without
  // replacing the chat's results, so the next question can refer to it.
  const [pinned, setPinned] = useState<{ place?: PlaceView; record?: RecordView; revision: number } | null>(null);
  const [eventsScene, setEventsScene] = useState<MapScene>(EMPTY_SCENE);
  const [placesScene, setPlacesScene] = useState<MapScene>(EMPTY_SCENE);
  const eventsSelectRef = useRef<((key: string) => void) | null>(null);
  const placesSelectRef = useRef<((key: string) => void) | null>(null);
  const [mapLayers, setMapLayers] = useState<MapLayers>({ places: true, events: false });
  const [citationPulse, setCitationPulse] = useState<PulseRequest | null>(null);
  const [resetViewportRevision, setResetViewportRevision] = useState(0);
  const [lastSubmittedQuery, setLastSubmittedQuery] = useState(() => lastUserMessage(savedConversation.messages));
  // The request whose result is on the map, shown above it; the map keeps it while the next turn runs.
  const [resultQuery, setResultQuery] = useState(() => savedConversation.result ? lastUserMessage(savedConversation.messages) : "");
  const submittedQueryRef = useRef("");
  // Follow-up requests of the latest answer, written by the model right after it; null when none are coming.
  const [followUps, setFollowUps] = useState<{ requestId: string; status: "loading" | "none" } | null>(null);
  // The server always answers, but a dropped connection would leave the placeholders; they give way after a while.
  useEffect(() => {
    if (followUps?.status !== "loading") return;
    const timer = window.setTimeout(() => setFollowUps((current) => current?.status === "loading" ? { ...current, status: "none" } : current), FOLLOW_UPS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [followUps]);
  const chatScroll = useChatScroll({ visible: activePage === "workspace" && mapMode === "assistant", chatId: localChatId, changes: [messages, pending, progressLabel] });
  usePopoverDismiss();

  useEffect(() => {
    setSourcesLoading(true);
    setSourceLoadFailed(false);
    const abort = new AbortController();
    loadCapabilities(abort.signal).then(setCapabilities).catch(() => setCapabilities(null));
    loadDataSources(abort.signal).then((loadedSources) => {
      if (abort.signal.aborted) return;
      setSources(loadedSources);
      setSourceLoadFailed(false);
    }).catch(() => { if (!abort.signal.aborted) setSourceLoadFailed(true); }).finally(() => { if (!abort.signal.aborted) setSourcesLoading(false); });
    return () => abort.abort();
  }, [metadataVersion]);

  useEffect(() => {
    const setSteps = (steps: TurnStep[]) => {
      turnStepsRef.current = steps;
      setTurnSteps(steps);
    };
    /** Ends the running turn on the client: how long it took and the steps to keep on its message. */
    const endTurn = () => {
      const durationMs = elapsedSince(requestStartedAtRef.current);
      requestStartedAtRef.current = null;
      setPending(false);
      setActiveRequestId(null);
      setProgressLabel(null);
      setTurnStartedAt(null);
      const steps = finishSteps(turnStepsRef.current);
      setSteps([]);
      return { durationMs, steps };
    };
    const connection = createAssistantConnection({
      onFrame: (frame) => {
        if (isVoiceFrame(frame)) {
          voiceFrameHandlerRef.current(frame);
          return;
        }
        switch (frame.type) {
          case "session.ready":
            setCapabilities({ assistantStatus: frame.assistantStatus, modelLabel: frame.modelLabel, demoMode: frame.demoMode, voiceInput: frame.voiceInput });
            break;
          case "import.progress":
            importStore.upsert(frame.job, true);
            break;
          case "turn.status":
          case "tool.started":
            setProgressLabel(frame.label);
            break;
          case "turn.step":
            setSteps(applyStepFrame(turnStepsRef.current, frame));
            break;
          case "turn.progress":
            setSteps(applyProgressFrame(turnStepsRef.current, frame));
            break;
          case "turn.accepted":
            setConversationId(frame.conversationId);
            break;
          case "assistant.delta":
            setMessages((current) => {
              const last = current.at(-1);
              if (last?.streaming) return [...current.slice(0, -1), { ...last, text: last.text + frame.text }];
              return [...current, { role: "assistant", text: frame.text, streaming: true }];
            });
            break;
          case "turn.error": {
            const { durationMs, steps } = endTurn();
            setMessages((current) => [...endStreaming(current), { role: "assistant", kind: "error", text: frame.message, durationMs, steps, at: Date.now(), ...(frame.retryable ? { query: submittedQueryRef.current } : {}) }]);
            break;
          }
          case "turn.clarification": {
            const { durationMs, steps } = endTurn();
            setConversationId(frame.conversationId);
            setMessages((current) => [...endStreaming(current), { role: "assistant", kind: "clarification", text: frame.message, choices: frame.choices, ...(frame.fields?.length ? { fields: frame.fields } : {}), durationMs, steps, at: Date.now() }]);
            break;
          }
          case "turn.cancelled": {
            const { durationMs, steps } = endTurn();
            setMessages((current) => [...endStreaming(current), { role: "assistant", kind: "cancelled", text: translate(readLanguage(), "Запрос остановлен.", "Request stopped."), durationMs, steps, at: Date.now(), query: submittedQueryRef.current }]);
            break;
          }
          case "turn.completed": {
            const { durationMs, steps } = endTurn();
            setConversationId(frame.conversationId);
            setMapPlaces(frame.result.places ?? []);
            setMapRecords(frame.result.records);
            setResultQuery(submittedQueryRef.current);
            setTripPlan(frame.result.tripPlan ?? null);
            setSearchArea(frame.result.searchArea ?? null);
            setResultsLoaded(true);
            setSelectedResultKey(null);
            setAppliedFilters(frame.appliedFilters);
            setResultSources(frame.sources);
            const result = { places: frame.result.places?.length ?? 0, records: frame.result.records.length, tripDays: frame.result.tripPlan?.totalDays ?? null };
            const reply: Message = {
              role: "assistant", kind: "answer", text: frame.assistantMessage, durationMs, steps, requestId: frame.requestId, at: Date.now(),
              ...(frame.models?.length ? { models: frame.models } : {}),
              ...(result.places || result.records || result.tripDays ? { result } : {}),
              ...(frame.citations?.length ? { citations: frame.citations, citationsMode: frame.citationsMode ?? "cited" } : {}),
            };
            // The streamed text is replaced by the final message, which is the authoritative version.
            setMessages((current) => current.at(-1)?.streaming ? [...current.slice(0, -1), reply] : [...current, reply]);
            // The model writes follow-up requests next; until they come, the answer shows placeholders.
            setFollowUps({ requestId: frame.requestId, status: "loading" });
            break;
          }
          case "turn.suggestions": {
            const suggestions = frame.suggestions;
            setFollowUps((current) => current?.requestId === frame.requestId ? (suggestions.length ? null : { requestId: frame.requestId, status: "none" }) : current);
            if (suggestions.length) setMessages((current) => current.map((message) => message.requestId === frame.requestId ? { ...message, suggestions } : message));
            break;
          }
        }
      },
      onState: (state, reconnect) => {
        setConnection(state);
        setReconnectInfo(reconnect);
      },
      onOpen: (socket) => {
        socketRef.current = socket;
        socket.send(JSON.stringify({ protocolVersion: 1, type: "session.start", requestId: crypto.randomUUID() }));
        // The first load happens on mount; reload only after a reconnect.
        if (connectedBeforeRef.current) setMetadataVersion((version) => version + 1);
        connectedBeforeRef.current = true;
      },
      onClose: () => {
        socketRef.current = null;
        // A turn that was running is lost with the connection; it is not resent automatically.
        if (requestStartedAtRef.current !== null) {
          const { durationMs, steps } = endTurn();
          setMessages((current) => [...endStreaming(current), {
            role: "assistant", kind: "lost", at: Date.now(), query: submittedQueryRef.current, steps, durationMs,
            text: translate(readLanguage(), "Соединение с сервером прервалось, запрос не завершён. Отправьте его ещё раз после переподключения.", "The connection to the server was lost before the request finished. Send it again once reconnected."),
          }]);
        }
        setPending(false);
        setActiveRequestId(null);
        setProgressLabel(null);
      },
    });
    connectionRef.current = connection;
    return () => {
      connection.close();
      connectionRef.current = null;
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    voiceFrameHandlerRef.current = voice.handleFrame;
  }, [voice.handleFrame]);

  // Background events layer of the assistant map: the last week, up to one page. It stays loaded while another mode
  // is shown, so the kept-alive map does not redraw its markers on the way back.
  const eventsLayer = useCachedQuery(visitedModes.has("assistant") && mapLayers.events ? "map:events-layer" : null, () => searchEvents(eventQueryParams({ days: 7, minMagnitude: null, sourceIds: [], near: null, limit: 200 })), 5 * 60_000);
  const sourceLabels = Object.fromEntries(sources.map((source) => [source.id, source.label]));
  // A citation can be shown on the map only while its row is among the results there (older answers' rows are not).
  const citationOnMap = (citation: Citation) => citation.entityType === "place"
    ? mapPlaces.some((place) => place.id === citation.id)
    : mapRecords.some((record) => record.id === citation.id);
  const showCitation = (citation: Citation) => {
    if (!citationOnMap(citation)) return;
    setMapMode("assistant");
    const key = `${citation.entityType}:${citation.id}`;
    setSelectedResultKey(key);
    // A citation clicked again waves over its row on the map again.
    setCitationPulse({ key, revision: performance.now() });
  };
  /** Starts a question about a place or event: it becomes the selected map point and a ready question is offered. */
  const askAbout = useCallback(({ place, record }: { place?: PlaceView; record?: RecordView }) => {
    const item = place ?? record;
    if (!item) return;
    setPinned((current) => ({ place, record, revision: (current?.revision ?? 0) + 1 }));
    setSelectedResultKey(`${place ? "place" : "record"}:${item.id}`);
    setDraft(askQuestion(language, record ? "record" : "place"));
    setMapMode("assistant");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [language, setMapMode]);
  /** The assistant map's own selection: only the question is offered. */
  const askAboutSelection = useCallback((item: { kind: "place" | "record"; id: string; name: string }) => {
    setDraft(askQuestion(language, item.kind));
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [language]);
  useEffect(() => {
    const onShowPlace = (event: Event) => {
      askAbout({ place: (event as CustomEvent<PlaceView>).detail });
      setActivePage("workspace");
    };
    window.addEventListener("waypoint:show-place", onShowPlace);
    return () => window.removeEventListener("waypoint:show-place", onShowPlace);
  }, [askAbout, setActivePage]);

  useEffect(() => {
    if (activePage === "workspace" && focusComposerOnWorkspaceRef.current) {
      composerRef.current?.focus();
      focusComposerOnWorkspaceRef.current = false;
    }
  }, [activePage]);

  useEffect(() => {
    saveLanguage(language);
  }, [language]);

  // The result of the last completed turn travels with the chat, so a reload or a reopened chat shows it again.
  const currentResult: ChatResult | null = resultsLoaded
    ? compactResult({ places: mapPlaces, records: mapRecords, tripPlan, searchArea, appliedFilters, sources: resultSources })
    : null;
  const currentResultRef = useRef(currentResult);
  currentResultRef.current = currentResult;

  useEffect(() => {
    const saved = writeSavedConversation({ id: localChatId, conversationId, messages, savedAt: Date.now(), result: currentResultRef.current, recentChats });
    if (!saved) setHistoryClearWarning(translate(language, "Не удалось сохранить переписку в браузере.", "Could not save the conversation in this browser."));
  }, [conversationId, localChatId, messages, recentChats, language, resultsLoaded, mapPlaces, mapRecords, tripPlan, searchArea]);

  /**
   * Sends a message as the next turn; false when it cannot be sent now. `answers` are the one-time filters chosen in
   * a clarification: they apply to this turn only, and their labels stay on the message.
   */
  function send(message: string, answered?: { answers: ClarificationAnswer[]; tags: string[]; display?: string }): boolean {
    if (!message || pending || voice.state !== "idle" || socketRef.current?.readyState !== WebSocket.OPEN) return false;
    const selectedMapItem = selectedResultKey?.startsWith("place:")
      ? { type: "place" as const, id: selectedResultKey.slice("place:".length) }
      : selectedResultKey?.startsWith("record:")
        ? { type: "record" as const, id: selectedResultKey.slice("record:".length) }
        : undefined;
    const requestId = crypto.randomUUID();
    setLastSubmittedQuery(message);
    submittedQueryRef.current = message;
    // The current result (a trip plan above all) stays on the map while the next turn runs; a completed turn
    // replaces it, and a clarifying question, an error, or a cancel leaves it as it was.
    setSelectedResultKey(null);
    setPending(true);
    requestStartedAtRef.current = performance.now();
    setTurnStartedAt(Date.now());
    setActiveRequestId(requestId);
    setProgressLabel(translate(language, "Отправляю запрос на локальный сервер", "Sending request to the local server"));
    turnStepsRef.current = [];
    setTurnSteps([]);
    setFollowUps(null);
    chatScroll.follow();
    setMessages((current) => [...current, {
      role: "user", text: answered ? answered.display || message : message, at: Date.now(),
      ...(answered?.tags.length ? { tags: answered.tags, ...(answered.display ? {} : { tagsOnly: true }) } : {}),
    }]);
    socketRef.current.send(JSON.stringify({
      protocolVersion: 1,
      type: "turn.submit",
      requestId,
      conversationId,
      message,
      scope: { workspaceId: "demo", sourceIds: [], polygonIds: [], dateRange: null, language, ...(selectedMapItem ? { selectedMapItem } : {}) },
      ...(answered?.answers.length ? { answers: answered.answers } : {}),
    }));
    return true;
  }

  /**
   * Answers the clarification at `index` with its filters. The request it asked about is sent again with them, so the
   * turn stands on its own (the server adds the chosen details to it); words typed in the composer go along.
   */
  function answerClarification(index: number, answers: ClarificationAnswer[], tags: string[], fallback: string) {
    const asked = messages.slice(0, index).reverse().find((message) => message.role === "user");
    const typed = draft.trim();
    const request = [asked?.text, typed].filter(Boolean).join("\n") || fallback;
    if (send(request, { answers, tags, ...(typed ? { display: typed } : {}) })) setDraft("");
  }

  function updateDraft(value: string) {
    setDraft(value);
  }

  function startVoiceInput() {
    voiceBaseDraftRef.current = draft;
    void voice.start();
  }

  function chooseReply(prompt: string) {
    setDraft(prompt);
    composerRef.current?.focus();
  }

  /**
   * The follow-ups under the latest answer: the model's, placeholders while it writes them, or, when it wrote none
   * (or after a reload), requests built from what is on the map. A new chat offers starter requests.
   */
  function followUpsFor(message: Message, index: number): { items: SuggestedRequest[]; loading: boolean } | null {
    if (pending || index !== messages.length - 1 || message.role !== "assistant") return null;
    if (message.kind && message.kind !== "answer") return null;
    if (message.suggestions?.length) return { items: message.suggestions, loading: false };
    if (followUps?.status === "loading" && followUps.requestId === message.requestId) return { items: [], loading: true };
    const fallback = lastSubmittedQuery
      ? contextSuggestions({ query: lastSubmittedQuery, places: mapPlaces, records: mapRecords, tripPlan, searchArea }, language)
      : starterSuggestions(language, localChatId);
    return { items: fallback.slice(0, 3), loading: false };
  }

  function cancelRequest() {
    const requestId = activeRequestId;
    if (!requestId || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ protocolVersion: 1, type: "turn.cancel", requestId }));
    setProgressLabel(translate(language, "Останавливаю запрос", "Stopping the request"));
  }

  function showResult(result: ChatResult | null, query = "") {
    setResultQuery(result ? query : "");
    setMapPlaces(result?.places ?? []);
    setMapRecords(result?.records ?? []);
    setTripPlan(result?.tripPlan ?? null);
    setSearchArea(result?.searchArea ?? null);
    setAppliedFilters(result?.appliedFilters ?? []);
    setResultSources(result?.sources ?? []);
    setResultsLoaded(Boolean(result));
    setSelectedResultKey(null);
  }

  /** Clears the chat, the composer, and the map for a fresh conversation. */
  function resetConversation() {
    setMessages([welcomeMessage(language)]);
    setDraft("");
    showResult(null);
    setLastSubmittedQuery("");
  }

  function startNewConversation() {
    if (pending) return;
    chatScroll.follow();
    archiveCurrentConversation();
    setLocalChatId(crypto.randomUUID());
    setConversationId(null);
    resetConversation();
  }

  function archiveCurrentConversation() {
    if (!messages.some((message) => message.role === "user")) return;
    const archived: SavedChat = {
      id: localChatId,
      conversationId,
      messages: messages.slice(-100),
      savedAt: Date.now(),
      result: currentResult,
    };
    setRecentChats((current) => [archived, ...current.filter((chat) => chat.id !== localChatId)]
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, 30));
  }

  function openRecentChat(id: string) {
    if (pending) return;
    const selected = recentChats.find((chat) => chat.id === id);
    if (!selected) return;
    chatScroll.follow();
    archiveCurrentConversation();
    setRecentChats((current) => current.filter((chat) => chat.id !== id));
    setLocalChatId(selected.id);
    setConversationId(selected.conversationId);
    setMessages(selected.messages);
    setLastSubmittedQuery(lastUserMessage(selected.messages));
    setDraft("");
    showResult(selected.result, lastUserMessage(selected.messages));
    setResetViewportRevision((revision) => revision + 1);
  }

  async function resetHistory() {
    if (pending || historyResetPending) return;
    if (!window.confirm(translate(language, "Удалить всю сохранённую историю чатов в браузере и на сервере? Это действие нельзя отменить.", "Delete all saved chat history from this browser and the server? This cannot be undone."))) return;
    chatScroll.follow();
    setHistoryResetPending(true);
    setHistoryClearWarning(null);
    setConversationId(null);
    setLocalChatId(crypto.randomUUID());
    setRecentChats([]);
    resetConversation();
    try {
      await clearAssistantHistory();
    } catch {
      setHistoryClearWarning(translate(language, "Переписка очищена в браузере, но серверную историю удалить не удалось.", "Browser history was cleared, but server history could not be deleted."));
    } finally {
      setHistoryResetPending(false);
    }
  }

  const status = capabilities?.assistantStatus ?? "starting";
  const t = (ru: string, en: string) => translate(language, ru, en);
  const voiceStatus = voiceStatusText(language, voice.state, voice.issue);
  const statusText = status === "ready" ? translate(language, "Модель готова", "Model ready") : status === "data_unavailable" ? translate(language, "База недоступна", "Database unavailable") : status === "model_unavailable" ? translate(language, "Модель не подключена", "Model unavailable") : translate(language, "AI-обработчик не подключён", "AI service starting");
  const conversationName = conversationTitle(messages, language);

  const streamingText = pending && messages.at(-1)?.streaming ? messages.at(-1)!.text : "";
  // Only the latest result is on the map, so only its answer offers to show it there.
  let lastResultIndex = -1;
  messages.forEach((message, index) => { if (message.result) lastResultIndex = index; });

  return (
    <main className="app-shell">
      <AppRail
        language={language}
        activePage={activePage}
        onNavigate={(page) => { setActivePage(page); if (page === "home") window.scrollTo({ top: 0, behavior: "smooth" }); }}
        onLanguage={setLanguage}
        demo={Boolean(capabilities?.demoMode)}
        modelLabel={capabilities?.modelLabel ?? t("Локальная модель", "Local model")}
        healthy={status === "ready" && connection === "connected"}
        statusText={statusText}
        connectionText={connectionLabel(connection, reconnectInfo, language)}
        reconnecting={Boolean(reconnectInfo)}
        onReconnect={() => connectionRef.current?.reconnectNow()}
      />

      <section className={activePage === "workspace" || activePage === "data" ? "workspace workspace-fill" : "workspace"}>
        <h1 className="sr-only">{pageTitle(activePage, language)}</h1>
        {visitedPages.has("data") && (
          <div className="page-keepalive" hidden={activePage !== "data"}>
            <Suspense fallback={null}><DataPage language={language} /></Suspense>
          </div>
        )}
        {activePage === "model" && <Suspense fallback={null}><ModelPage language={language} ready={status === "ready" || status === "data_unavailable"} /></Suspense>}
        {activePage === "home" && <HomeDashboard language={language} modelLabel={capabilities?.modelLabel ?? null} modelReady={status === "ready" || status === "data_unavailable"} connection={connection} sources={sources} sourcesLoading={sourcesLoading} sourcesFailed={sourceLoadFailed} resultsLoaded={resultsLoaded} resultCount={mapPlaces.length + mapRecords.length} lastQuery={lastSubmittedQuery} onOpenWorkspace={() => setActivePage("workspace")} onOpenModel={() => setActivePage("model")} onChoosePrompt={(prompt) => { setDraft(prompt); setActivePage("workspace"); focusComposerOnWorkspaceRef.current = true; }} />}
        {visitedPages.has("workspace") && <div className="content-grid" hidden={activePage !== "workspace"}>
          <section className="chat-panel map-side" aria-label={t("Панель карты", "Map panel")}>
            <div className="map-modes" role="tablist" aria-label={t("Режим карты", "Map mode")}>
              {([
                ["assistant", <MessageSquare key="i" size={14} />, t("Ассистент", "Assistant")],
                ["events", <Activity key="i" size={14} />, t("События", "Events")],
                ["places", <MapPin key="i" size={14} />, t("Места", "Places")],
              ] as const).map(([mode, icon, label]) => <button key={mode} type="button" role="tab" aria-selected={mapMode === mode} className={mapMode === mode ? "active" : ""} onClick={() => setMapMode(mode)}>{icon}{label}</button>)}
            </div>
            <div className="map-mode-pane chat-pane" hidden={mapMode !== "assistant"}>
              <ChatHeader language={language} title={conversationName} busy={pending || historyResetPending} recentChats={recentChats} resultSources={resultSources} onNewChat={startNewConversation} onOpenChat={openRecentChat} onResetHistory={() => void resetHistory()} />
              <div className="messages-scroll-frame">
                <div className="messages" ref={chatScroll.viewportRef} onScroll={chatScroll.onScroll} tabIndex={0} aria-label={t("Сообщения чата", "Chat messages")}>
                  {messages.map((message, index) => {
                    // The text of the running turn is shown in its live card until the answer replaces it.
                    if (pending && message.streaming && index === messages.length - 1) return null;
                    if (message.role === "user") return <UserBubble key={`${index}-user`} message={message} language={language} />;
                    return <AnswerCard
                      key={`${index}-assistant`}
                      message={message}
                      language={language}
                      body={<Suspense fallback={<p>{message.text}</p>}><MarkdownMessage text={message.text} citations={message.citations} onCite={showCitation} /></Suspense>}
                      sources={message.citations?.length ? <CitationList citations={message.citations} mode={message.citationsMode} language={language} sourceLabels={sourceLabels} isOnMap={citationOnMap} onShow={showCitation} /> : undefined}
                      feedback={message.requestId ? <AnswerFeedback key={message.requestId} language={language} requestId={message.requestId} /> : undefined}
                      pending={pending}
                      onShowOnMap={index === lastResultIndex && resultsLoaded ? () => setResetViewportRevision((revision) => revision + 1) : undefined}
                      onChoice={(label) => { setDraft(label); composerRef.current?.focus(); }}
                      form={message.kind === "clarification" && message.fields?.length && index === messages.length - 1
                        ? <ClarificationForm key={`${index}-form`} fields={message.fields} language={language} disabled={pending || connection !== "connected"} onSubmit={(answers, tags, text) => { answerClarification(index, answers, tags, text); }} />
                        : undefined}
                      followUps={(() => { const followUp = followUpsFor(message, index); return followUp ? <SuggestionChips items={followUp.items} loading={followUp.loading} language={language} disabled={pending} onChoose={chooseReply} /> : undefined; })()}
                      onRetry={(query) => { send(query); }}
                    />;
                  })}
                  {pending && turnStartedAt !== null && <LiveTurnCard steps={turnSteps} startedAt={turnStartedAt} label={progressLabel ?? t("Думаю", "Thinking")} text={streamingText} language={language} body={<Suspense fallback={<p>{streamingText}</p>}><MarkdownMessage text={streamingText} /></Suspense>} />}
                </div>
                <div className="chat-edge-fade chat-edge-fade-top" aria-hidden="true" />
                <div className="chat-edge-fade chat-edge-fade-bottom" aria-hidden="true" />
              </div>
              {historyClearWarning && <div className="history-warning" role="status">{historyClearWarning}</div>}
              <ChatComposer
                language={language}
                composerRef={composerRef}
                draft={draft}
                onDraft={updateDraft}
                onSubmit={() => { if (send(draft.trim())) setDraft(""); }}
                dictating={voice.state !== "idle"}
                canSend={Boolean(draft.trim()) && !pending && voice.state === "idle" && connection === "connected"}
                statusText={voiceStatus ?? t("Данные обрабатываются локально", "Data is processed locally")}
                statusClass={voiceStatus ? `voice-status ${voice.state}${voice.issue ? " issue" : ""}` : undefined}
                pending={pending}
                onCancel={cancelRequest}
                mic={capabilities?.voiceInput ? <MicButton language={language} state={voice.state} disabled={connection !== "connected"} onStart={startVoiceInput} onStop={voice.stop} /> : undefined}
              />
            </div>
            {visitedModes.has("events") && <div className="map-mode-pane" hidden={mapMode !== "events"}>
              <Suspense fallback={<p className="investigation-state" role="status">{t("Загружаем…", "Loading…")}</p>}>
                <EventsPanel language={language} onScene={setEventsScene} selectRef={eventsSelectRef} onAsk={(event) => askAbout({ record: event })} />
              </Suspense>
            </div>}
            {visitedModes.has("places") && <div className="map-mode-pane" hidden={mapMode !== "places"}>
              <Suspense fallback={<p className="investigation-state" role="status">{t("Загружаем…", "Loading…")}</p>}>
                <PlacesPanel language={language} onScene={setPlacesScene} selectRef={placesSelectRef} onAsk={(place) => askAbout({ place })} />
              </Suspense>
            </div>}
          </section>

          {/* Each mode keeps its own map: switching shows another Leaflet instance with its view and layers intact
              instead of redrawing one map with another mode's results. */}
          {visitedModes.has("assistant") && <div className="map-mode-map" hidden={mapMode !== "assistant"}>
            <MapPanel language={language} heading={resultsLoaded && resultQuery ? { eyebrow: tripPlan ? t("ПЛАН ПОЕЗДКИ · ПО ЗАПРОСУ", "TRIP PLAN · FROM THE REQUEST") : mapRecords.length ? t("СОБЫТИЯ · ПО ЗАПРОСУ", "EVENTS · FROM THE REQUEST") : t("МЕСТА · ПО ЗАПРОСУ", "PLACES · FROM THE REQUEST"), title: resultQuery } : undefined} pinned={pinned} overlayRecords={mapLayers.events ? eventsLayer.data?.events ?? [] : []} layers={mapLayers} onLayers={setMapLayers} onAsk={askAboutSelection} highlights={mapPlaces} records={mapRecords} tripPlan={tripPlan} radius={searchArea} sourceIds={[]} selectedResultKey={selectedResultKey} onSelectResult={setSelectedResultKey} sourceLabels={sourceLabels} sourceDates={Object.fromEntries(sources.flatMap((source) => source.snapshotDate ? [[source.id, source.snapshotDate]] : []))} resultsLoaded={resultsLoaded} resetViewportRevision={resetViewportRevision} pulse={citationPulse} />
          </div>}
          {visitedModes.has("events") && <div className="map-mode-map" hidden={mapMode !== "events"}>
            <MapPanel language={language} variant="investigation" heading={{ eyebrow: t("СОБЫТИЯ · OPENSTREETMAP", "EVENTS · OPENSTREETMAP"), title: t("События и места рядом", "Events and nearby places") }} records={eventsScene.records} recordSourceModes={eventsScene.recordSourceModes} highlights={eventsScene.highlights} radius={eventsScene.radius} focus={eventsScene.focus} selectedResultKey={eventsScene.selectedKey} onSelectResult={(key) => eventsSelectRef.current?.(key)} sourceLabels={eventsScene.sourceLabels} resultsLoaded={eventsScene.resultsLoaded} pulse={eventsScene.pulse} />
          </div>}
          {visitedModes.has("places") && <div className="map-mode-map" hidden={mapMode !== "places"}>
            <MapPanel language={language} variant="investigation" fit="results" heading={{ eyebrow: t("МЕСТА · OPENSTREETMAP", "PLACES · OPENSTREETMAP"), title: t("Каталог мест", "Place catalog") }} highlights={placesScene.highlights} selectedResultKey={placesScene.selectedKey} onSelectResult={(key) => placesSelectRef.current?.(key)} sourceLabels={sourceLabels} resultsLoaded={placesScene.resultsLoaded} pulse={placesScene.pulse} />
          </div>}
        </div>}
      </section>
      <ImportLayer language={language} />
    </main>
  );
}
