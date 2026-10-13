import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ServerFrame, VoiceErrorCode } from "@waypoint-ai/shared";
import { sendClientFrame, type ConnectionState } from "../../shared/api/client";
import type { Language } from "../../shared/i18n";
import workletUrl from "./pcm-recorder.worklet?worker&url";

export type VoiceState = "idle" | "starting" | "recording" | "finishing";
export type VoiceIssue = "permission_denied" | "no_microphone" | "unsupported" | "disconnected" | VoiceErrorCode;

type VoiceFrame = Extract<ServerFrame, { type: `voice.${string}` }>;

interface VoiceSession {
  requestId: string;
  started: boolean;
  ready: boolean;
  pendingAudio: string[];
  transcript: string;
  stream?: MediaStream;
  context?: AudioContext;
  node?: AudioWorkletNode;
}

// Keep up to ~3 s of audio captured before the backend reports voice.ready.
const MAX_PENDING_CHUNKS = 30;

interface VoiceInputOptions {
  socketRef: RefObject<WebSocket | null>;
  connection: ConnectionState;
  language: Language;
  /** Receives the full transcript recognized so far in the current recording. */
  onTranscript: (transcript: string) => void;
}

export function isVoiceFrame(frame: ServerFrame): frame is VoiceFrame {
  return frame.type.startsWith("voice.");
}

export function useVoiceInput({ socketRef, connection, language, onTranscript }: VoiceInputOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [issue, setIssue] = useState<VoiceIssue | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const end = useCallback((nextIssue: VoiceIssue | null) => {
    const session = sessionRef.current;
    if (!session) return;
    releaseAudio(session);
    sessionRef.current = null;
    setState("idle");
    setIssue(nextIssue);
  }, []);

  const sendAudio = useCallback((session: VoiceSession, audio: string) => {
    if (sessionRef.current !== session) return;
    if (!session.ready) {
      session.pendingAudio.push(audio);
      if (session.pendingAudio.length > MAX_PENDING_CHUNKS) session.pendingAudio.shift();
      return;
    }
    sendClientFrame(socketRef.current, { protocolVersion: 1, type: "voice.audio", requestId: session.requestId, audio });
  }, [socketRef]);

  const start = useCallback(async () => {
    if (sessionRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      setIssue("unsupported");
      return;
    }
    const session: VoiceSession = { requestId: crypto.randomUUID(), started: false, ready: false, pendingAudio: [], transcript: "" };
    sessionRef.current = session;
    setIssue(null);
    setState("starting");

    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (sessionRef.current !== session) {
        releaseAudio(session);
        return;
      }
      session.context = new AudioContext();
      await session.context.audioWorklet.addModule(workletUrl);
      if (sessionRef.current !== session) {
        releaseAudio(session);
        return;
      }
      const source = session.context.createMediaStreamSource(session.stream);
      const node = new AudioWorkletNode(session.context, "pcm-recorder");
      // A muted sink keeps the worklet in the rendering graph without playing the microphone back.
      const sink = session.context.createGain();
      sink.gain.value = 0;
      source.connect(node).connect(sink).connect(session.context.destination);
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => sendAudio(session, encodeBase64(event.data));
      session.node = node;
    } catch (error) {
      if (sessionRef.current === session) end(microphoneIssue(error));
      else releaseAudio(session);
      return;
    }

    session.started = sendClientFrame(socketRef.current, { protocolVersion: 1, type: "voice.start", requestId: session.requestId, language });
    if (!session.started) {
      end("disconnected");
      return;
    }
    setState("recording");
  }, [end, language, sendAudio, socketRef]);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (!session.started) {
      end(null);
      return;
    }
    // Release the microphone immediately; the backend still finalizes the transcript.
    releaseAudio(session);
    sendClientFrame(socketRef.current, { protocolVersion: 1, type: "voice.stop", requestId: session.requestId });
    setState("finishing");
  }, [end, socketRef]);

  const handleFrame = useCallback((frame: VoiceFrame) => {
    const session = sessionRef.current;
    if (!session || frame.requestId !== session.requestId) return;
    if (frame.type === "voice.ready") {
      session.ready = true;
      const pendingAudio = session.pendingAudio.splice(0);
      for (const audio of pendingAudio) sendAudio(session, audio);
    } else if (frame.type === "voice.transcript.delta") {
      session.transcript += frame.text;
      onTranscriptRef.current(session.transcript);
    } else if (frame.type === "voice.transcript.completed") {
      session.transcript = frame.text;
      onTranscriptRef.current(session.transcript);
    } else if (frame.type === "voice.stopped") {
      end(null);
    } else if (frame.type === "voice.error") {
      end(frame.code);
    }
  }, [end, sendAudio]);

  useEffect(() => {
    if (connection !== "connected") end(sessionRef.current ? "disconnected" : null);
  }, [connection, end]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (!session) return;
    releaseAudio(session);
    if (session.started) sendClientFrame(socketRef.current, { protocolVersion: 1, type: "voice.stop", requestId: session.requestId });
    sessionRef.current = null;
  }, [socketRef]);

  const dismissIssue = useCallback(() => setIssue(null), []);

  return { state, issue, start, stop, handleFrame, dismissIssue };
}

function releaseAudio(session: VoiceSession): void {
  if (session.node) {
    session.node.port.onmessage = null;
    session.node.disconnect();
    session.node = undefined;
  }
  session.stream?.getTracks().forEach((track) => track.stop());
  session.stream = undefined;
  if (session.context && session.context.state !== "closed") void session.context.close();
  session.context = undefined;
}

function microphoneIssue(error: unknown): VoiceIssue {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) return "permission_denied";
  if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "OverconstrainedError" || error.name === "NotReadableError")) return "no_microphone";
  return "unsupported";
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
