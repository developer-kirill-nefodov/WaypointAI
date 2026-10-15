import { Fragment, lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Activity, ArrowUp, ArrowUpRight, BrainCircuit, ChevronDown, Clock3, Database, House, Layers3, MapPin, MapPinned, MessageSquare, MoreHorizontal, Plus, RefreshCw, SlidersHorizontal, Sparkles, Square, Trash2 } from "lucide-react";
import type { PlaceView, RecordView, Scope, ServerFrame, SourceView, TripPlan, SearchArea } from "@waypoint-ai/shared";
import MapPanel, { type MapLayers } from "../../widgets/map/MapPanel";
import { EMPTY_SCENE, type MapScene } from "../../widgets/map/map-scene";
import { useCachedQuery } from "../../shared/data-cache";
import { eventQueryParams, searchEvents } from "../../shared/api/investigations";
import { clearAssistantHistory, loadCapabilities, loadDataSources, type Capabilities, type ConnectionState } from "../../shared/api/client";
import { createAssistantConnection, type AssistantConnection, type ReconnectInfo } from "../../shared/api/assistantSocket";
import { readLanguage, saveLanguage, translate, type Language } from "../../shared/i18n";
import ModelInfoPage from "./ModelInfoPage";
import HomeDashboard from "./HomeDashboard";
import Logo from "../../shared/ui/Logo";
import { pageCaption, pageFromPath, pageTitle, pathForPage, rememberPageSearch, type AppPage } from "../../shared/routing";
import MicButton, { voiceStatusText } from "../voice/MicButton";
import { isVoiceFrame, useVoiceInput } from "../voice/useVoiceInput";
import { compactResult, lastUserMessage, readSavedConversation, writeSavedConversation, type ChatResult, type Message, type SavedChat, type TurnStep } from "./chat-storage";
import TurnSteps from "./TurnSteps";
import ImportLayer from "../imports/ImportLayer";
import { importStore } from "../imports/import-store";
import { contextSuggestions, rotateSuggestions, starterSuggestions } from "./suggestions";

const MESSAGE_ANCHOR_OFFSET_PX = 16;
const MarkdownMessage = lazy(() => import("./MarkdownMessage"));
// The events and places modes of the map page load on first use, so they do not grow the initial bundle.
const EventsPanel = lazy(() => import("../investigation/EventsPanel"));
const PlacesPanel = lazy(() => import("../map/PlacesPanel"));

type MapMode = "assistant" | "events" | "places";

/** The map page's mode from the address: `/map?mode=events`; the former `/investigation` page opens the events mode. */
function readMapMode(): MapMode {
  if (window.location.pathname.replace(/\/+$/, "") === "/investigation") return "events";
  if (window.location.pathname.replace(/\/+$/, "") !== "/map") return "assistant";
  const mode = new URLSearchParams(window.location.search).get("mode");
  return mode === "events" || mode === "places" ? mode : "assistant";
}
const DataPage = lazy(() => import("../data/DataPage"));

function welcomeMessage(language: Language): Message {
  return { role: "assistant", text: translate(language, "Привет! Я локальный помощник для поиска и изучения геоданных. Опишите, что хотите найти.", "Hi! I’m your local assistant for exploring geospatial data. Tell me what you’d like to find.") };
}

export default function AssistantWorkspace() {
  const [language, setLanguage] = useState<Language>(readLanguage);
  const [activePage, setActivePageState] = useState<AppPage>(() => pageFromPath(window.location.pathname));
  // Map pages stay mounted after their first visit so Leaflet, filters, and results are not rebuilt on every switch.
  const [visitedPages, setVisitedPages] = useState<Set<AppPage>>(() => new Set([activePage]));
  const showPage = useCallback((page: AppPage) => {
    setActivePageState(page);
    setVisitedPages((current) => current.has(page) ? current : new Set([...current, page]));
  }, []);
  const setActivePage = useCallback((page: AppPage) => {
    const path = pathForPage(page);
    if (`${window.location.pathname}${window.location.search}` !== path) window.history.pushState({ page }, "", path);
    showPage(page);
  }, [showPage]);
  const [mapMode, setMapModeState] = useState<MapMode>(readMapMode);
  const [visitedModes, setVisitedModes] = useState<Set<MapMode>>(() => new Set([readMapMode()]));
  const setMapMode = useCallback((mode: MapMode) => {
    setMapModeState(mode);
    setVisitedModes((current) => current.has(mode) ? current : new Set([...current, mode]));
    const search = mode === "assistant" ? "" : `?mode=${mode}`;
    rememberPageSearch("workspace", search);
    if (window.location.pathname === "/map" && window.location.search !== search) window.history.pushState({ page: "workspace" }, "", `/map${search}`);
  }, []);
  useEffect(() => {
    // The former event explorer address becomes the map's events mode.
    const mode = readMapMode();
    if (mode !== "assistant") rememberPageSearch("workspace", `?mode=${mode}`);
    if (window.location.pathname.replace(/\/+$/, "") === "/investigation") window.history.replaceState({ page: "workspace" }, "", "/map?mode=events");
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const page = pageFromPath(window.location.pathname);
      showPage(page);
      if (page === "workspace") {
        const mode = readMapMode();
        setMapModeState(mode);
        setVisitedModes((current) => current.has(mode) ? current : new Set([...current, mode]));
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [showPage]);
  const [savedConversation] = useState(() => readSavedConversation(welcomeMessage(language)));
  const socketRef = useRef<WebSocket | null>(null);
  const requestStartedAtRef = useRef<number | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const followLatestMessageRef = useRef(true);
  const sourcesRef = useRef<SourceView[]>([]);
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
  const [elapsedMs, setElapsedMs] = useState(0);
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
    setSuggestionOffset(0);
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
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
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
  const [resetViewportRevision, setResetViewportRevision] = useState(0);
  const [lastSubmittedQuery, setLastSubmittedQuery] = useState(() => lastUserMessage(savedConversation.messages));
  const [suggestionOffset, setSuggestionOffset] = useState(0);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(false);

  useEffect(() => {
    setSourcesLoading(true);
    setSourceLoadFailed(false);
    const abort = new AbortController();
    loadCapabilities(abort.signal).then(setCapabilities).catch(() => setCapabilities(null));
    loadDataSources(abort.signal).then((loadedSources) => {
      if (abort.signal.aborted) return;
      sourcesRef.current = loadedSources;
      setSources(loadedSources);
      setSourceLoadFailed(false);
    }).catch(() => { if (!abort.signal.aborted) setSourceLoadFailed(true); }).finally(() => { if (!abort.signal.aborted) setSourcesLoading(false); });
    return () => abort.abort();
  }, [metadataVersion]);

  useEffect(() => {
    const connection = createAssistantConnection({
      onFrame: (frame) => {
          if (isVoiceFrame(frame)) {
            voiceFrameHandlerRef.current(frame);
            return;
          }
          if (frame.type === "session.ready") setCapabilities({ assistantStatus: frame.assistantStatus, modelLabel: frame.modelLabel, demoMode: frame.demoMode, voiceInput: frame.voiceInput });
          if (frame.type === "import.progress") importStore.upsert(frame.job, true);
          if (frame.type === "turn.status") setProgressLabel(frame.label);
          if (frame.type === "turn.step") {
            const step: TurnStep = { id: frame.stepId, label: frame.label, state: frame.state, ...(frame.detail ? { detail: frame.detail } : {}) };
            const current = turnStepsRef.current;
            turnStepsRef.current = current.some((item) => item.id === step.id) ? current.map((item) => item.id === step.id ? step : item) : [...current, step];
            setTurnSteps(turnStepsRef.current);
          }
          if (frame.type === "tool.started") setProgressLabel(frame.label);
          if (frame.type === "turn.accepted") setConversationId(frame.conversationId);
          if (frame.type === "turn.error") {
            const durationMs = elapsedSince(requestStartedAtRef.current);
            requestStartedAtRef.current = null;
            setPending(false);
            setActiveRequestId(null);
            setProgressLabel(null);
            const steps = finishedSteps();
            setMessages((current) => [...endStreaming(current), { role: "assistant", text: frame.message, durationMs, steps }]);
          }
          if (frame.type === "turn.clarification") {
            const durationMs = elapsedSince(requestStartedAtRef.current);
            requestStartedAtRef.current = null;
            setConversationId(frame.conversationId);
            setPending(false);
            setActiveRequestId(null);
            setProgressLabel(null);
            const steps = finishedSteps();
            setMessages((current) => [...endStreaming(current), { role: "assistant", text: frame.message, choices: frame.choices, durationMs, steps }]);
          }
          if (frame.type === "turn.completed") {
            const durationMs = elapsedSince(requestStartedAtRef.current);
            requestStartedAtRef.current = null;
            setConversationId(frame.conversationId);
            setPending(false);
            setActiveRequestId(null);
            setProgressLabel(null);
            setMapPlaces(frame.result.places ?? []);
            setMapRecords(frame.result.records);
            setTripPlan(frame.result.tripPlan ?? null);
            setSearchArea(frame.result.searchArea ?? null);
            setResultsLoaded(true);
            setSelectedResultKey(null);
            setAppliedFilters(frame.appliedFilters);
            setResultSources(frame.sources);
            setSuggestionOffset(0);
            // The streamed text is replaced by the final message, which is the authoritative version.
            const steps = finishedSteps();
            setMessages((current) => current.at(-1)?.streaming
              ? [...current.slice(0, -1), { role: "assistant", text: frame.assistantMessage, durationMs, steps }]
              : [...current, { role: "assistant", text: frame.assistantMessage, durationMs, steps }]);
          }
          if (frame.type === "turn.cancelled") {
            const durationMs = elapsedSince(requestStartedAtRef.current);
            requestStartedAtRef.current = null;
            setPending(false);
            setActiveRequestId(null);
            setProgressLabel(null);
            const activeLanguage = readLanguage();
            const steps = finishedSteps();
            setMessages((current) => [...endStreaming(current), { role: "assistant", text: translate(activeLanguage, "Запрос остановлен.", "Request stopped."), durationMs, steps }]);
          }
          if (frame.type === "assistant.delta") setMessages((current) => {
            const last = current.at(-1);
            if (last?.streaming) return [...current.slice(0, -1), { ...last, text: last.text + frame.text }];
            return [...current, { role: "assistant", text: frame.text, streaming: true }];
          });
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
          const durationMs = elapsedSince(requestStartedAtRef.current);
          requestStartedAtRef.current = null;
          const activeLanguage = readLanguage();
          const steps = finishedSteps();
          setMessages((current) => [...endStreaming(current), {
            role: "assistant",
            steps,
            text: translate(
              activeLanguage,
              "Соединение с сервером прервалось, запрос не завершён. Отправьте его ещё раз после переподключения.",
              "The connection to the server was lost before the request finished. Send it again once reconnected.",
            ),
            durationMs,
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

  // Background events layer of the assistant map: the last week, up to one page.
  const eventsLayer = useCachedQuery(mapMode === "assistant" && mapLayers.events ? "map:events-layer" : null, () => searchEvents(eventQueryParams({ days: 7, minMagnitude: null, sourceIds: [], near: null, limit: 200 })), 5 * 60_000);
  const sourceLabels = Object.fromEntries(sources.map((source) => [source.id, source.label]));
  /** Starts a question about a place or event: it becomes the selected map point and a ready question is offered. */
  const askAbout = useCallback(({ place, record }: { place?: PlaceView; record?: RecordView }) => {
    const item = place ?? record;
    if (!item) return;
    setPinned((current) => ({ place, record, revision: (current?.revision ?? 0) + 1 }));
    setSelectedResultKey(`${place ? "place" : "record"}:${item.id}`);
    setDraft(record
      ? translate(language, "Были ли ещё землетрясения в радиусе 30 км от выбранной точки на карте за последние 30 дней?", "Were there other earthquakes within 30 km of the selected map point in the last 30 days?")
      : translate(language, "Были ли землетрясения в радиусе 50 км от выбранной точки на карте за последние 30 дней?", "Were there earthquakes within 50 km of the selected map point in the last 30 days?"));
    setMapMode("assistant");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [language, setMapMode]);
  /** The assistant map's own selection: only the question is offered. */
  const askAboutSelection = useCallback((item: { kind: "place" | "record"; id: string; name: string }) => {
    setDraft(item.kind === "record"
      ? translate(language, "Были ли ещё землетрясения в радиусе 30 км от выбранной точки на карте за последние 30 дней?", "Were there other earthquakes within 30 km of the selected map point in the last 30 days?")
      : translate(language, "Были ли землетрясения в радиусе 50 км от выбранной точки на карте за последние 30 дней?", "Were there earthquakes within 50 km of the selected map point in the last 30 days?"));
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
    if (!pending || requestStartedAtRef.current === null) return;
    const updateElapsed = () => setElapsedMs(elapsedSince(requestStartedAtRef.current));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(interval);
  }, [pending]);

  useEffect(() => {
    saveLanguage(language);
  }, [language]);

  useEffect(() => {
    const closePopovers = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      document.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((popover) => {
        if (!popover.contains(target)) popover.open = false;
      });
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const openPopovers = [...document.querySelectorAll<HTMLDetailsElement>("details[open]")];
      openPopovers.forEach((popover) => { popover.open = false; });
      openPopovers.at(-1)?.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("pointerdown", closePopovers);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closePopovers);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

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

  useEffect(() => {
    const viewport = messagesRef.current;
    if (!viewport || !followLatestMessageRef.current) return;
    const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
    const latestMessage = viewport.querySelector<HTMLElement>("article.message:last-of-type");
    // Keep the start of a long assistant answer visible instead of jumping past it to the end.
    if (latestMessage?.classList.contains("assistant")) {
      viewport.scrollTop = Math.min(latestMessage.offsetTop - MESSAGE_ANCHOR_OFFSET_PX, maxScrollTop);
      return;
    }
    viewport.scrollTop = maxScrollTop;
  }, [messages, pending, progressLabel]);

  /** The steps of the turn that just ended; a step still running when the turn ends is shown as not finished. */
  function finishedSteps(): TurnStep[] | undefined {
    const steps = turnStepsRef.current.map((step) => step.state === "running" ? { ...step, state: "failed" as const } : step);
    turnStepsRef.current = [];
    setTurnSteps([]);
    return steps.length ? steps : undefined;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || pending || voice.state !== "idle" || invalidDateRange(fromDate, toDate) || socketRef.current?.readyState !== WebSocket.OPEN) return;
    const selectedMapItem = selectedResultKey?.startsWith("place:")
      ? { type: "place" as const, id: selectedResultKey.slice("place:".length) }
      : selectedResultKey?.startsWith("record:")
        ? { type: "record" as const, id: selectedResultKey.slice("record:".length) }
        : undefined;
    const requestId = crypto.randomUUID();
    setLastSubmittedQuery(message);
    setSuggestionOffset(0);
    // The current result (a trip plan above all) stays on the map while the next turn runs; a completed turn
    // replaces it, and a clarifying question, an error, or a cancel leaves it as it was.
    setSelectedResultKey(null);
    setPending(true);
    requestStartedAtRef.current = performance.now();
    setElapsedMs(0);
    setActiveRequestId(requestId);
    setProgressLabel(translate(language, "Отправляю запрос на локальный сервер", "Sending request to the local server"));
    turnStepsRef.current = [];
    setTurnSteps([]);
    const dateRange: Scope["dateRange"] = fromDate || toDate ? {
      ...(fromDate ? { from: localDateBoundary(fromDate, false) } : {}),
      ...(toDate ? { to: localDateBoundary(toDate, true) } : {}),
    } : null;
    // Sending a message always brings the conversation back into follow mode.
    followLatestMessageRef.current = true;
    setMessages((current) => [...current, { role: "user", text: message }]);
    socketRef.current.send(JSON.stringify({
      protocolVersion: 1,
      type: "turn.submit",
      requestId,
      conversationId,
      message,
      scope: { workspaceId: "demo", sourceIds: selectedSourceIds, polygonIds: [], dateRange, language, ...(selectedMapItem ? { selectedMapItem } : {}) },
    }));
    setDraft("");
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function updateDraft(value: string) {
    setDraft(value);
    setSuggestionOffset(0);
  }

  function startVoiceInput() {
    voiceBaseDraftRef.current = draft;
    void voice.start();
  }

  function chooseReply(prompt: string) {
    setDraft(prompt);
    setSuggestionOffset(0);
    composerRef.current?.focus();
  }

  const activeSuggestions = lastSubmittedQuery
    ? contextSuggestions({ query: lastSubmittedQuery, places: mapPlaces, records: mapRecords, tripPlan, searchArea }, language)
    : starterSuggestions(language, localChatId);
  const visibleSuggestions = rotateSuggestions(activeSuggestions, suggestionOffset);
  const activeFilterCount = Number(selectedSourceIds.length > 0) + Number(Boolean(fromDate || toDate));

  function cancelRequest() {
    const requestId = activeRequestId;
    if (!requestId || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ protocolVersion: 1, type: "turn.cancel", requestId }));
    setProgressLabel(translate(language, "Останавливаю запрос", "Stopping the request"));
  }

  function showResult(result: ChatResult | null) {
    setMapPlaces(result?.places ?? []);
    setMapRecords(result?.records ?? []);
    setTripPlan(result?.tripPlan ?? null);
    setSearchArea(result?.searchArea ?? null);
    setAppliedFilters(result?.appliedFilters ?? []);
    setResultSources(result?.sources ?? []);
    setResultsLoaded(Boolean(result));
    setSelectedResultKey(null);
  }

  function startNewConversation() {
    if (pending) return;
    followLatestMessageRef.current = true;
    archiveCurrentConversation();
    setLocalChatId(crypto.randomUUID());
    setConversationId(null);
    setMessages([welcomeMessage(language)]);
    setDraft("");
    setSuggestionsExpanded(false);
    showResult(null);
    setLastSubmittedQuery("");
    setSuggestionOffset(0);
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
    followLatestMessageRef.current = true;
    archiveCurrentConversation();
    setRecentChats((current) => current.filter((chat) => chat.id !== id));
    setLocalChatId(selected.id);
    setConversationId(selected.conversationId);
    setMessages(selected.messages);
    setLastSubmittedQuery(lastUserMessage(selected.messages));
    setSuggestionsExpanded(false);
    setDraft("");
    showResult(selected.result);
    setResetViewportRevision((revision) => revision + 1);
    setSuggestionOffset(0);
  }

  async function resetHistory() {
    if (pending || historyResetPending) return;
    if (!window.confirm(translate(language, "Удалить всю сохранённую историю чатов в браузере и на сервере? Это действие нельзя отменить.", "Delete all saved chat history from this browser and the server? This cannot be undone."))) return;
    followLatestMessageRef.current = true;
    setHistoryResetPending(true);
    setHistoryClearWarning(null);
    setConversationId(null);
    setLocalChatId(crypto.randomUUID());
    setRecentChats([]);
    setMessages([welcomeMessage(language)]);
    setDraft("");
    setSuggestionsExpanded(false);
    showResult(null);
    setLastSubmittedQuery("");
    setSuggestionOffset(0);
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
  const dateRangeInvalid = invalidDateRange(fromDate, toDate);

  function updateMessageScrollPosition() {
    const viewport = messagesRef.current;
    if (!viewport) return;
    const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    followLatestMessageRef.current = remaining <= 48;
  }

  /** The live feed of the running turn: the current step with a timer, then the steps already finished. */
  function renderLiveProgress() {
    const running = [...turnSteps].reverse().find((step) => step.state === "running");
    const label = running?.label ?? progressLabel ?? translate(language, "Думаю", "Thinking");
    return <div className="assistant-progress live" role="status" aria-live="polite">
      <div className="assistant-progress-head"><span className="progress-dot" /><span>{label}</span><span className="thinking-elapsed">{t("Думает", "Thinking")} · {formatElapsed(elapsedMs, language)}</span></div>
      {turnSteps.some((step) => step.state !== "running") && <TurnSteps steps={turnSteps.filter((step) => step.state !== "running")} language={language} />}
    </div>;
  }

  return (
    <main className="app-shell">
      <aside className="rail">
        <button type="button" className="brand-mark" aria-label={t("На главную", "Go to home")} title={t("На главную", "Go to home")} onClick={() => { setActivePage("home"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><Logo size={38} title="" /></button>
        <button type="button" className={`rail-button${activePage === "home" ? " active" : ""}`} aria-label={t("Главная", "Home")} title={t("Главная", "Home")} aria-pressed={activePage === "home"} onClick={() => { setActivePage("home"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><House size={18} strokeWidth={1.8} /></button>
        <button type="button" className={`rail-button${activePage === "workspace" ? " active" : ""}`} aria-label={t("Карта", "Map")} title={t("Карта: ассистент, события, места", "Map: assistant, events, places")} aria-pressed={activePage === "workspace"} onClick={() => setActivePage("workspace")}><MapPinned size={18} strokeWidth={1.8} /></button>
        <button type="button" className={`rail-button${activePage === "data" ? " active" : ""}`} aria-label={t("Данные", "Data")} title={t("Данные", "Data")} aria-pressed={activePage === "data"} onClick={() => setActivePage("data")}><Database size={18} strokeWidth={1.8} /></button>
        <button type="button" className={`rail-button${activePage === "model" ? " active" : ""}`} aria-label={t("Модель ИИ", "AI model")} title={t("Модель ИИ", "AI model")} aria-pressed={activePage === "model"} onClick={() => setActivePage("model")}><BrainCircuit size={18} strokeWidth={1.8} /></button>
        <div className="rail-spacer" />
        <div className="avatar">U</div>
      </aside>

      <section className={activePage === "workspace" || activePage === "data" ? "workspace workspace-fill" : "workspace"}>
        <h1 className="sr-only">{pageTitle(activePage, language)}</h1>
        {visitedPages.has("data") && (
          <div className="page-keepalive" hidden={activePage !== "data"}>
            <Suspense fallback={null}><DataPage language={language} /></Suspense>
          </div>
        )}
        {activePage === "model" && <ModelInfoPage language={language} modelLabel={capabilities?.modelLabel ?? null} ready={status === "ready" || status === "data_unavailable"} />}
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
            <div className="panel-heading chat-heading">
              <div className="chat-heading-title"><span className="eyebrow">{t("ЛОКАЛЬНЫЙ ПОМОЩНИК", "LOCAL ASSISTANT")}</span><h2 title={conversationTitle(messages, language)}>{conversationTitle(messages, language)}</h2></div>
              <div className="panel-heading-actions">
                <button type="button" className="new-chat-button" disabled={pending || historyResetPending} onClick={startNewConversation}><Plus size={15} /><span>{t("Новый чат", "New chat")}</span></button>
                <details className="chat-options">
                  <summary className="icon-button" aria-label={t("Опции чата", "Chat options")} title={t("История и настройки", "History and settings")}><MoreHorizontal size={18} /></summary>
                  <div className="chat-options-menu">
                    <div className="chat-options-heading"><Clock3 size={14} /><span>{t("Недавние чаты", "Recent chats")}</span><small>{recentChats.length}</small></div>
                    {recentChats.length ? <div className="recent-chat-list">
                      {recentChats.map((chat) => <button key={chat.id} type="button" className="recent-chat-item" onClick={(event) => { openRecentChat(chat.id); event.currentTarget.closest("details")?.removeAttribute("open"); }}>
                        <span>{conversationTitle(chat.messages, language)}</span><small>{formatChatDate(chat.savedAt, language)}</small>
                      </button>)}
                    </div> : <p className="chat-options-empty">{t("Новый чат сохраняет предыдущий здесь, чтобы вы могли к нему вернуться.", "Starting a new chat keeps the previous one here so you can return to it.")}</p>}
                    {resultSources.length > 0 && <section className="chat-options-sources" aria-label={t("Источники последнего ответа", "Sources for the latest answer")}>
                      <div className="chat-options-heading"><Layers3 size={14} /><span>{t("Источники последнего ответа", "Sources for the latest answer")}</span><small>{resultSources.length}</small></div>
                      <div className="chat-option-source-list">{resultSources.map((source) => <div key={source.id} className="chat-option-source">
                        <strong>{source.label}</strong>
                        <span>{[source.license, source.snapshotDate ? `${t("снимок", "snapshot")} ${source.snapshotDate}` : null].filter(Boolean).join(" · ") || source.mode}</span>
                      </div>)}</div>
                    </section>}
                    <p className="chat-history-note">{t("Хранится в этом браузере до 30 дней.", "Stored in this browser for up to 30 days.")}</p>
                    <button type="button" className="clear-history-option" disabled={pending || historyResetPending} onClick={(event) => { void resetHistory(); event.currentTarget.closest("details")?.removeAttribute("open"); }}><Trash2 size={14} /><span>{t("Удалить всю историю", "Delete all history")}</span></button>
                  </div>
                </details>
              </div>
            </div>
            <button type="button" className="section-toggle filters-toggle" aria-expanded={filtersExpanded} aria-controls="chat-filters" onClick={() => setFiltersExpanded((open) => !open)}><SlidersHorizontal size={15} /><span>{t("Фильтры", "Filters")}</span><small>{activeFilterCount ? `${activeFilterCount} ${t("активных", "active")}` : t("Источники и период", "Sources and date range")}</small><ChevronDown size={15} className="section-chevron" /></button>
            <div id="chat-filters" className={`inline-disclosure${filtersExpanded ? " is-open" : ""}`} aria-hidden={!filtersExpanded} inert={!filtersExpanded}>
              <div className="inline-disclosure-inner"><div className="scope-controls" aria-label={t("Фильтры запроса", "Query filters")}>
                <details className="source-filter">
                  <summary><span>{t("Источники", "Sources")}</span><strong>{selectedSourceIds.length ? `${t("Выбрано", "Selected")}: ${selectedSourceIds.length}` : t("Все", "All")}</strong></summary>
                  <div className="source-filter-menu">
                    {sources.map((source) => <label key={source.id} className="source-option">
                      <input type="checkbox" checked={selectedSourceIds.includes(source.id)} disabled={!selectedSourceIds.includes(source.id) && selectedSourceIds.length >= 20} onChange={(event) => setSelectedSourceIds((current) => event.target.checked ? [...current, source.id] : current.filter((id) => id !== source.id))} />
                      <span><strong>{source.label}</strong><small>{source.mode === "public_snapshot" ? t("Публичный снимок", "Public snapshot") : source.mode === "synthetic_local" ? t("Синтетические демо-данные", "Synthetic demo data") : source.mode}</small></span>
                    </label>)}
                    {!sources.length && <p className="source-empty">{sourceLoadFailed ? t("Не удалось загрузить источники", "Could not load sources") : capabilities?.assistantStatus === "data_unavailable" ? t("База данных пока недоступна", "Database is not available yet") : t("Источников пока нет", "No sources available")}</p>}
                    {selectedSourceIds.length > 0 && <button type="button" className="clear-sources" onClick={() => setSelectedSourceIds([])}>{t("Сбросить выбор · использовать все", "Clear selection · use all sources")}</button>}
                  </div>
                </details>
                <div className="date-filter">
                  <label>{t("С", "From")} <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
                  <label>{t("По", "To")} <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
                </div>
                {dateRangeInvalid && <p className="filter-error" role="alert">{t("Начало периода должно быть раньше окончания.", "The start date must be before the end date.")}</p>}
              </div></div>
            </div>
            <div className="messages-scroll-frame">
              <div className="messages" ref={messagesRef} onScroll={updateMessageScrollPosition} tabIndex={0} aria-label={t("Сообщения чата", "Chat messages")}>
                {messages.map((message, index) => <Fragment key={`${index}-${message.role}`}>
                {pending && message.streaming && index === messages.length - 1 && renderLiveProgress()}
                <article className={`message ${message.role}${message.streaming ? " streaming" : ""}`}>
                  {message.role === "assistant" && <span className="message-avatar"><Sparkles size={14} /></span>}
                  {message.role === "assistant" ? <div className="message-body"><div className="message-content"><Suspense fallback={<p>{message.text}</p>}><MarkdownMessage text={message.text} /></Suspense></div>{message.choices?.length ? <div className="clarification-choices">{message.choices.map((choice) => <button key={choice.id} type="button" disabled={pending} onClick={() => { setDraft(choice.label); composerRef.current?.focus(); }}>{choice.label}</button>)}</div> : null}{message.steps?.length ? <TurnSteps steps={message.steps} language={language} collapsed /> : null}{message.durationMs !== undefined && <span className="message-duration"><Clock3 size={12} aria-hidden="true" />{t("Время ответа", "Response time")} · {formatElapsed(message.durationMs, language)}</span>}</div> : <p>{message.text}</p>}
                </article></Fragment>)}
                {pending && !messages.at(-1)?.streaming && renderLiveProgress()}
              </div>
              <div className="chat-edge-fade chat-edge-fade-top" aria-hidden="true" />
              <div className="chat-edge-fade chat-edge-fade-bottom" aria-hidden="true" />
            </div>
            {historyClearWarning && <div className="history-warning" role="status">{historyClearWarning}</div>}
            {appliedFilters.length > 0 && <div className="applied-filters" aria-label={t("Применённые сервером фильтры", "Filters applied by the server")}>{formatAppliedFilters(appliedFilters, sourcesRef.current, language).map((filter) => <span key={filter}>{filter}</span>)}</div>}
            <div className="suggestions-panel">
              <div className="suggestions-heading">
                <button type="button" className="section-toggle suggestions-toggle" aria-expanded={suggestionsExpanded} aria-controls="suggested-requests" onClick={() => setSuggestionsExpanded((open) => !open)}>
                  <Sparkles size={14} /><span>{t("Актуальные подсказки", "Suggested follow-ups")}</span><small>{activeSuggestions.length}</small><ChevronDown size={14} className="section-chevron" />
                </button>
                {suggestionsExpanded && <button type="button" className="refresh-suggestions" onClick={() => setSuggestionOffset((offset) => (offset + 1) % activeSuggestions.length)} aria-label={t("Обновить подсказки", "Refresh suggestions")} title={t("Показать другие подсказки", "Show other suggestions")}><RefreshCw size={13} /><span>{t("Другие", "More")}</span></button>}
              </div>
              <div id="suggested-requests" className={`inline-disclosure${suggestionsExpanded ? " is-open" : ""}`} aria-hidden={!suggestionsExpanded} inert={!suggestionsExpanded}>
                <div className="inline-disclosure-inner">
                  {suggestionsExpanded && <div className="suggestions" aria-label={t("Рекомендуемые запросы", "Suggested prompts")}>{visibleSuggestions.map((reply) => <button key={reply.label} onClick={() => chooseReply(reply.prompt)}><span>{reply.label}</span><ArrowUpRight size={14} /></button>)}</div>}
                </div>
              </div>
            </div>
            <form className="composer" onSubmit={submit}>
              <textarea ref={composerRef} value={draft} readOnly={voice.state !== "idle"} onChange={(event) => updateDraft(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={t("Введите запрос · Enter — отправить, Shift+Enter — новая строка", "Ask a question · Enter to send, Shift+Enter for a new line")} rows={2} aria-label={t("Сообщение помощнику", "Message the assistant")} />
              <div className="composer-footer">
                <span className={voiceStatus ? `voice-status ${voice.state}${voice.issue ? " issue" : ""}` : undefined} role="status" aria-live="polite">
                  {voiceStatus ?? t("Данные обрабатываются локально", "Data is processed locally")}
                </span>
                <div className="composer-actions">
                  {pending && <button type="button" className="cancel-request" onClick={cancelRequest}><Square size={12} />{t("Остановить", "Stop")}</button>}
                  {capabilities?.voiceInput && (
                    <MicButton
                      language={language}
                      state={voice.state}
                      disabled={connection !== "connected"}
                      onStart={startVoiceInput}
                      onStop={voice.stop}
                    />
                  )}
                  <button type="submit" disabled={!draft.trim() || pending || voice.state !== "idle" || dateRangeInvalid || connection !== "connected"} aria-label={t("Отправить запрос", "Send request")}><ArrowUp size={17} /></button>
                </div>
              </div>
            </form>
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

          {mapMode === "assistant" ? <MapPanel language={language} pinned={pinned} overlayRecords={mapLayers.events ? eventsLayer.data?.events ?? [] : []} layers={mapLayers} onLayers={setMapLayers} onAsk={askAboutSelection} highlights={mapPlaces} records={mapRecords} tripPlan={tripPlan} radius={searchArea} sourceIds={selectedSourceIds} selectedResultKey={selectedResultKey} onSelectResult={setSelectedResultKey} sourceLabels={sourceLabels} sourceDates={Object.fromEntries(sources.flatMap((source) => source.snapshotDate ? [[source.id, source.snapshotDate]] : []))} resultsLoaded={resultsLoaded} resetViewportRevision={resetViewportRevision} />
            : mapMode === "events" ? <MapPanel language={language} variant="investigation" heading={{ eyebrow: t("СОБЫТИЯ · OPENSTREETMAP", "EVENTS · OPENSTREETMAP"), title: t("События и места рядом", "Events and nearby places") }} records={eventsScene.records} recordSourceModes={eventsScene.recordSourceModes} highlights={eventsScene.highlights} radius={eventsScene.radius} focus={eventsScene.focus} selectedResultKey={eventsScene.selectedKey} onSelectResult={(key) => eventsSelectRef.current?.(key)} sourceLabels={eventsScene.sourceLabels} resultsLoaded={eventsScene.resultsLoaded} />
              : <MapPanel language={language} variant="investigation" fit="results" heading={{ eyebrow: t("МЕСТА · OPENSTREETMAP", "PLACES · OPENSTREETMAP"), title: t("Каталог мест", "Place catalog") }} highlights={placesScene.highlights} selectedResultKey={placesScene.selectedKey} onSelectResult={(key) => placesSelectRef.current?.(key)} sourceLabels={sourceLabels} resultsLoaded={placesScene.resultsLoaded} />}
        </div>}
        <footer className="app-footer">
          <div className="app-footer-brand">
            <span className="footer-brand-mark"><Logo size={30} title="" /></span>
            <div><strong>Waypoint AI</strong><span>{pageCaption(activePage, language)}</span></div>
          </div>
          <div className="app-footer-controls">
            {capabilities?.demoMode && <span className="demo-badge">DEMO</span>}
            <span className={`status-pill ${status}`} title={capabilities?.modelLabel ?? t("Локальная модель", "Local model")}><i />{capabilities?.modelLabel ?? t("Локальная модель", "Local model")} · {statusText}</span>
            <span className={`connection ${connection}`} role="status"><i />{connectionLabel(connection, reconnectInfo, language)}</span>
            {reconnectInfo && <button className="retry-button" type="button" onClick={() => connectionRef.current?.reconnectNow()}>{t("Подключиться сейчас", "Connect now")}</button>}
            <div className="language-tabs" role="group" aria-label={t("Язык интерфейса", "Interface language")}>
              {(["en", "ru", "de"] as const).map((option) => <button key={option} type="button" lang={option} aria-pressed={language === option} aria-label={option === "en" ? "English" : option === "ru" ? "Русский" : "Deutsch"} onClick={() => setLanguage(option)}>{option.toUpperCase()}</button>)}
            </div>
          </div>
        </footer>
      </section>
      <ImportLayer language={language} />
    </main>
  );
}

function joinDraft(base: string, transcript: string): string {
  const trimmedBase = base.trimEnd();
  const trimmedTranscript = transcript.trim();
  if (!trimmedBase) return trimmedTranscript;
  if (!trimmedTranscript) return trimmedBase;
  return `${trimmedBase} ${trimmedTranscript}`;
}

function conversationTitle(messages: Message[], language: Language = "en"): string {
  const firstRequest = messages.find((message) => message.role === "user")?.text.trim();
  if (!firstRequest) return translate(language, "Новый запрос", "New chat");
  return firstRequest.length > 42 ? `${firstRequest.slice(0, 42).trimEnd()}…` : firstRequest;
}

function formatChatDate(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : language === "de" ? "de-DE" : "en-US", { day: "numeric", month: "short" }).format(timestamp);
}

function elapsedSince(startedAt: number | null): number {
  return startedAt === null ? 0 : Math.max(0, Math.round(performance.now() - startedAt));
}

function formatElapsed(milliseconds: number, language: Language): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (language === "ru") return minutes ? `${minutes} мин ${String(seconds).padStart(2, "0")} с` : `${seconds} с`;
  if (language === "de") return minutes ? `${minutes} Min. ${String(seconds).padStart(2, "0")} Sek.` : `${seconds} Sek.`;
  return minutes ? `${minutes} min ${String(seconds).padStart(2, "0")} sec` : `${seconds} sec`;
}

function localDateBoundary(value: string, endOfDay: boolean): string {
  return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}`).toISOString();
}

function invalidDateRange(from: string, to: string): boolean {
  return Boolean(from && to && from > to);
}

function formatAppliedFilters(filters: Array<Record<string, unknown>>, sources: SourceView[], language: Language): string[] {
  const ru = language === "ru";
  const de = language === "de";
  const sourceNames = new Map(sources.map((source) => [source.id, source.label]));
  return filters.flatMap((filter) => {
    if (filter.key === "sourceIds" && Array.isArray(filter.value)) {
      const names = filter.value.filter((id): id is string => typeof id === "string").map((id) => sourceNames.get(id) ?? id);
      return names.length ? [`${ru ? "Источники" : de ? "Quellen" : "Sources"}: ${names.join(", ")}`] : [];
    }
    if (filter.key === "dateRange" && filter.value && typeof filter.value === "object") {
      const range = filter.value as { from?: unknown; to?: unknown };
      const locale = ru ? "ru-RU" : de ? "de-DE" : "en-US";
      const from = typeof range.from === "string" ? new Date(range.from).toLocaleDateString(locale) : "…";
      const to = typeof range.to === "string" ? new Date(range.to).toLocaleDateString(locale) : "…";
      return [`${ru ? "Период" : de ? "Zeitraum" : "Date range"}: ${from} — ${to}`];
    }
    if (filter.key === "category" && typeof filter.value === "string") return [`${ru ? "Категория" : de ? "Kategorie" : "Category"}: ${filter.value}`];
    return [];
  });
}

function connectionLabel(connection: ConnectionState, reconnect: ReconnectInfo, language: Language): string {
  if (connection === "connected") return translate(language, "Соединение активно", "Connected");
  if (!reconnect) return translate(language, "Подключаемся", "Connecting");
  const seconds = Math.max(1, Math.round(reconnect.retryInMs / 1000));
  if (language === "ru") return `Переподключение через ${seconds} с · попытка ${reconnect.attempt}`;
  if (language === "de") return `Neuverbindung in ${seconds} s · Versuch ${reconnect.attempt}`;
  return `Reconnecting in ${seconds} s · attempt ${reconnect.attempt}`;
}

/** Ends the streaming state of the last message; its partial text stays visible. */
function endStreaming(messages: Message[]): Message[] {
  const last = messages.at(-1);
  return last?.streaming ? [...messages.slice(0, -1), { role: last.role, text: last.text }] : messages;
}
