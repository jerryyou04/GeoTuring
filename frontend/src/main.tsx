import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { io, Socket } from "socket.io-client";
import "@fontsource-variable/inter";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import {
  ADMIN_CONSOLE_PATH,
  EMPTY_TURN_STATE,
  FINAL_GUESS_SECONDS,
  HISTORY_PATH,
  LEADERBOARD_PATH,
  MATCH_FOUND_HOLD_MS,
  MIN_MESSAGES_PER_SIDE,
  SOCKET_URL,
} from "./config";
import type {
  ChatErrorPayload,
  ChatMessage,
  ChatSendAck,
  GuessErrorPayload,
  IdentityGuess,
  IpLocation,
  ModelFamily,
  Phase,
  PersistentScore,
  Pin,
  QueueErrorPayload,
  QueueStatus,
  QueueStatusPayload,
  ResultPayload,
  ServerClockPayload,
  SessionCreatedPayload,
  SessionResumedPayload,
  TurnStatePayload,
} from "./types";
import {
  getVisibleMessageCounts,
  hasValidIpLocation,
  toLocationNumber,
} from "./utils";
import {
  loadActiveSessionId,
  loadIpLocation,
  loadLocationConsent,
  loadOrCreatePlayerId,
  loadPersistentScore,
  removeActiveSessionId,
  removeIpLocation,
  saveActiveSessionId,
  saveIpLocation,
  saveLocationConsent,
  savePersistentScore,
} from "./storage";
import { AdminConsole } from "./components/AdminConsole";
import { ChatRoom } from "./components/ChatRoom";
import { History } from "./components/History";
import { Leaderboard } from "./components/Leaderboard";
import {
  AiGuessScreen,
  HumanGuessScreen,
  IdentityGuessScreen,
  WaitingGuessScreen,
} from "./components/GuessScreens";
import { Landing } from "./components/Landing";
import { Matchmaking } from "./components/Matchmaking";
import { HistoryIcon, LeaderboardIcon } from "./components/NavIcons";
import { Reveal } from "./components/Reveal";
import { StatusPill } from "./components/StatusPill";

function App() {
  const path = window.location.pathname;

  if (path === ADMIN_CONSOLE_PATH) {
    return <AdminConsole />;
  }

  if (path === HISTORY_PATH) {
    return <History />;
  }

  if (path === LEADERBOARD_PATH) {
    return <Leaderboard />;
  }

  return <GameApp />;
}

function GameApp() {
  const playerIdRef = useRef(loadOrCreatePlayerId());
  const currentSessionIdRef = useRef(loadActiveSessionId() || "");
  const socketRef = useRef<Socket | null>(null);
  const gameGenerationRef = useRef(0);
  const sendingMessageRef = useRef(false);
  const pendingMessageRef = useRef<{
    sessionId: string;
    clientMessageId: string;
    requestId: string;
    text: string;
  } | null>(null);
  const activeSendRequestRef = useRef("");
  const locallyEndedSessionRef = useRef("");
  const terminalSessionRef = useRef<{
    sessionId: string;
    phase: "ended" | "reveal";
  } | null>(null);
  const systemMessageSequenceRef = useRef(0);
  const serverClockOffsetRef = useRef(0);
  const hasSyncedServerClockRef = useRef(false);
  const queueStartedAtRef = useRef<number | null>(null);
  const queueFoundAtRef = useRef<number | null>(null);
  const queueTimersRef = useRef<number[]>([]);
  const hiddenAiRequestPendingRef = useRef(false);
  const scoredSessionsRef = useRef<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>(() => currentSessionIdRef.current ? "matching" : "landing");
  const [connection, setConnection] = useState("idle");
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionId, setSessionId] = useState(currentSessionIdRef.current);
  const [chatEndsAt, setChatEndsAt] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [identityGuess, setIdentityGuess] = useState<IdentityGuess | null>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [modelGuess, setModelGuess] = useState<ModelFamily | null>(null);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [endMessage, setEndMessage] = useState("");
  const [turnState, setTurnState] = useState<TurnStatePayload>(EMPTY_TURN_STATE);
  const [pendingGuessConfirm, setPendingGuessConfirm] = useState(false);
  const [finalGuessEndsAt, setFinalGuessEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [queueStatus, setQueueStatus] = useState<QueueStatus>(() => currentSessionIdRef.current ? "found" : "idle");
  const [connectedProfiles, setConnectedProfiles] = useState(() => currentSessionIdRef.current ? 2 : 0);
  const [requiredProfiles, setRequiredProfiles] = useState(2);
  const [queueStartedAt, setQueueStartedAt] = useState<number | null>(null);
  const [queueFrozenSeconds, setQueueFrozenSeconds] = useState<number | null>(null);
  const [persistentScore, setPersistentScore] = useState<PersistentScore>(() => loadPersistentScore());
  const [locationConsent, setLocationConsent] = useState(() => loadLocationConsent());
  const [ipLocation, setIpLocation] = useState<IpLocation | null>(() => loadIpLocation());
  const [locationStatus, setLocationStatus] = useState("idle");

  const secondsLeft = useMemo(() => {
    if (!chatEndsAt) {
      return 0;
    }

    return Math.max(0, Math.ceil((chatEndsAt - now) / 1000));
  }, [chatEndsAt, now]);
  const chatTimerExpired = phase === "chat" && chatEndsAt !== null && chatEndsAt <= now;
  const turnTimerExpired =
    phase === "chat" &&
    turnState.currentTurn !== "paused" &&
    turnState.turnEndsAt !== null &&
    turnState.turnEndsAt <= now;

  const actualQueueSeconds = useMemo(() => {
    if (queueStatus === "found" && queueFrozenSeconds !== null) {
      return queueFrozenSeconds;
    }

    if (!queueStartedAt) {
      return 0;
    }

    return Math.max(0, Math.floor((now - queueStartedAt) / 1000));
  }, [now, queueFrozenSeconds, queueStartedAt, queueStatus]);

  const chatCounts = turnState.counts || getVisibleMessageCounts(messages);
  const hasRequiredMessages =
    chatCounts.player >= MIN_MESSAGES_PER_SIDE &&
    chatCounts.partner >= MIN_MESSAGES_PER_SIDE;
  const canGuess =
    sessionReady &&
    !chatTimerExpired &&
    !turnTimerExpired &&
    hasRequiredMessages;
  const isPlayerTurn =
    phase === "chat" &&
    sessionReady &&
    turnState.currentTurn === "player" &&
    !chatTimerExpired &&
    !turnTimerExpired;
  const isFinalGuessPhase = phase === "identity" || phase === "humanGuess" || phase === "aiGuess" || phase === "waitingGuess";
  const finalGuessExpired = isFinalGuessPhase && finalGuessEndsAt !== null && finalGuessEndsAt <= now;
  const turnSecondsLeft = turnState.turnEndsAt !== null
    ? Math.max(0, Math.ceil((turnState.turnEndsAt - now) / 1000))
    : 0;
  const finalGuessSecondsLeft = finalGuessEndsAt
    ? Math.max(0, Math.ceil((finalGuessEndsAt - now) / 1000))
    : FINAL_GUESS_SECONDS;

  useEffect(() => {
    if (phase !== "chat" && phase !== "matching" && !isFinalGuessPhase) {
      return;
    }

    const timer = window.setInterval(() => setNow(getServerNow()), 500);

    return () => window.clearInterval(timer);
  }, [isFinalGuessPhase, phase]);

  useEffect(() => {
    if (phase !== "chat" && !isFinalGuessPhase) {
      return;
    }

    const nextDeadline = [chatEndsAt, turnState.turnEndsAt, finalGuessEndsAt]
      .filter((deadline): deadline is number => deadline !== null && deadline > getServerNow())
      .sort((first, second) => first - second)[0];

    if (!nextDeadline) {
      return;
    }

    const timer = window.setTimeout(() => setNow(getServerNow()), Math.max(0, nextDeadline - getServerNow()));

    return () => window.clearTimeout(timer);
  }, [chatEndsAt, finalGuessEndsAt, isFinalGuessPhase, phase, turnState.turnEndsAt]);

  useEffect(() => {
    const activeSessionId = currentSessionIdRef.current;
    const timeoutMessage = chatTimerExpired
      ? "The round ended because time ran out before enough messages were exchanged."
      : turnTimerExpired
        ? "The round auto-aborted because the turn timer expired before enough messages were exchanged."
        : "";

    if (
      phase !== "chat" ||
      hasRequiredMessages ||
      !activeSessionId ||
      !timeoutMessage ||
      locallyEndedSessionRef.current === activeSessionId
    ) {
      return;
    }

    locallyEndedSessionRef.current = activeSessionId;
    sendingMessageRef.current = false;
    setSessionReady(false);
    setPendingGuessConfirm(false);
    setEndMessage(timeoutMessage);
    setTurnState((current) => ({
      ...current,
      currentTurn: "paused",
      turnEndsAt: null,
    }));
    setPhase("ended");
  }, [chatTimerExpired, hasRequiredMessages, phase, turnTimerExpired]);

  useEffect(() => {
    if (locationConsent && !ipLocation && locationStatus === "idle") {
      fetchIpLocation();
    }
  }, [locationConsent, ipLocation, locationStatus]);

  useEffect(() => {
    const activeSessionId = currentSessionIdRef.current;

    if (activeSessionId) {
      resumeActiveSession(activeSessionId);
    }
  }, []);

  useEffect(() => {
    return () => {
      clearQueueUiTimers();
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    if (phase !== "matching") {
      return;
    }

    function handleHiddenQueueShortcut(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.altKey || event.metaKey || event.repeat) {
        return;
      }

      const target = event.target as HTMLElement | null;

      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }

      const shortcuts: Record<string, ModelFamily | "random"> = {
        "1": "ChatGPT",
        "2": "Gemini",
        "3": "Claude",
        "4": "Grok",
        "0": "random",
      };
      const requested = shortcuts[event.key];

      if (!requested) {
        return;
      }

      event.preventDefault();
      requestImmediateAiMatch(requested === "random" ? null : requested);
    }

    window.addEventListener("keydown", handleHiddenQueueShortcut);

    return () => window.removeEventListener("keydown", handleHiddenQueueShortcut);
  }, [phase, ipLocation, locationConsent]);

  function clearQueueUiTimers() {
    queueTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    queueTimersRef.current = [];
  }

  function replaceGameSocket() {
    const previousSocket = socketRef.current;
    socketRef.current = null;
    previousSocket?.removeAllListeners();
    previousSocket?.disconnect();

    const generation = ++gameGenerationRef.current;
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });
    socketRef.current = socket;

    return { generation, socket };
  }

  function isCurrentAttempt(socket: Socket, generation: number) {
    return socketRef.current === socket && gameGenerationRef.current === generation;
  }

  function isCurrentSessionEvent(
    socket: Socket,
    generation: number,
    payload: { sessionId?: string },
  ) {
    return isCurrentAttempt(socket, generation) &&
      Boolean(payload.sessionId) &&
      payload.sessionId === currentSessionIdRef.current;
  }

  function rememberSession(nextSessionId: string) {
    currentSessionIdRef.current = nextSessionId;
    setSessionId(nextSessionId);
    saveActiveSessionId(nextSessionId);
  }

  function removeStoredSessionIfCurrent(expectedSessionId: string) {
    if (expectedSessionId && loadActiveSessionId() === expectedSessionId) {
      removeActiveSessionId();
    }
  }

  function forgetCurrentSession(removeStoredSession = true) {
    const forgottenSessionId = currentSessionIdRef.current;
    currentSessionIdRef.current = "";
    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = null;
    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    setSessionId("");
    if (removeStoredSession) {
      removeStoredSessionIfCurrent(forgottenSessionId);
    }
    setSessionReady(false);
    sendingMessageRef.current = false;
  }

  function appendMessage(message: ChatMessage) {
    setMessages((current) => current.some((item) => item.id === message.id)
      ? current
      : [...current, message]);
  }

  function appendSystemMessage(sessionId: string, kind: string, text: string) {
    systemMessageSequenceRef.current += 1;
    appendMessage({
      id: `system:${sessionId}:${kind}:${systemMessageSequenceRef.current}`,
      author: "system",
      text,
      sentAt: Date.now(),
    });
  }

  function getServerNow() {
    return Date.now() + serverClockOffsetRef.current;
  }

  function syncServerClock(payload?: ServerClockPayload) {
    const clientNow = Date.now();
    const hasPayloadClock = payload && Number.isFinite(payload.serverNow);

    if (hasPayloadClock && !hasSyncedServerClockRef.current) {
      serverClockOffsetRef.current = Number(payload.serverNow) - clientNow;
    }

    const adjustedNow = clientNow + serverClockOffsetRef.current;
    setNow(adjustedNow);
    return adjustedNow;
  }

  function requestServerClockSync(socket: Socket, generation: number) {
    const sentAt = Date.now();

    socket.timeout(2000).emit("clock:sync", {}, (error: unknown, payload?: ServerClockPayload) => {
      if (!isCurrentAttempt(socket, generation) || error || !payload || !Number.isFinite(payload.serverNow)) {
        return;
      }

      const receivedAt = Date.now();
      const midpoint = sentAt + (receivedAt - sentAt) / 2;
      serverClockOffsetRef.current = Number(payload.serverNow) - midpoint;
      hasSyncedServerClockRef.current = true;
      setNow(getServerNow());
    });
  }

  function applyQueueStatus(payload: QueueStatusPayload) {
    syncServerClock(payload);
    const queuedAt = Number.isFinite(payload.queuedAt)
      ? payload.queuedAt
      : queueStartedAtRef.current || getServerNow();

    setConnectedProfiles(payload.connectedProfiles);
    setRequiredProfiles(payload.requiredProfiles);
    setQueueStartedAt(queuedAt);
    queueStartedAtRef.current = queuedAt;

    if (payload.status === "found") {
      markQueueFound(queuedAt);
      return;
    }

    setQueueStatus(payload.status);
    queueFoundAtRef.current = null;
    setQueueFrozenSeconds(null);
  }

  function markQueueFound(queuedAt = queueStartedAtRef.current || getServerNow()) {
    const foundAt = queueFoundAtRef.current || getServerNow();

    queueFoundAtRef.current = foundAt;
    queueStartedAtRef.current = queuedAt;
    setQueueStartedAt(queuedAt);
    setQueueStatus("found");
    setConnectedProfiles(2);
    setRequiredProfiles(2);
    setQueueFrozenSeconds((current) => current ?? Math.max(0, Math.floor((foundAt - queuedAt) / 1000)));
  }

  function finishSessionAsEnded(payload: { sessionId?: string; message?: string; serverNow?: number } = {}) {
    if (Number.isFinite(payload.serverNow)) {
      syncServerClock(payload);
    }

    clearQueueUiTimers();
    removeStoredSessionIfCurrent(payload.sessionId || currentSessionIdRef.current);
    const message = payload.message || "This round ended.";
    const endedSessionId = payload.sessionId || currentSessionIdRef.current || "current";
    const messageId = `session-ended:${endedSessionId}`;

    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = {
      sessionId: endedSessionId,
      phase: "ended",
    };
    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    setSessionReady(false);
    sendingMessageRef.current = false;
    setEndMessage(message);
    setPendingGuessConfirm(false);
    setFinalGuessEndsAt(null);
    setTurnState((current) => ({
      ...current,
      currentTurn: "paused",
      turnEndsAt: null,
    }));
    appendMessage({
      id: messageId,
      author: "system",
      text: message,
      sentAt: Date.now(),
    });
    setPhase("ended");
  }

  function registerSocketStateListeners(socket: Socket, generation: number) {
    socket.on("disconnect", () => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      setSessionReady(false);
      sendingMessageRef.current = false;
      activeSendRequestRef.current = "";
      const pendingMessage = pendingMessageRef.current;

      if (pendingMessage?.sessionId === currentSessionIdRef.current) {
        setDraft((current) => current || pendingMessage.text);
      }
      setConnection("disconnected");
    });

    socket.on("connect_error", () => {
      if (isCurrentAttempt(socket, generation)) {
        setConnection("offline");
      }
    });
  }

  function registerSessionListeners(socket: Socket, generation: number) {
    socket.on("partner:message", (payload: { sessionId: string; message: ChatMessage }) => {
      if (isCurrentSessionEvent(socket, generation, payload)) {
        appendMessage(payload.message);
      }
    });

    socket.on("turn:update", (payload: TurnStatePayload) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      syncServerClock(payload);
      setTurnState(payload);

      if (
        locallyEndedSessionRef.current === payload.sessionId &&
        payload.turnEndsAt !== null &&
        payload.turnEndsAt > getServerNow()
      ) {
        locallyEndedSessionRef.current = "";
        setEndMessage("");
        setSessionReady(true);
        setPhase("chat");
      }

      if (payload.message) {
        appendSystemMessage(payload.sessionId, "turn", payload.message);
      }
    });

    socket.on("chat:error", (payload: ChatErrorPayload) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      const pendingMessage = pendingMessageRef.current;

      if (
        !payload.requestId ||
        activeSendRequestRef.current !== payload.requestId ||
        pendingMessage?.requestId !== payload.requestId
      ) {
        return;
      }

      activeSendRequestRef.current = "";
      sendingMessageRef.current = false;
      pendingMessageRef.current = null;
      setDraft((current) => current || pendingMessage.text);
      appendSystemMessage(
        payload.sessionId!,
        `chat-error:${payload.code || "unknown"}`,
        payload.message || "Wait for your turn before sending a message.",
      );
    });

    socket.on("guess:error", (payload: GuessErrorPayload) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      setPendingGuessConfirm(false);
      setFinalGuessEndsAt(null);
      appendSystemMessage(
        payload.sessionId!,
        `guess-error:${payload.code || "unknown"}`,
        payload.message || "More messages are required before guessing.",
      );
      setPhase("chat");
    });

    socket.on(
      "round:locked",
      (payload: { sessionId: string; message?: string; guessEndsAt?: number; serverNow?: number }) => {
        if (!isCurrentSessionEvent(socket, generation, payload)) {
          return;
        }

        syncServerClock(payload);
        locallyEndedSessionRef.current = "";
        pendingMessageRef.current = null;
        activeSendRequestRef.current = "";
        sendingMessageRef.current = false;
        setPendingGuessConfirm(false);
        setFinalGuessEndsAt(payload.guessEndsAt || null);
        setTurnState((current) => ({
          ...current,
          currentTurn: "paused",
          turnEndsAt: null,
        }));
        appendSystemMessage(
          payload.sessionId,
          "round-locked",
          payload.message || "The chat is locked. Make your final read.",
        );
        setPhase((current) => (
          terminalSessionRef.current?.sessionId === payload.sessionId &&
          terminalSessionRef.current.phase === "reveal"
            ? current
            : current === "waitingGuess" ? current : "identity"
        ));
      },
    );

    socket.on("partner:left", (payload: { sessionId: string; message?: string }) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      appendSystemMessage(
        payload.sessionId,
        "partner-left",
        payload.message || "Your partner disconnected. You can still make your guess.",
      );
    });

    socket.on("session:ended", (payload: { sessionId: string; message?: string; serverNow?: number }) => {
      if (isCurrentSessionEvent(socket, generation, payload)) {
        finishSessionAsEnded(payload);
      }
    });

    socket.on("session:result", (payload: ResultPayload) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      setNow(getServerNow());
      locallyEndedSessionRef.current = "";
      terminalSessionRef.current = {
        sessionId: payload.sessionId,
        phase: "reveal",
      };
      pendingMessageRef.current = null;
      activeSendRequestRef.current = "";
      setSessionReady(false);
      sendingMessageRef.current = false;
      recordPersistentScore(payload);
      setResult(payload);
      setFinalGuessEndsAt(null);
      removeStoredSessionIfCurrent(payload.sessionId);
      setPhase("reveal");
    });

    socket.on(
      "opponent:guess",
      (payload: {
        sessionId: string;
        opponentGuess: ResultPayload["opponentGuess"];
        opponentExplanation?: string | null;
      }) => {
        if (!isCurrentSessionEvent(socket, generation, payload)) {
          return;
        }

        setResult((current) => current
          ? {
              ...current,
              opponentGuess: payload.opponentGuess,
              opponentExplanation: payload.opponentExplanation ?? null,
              opponentPending: false,
            }
          : current);
      },
    );

    socket.on("session:superseded", (payload: { sessionId: string }) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      clearQueueUiTimers();
      forgetCurrentSession(false);
      setConnection("idle");
      setMessages([]);
      setPhase("landing");
    });
  }

  function resumeActiveSession(activeSessionId: string) {
    clearQueueUiTimers();
    currentSessionIdRef.current = activeSessionId;
    setSessionId(activeSessionId);
    setSessionReady(false);
    setPhase("matching");
    setQueueStatus("found");
    setConnectedProfiles(2);
    setConnection("connecting");
    const { generation, socket } = replaceGameSocket();
    registerSocketStateListeners(socket, generation);
    registerSessionListeners(socket, generation);

    socket.on("connect", () => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      setConnection("connected");
      setSessionReady(false);
      requestServerClockSync(socket, generation);
      socket.emit("session:resume", {
        playerId: playerIdRef.current,
        sessionId: activeSessionId,
      });
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
      if (!isCurrentAttempt(socket, generation) || payload.sessionId !== currentSessionIdRef.current) {
        return;
      }

      syncServerClock(payload);
      rememberSession(payload.sessionId);
      enterResumedSession(payload);
      setSessionReady(true);
    });

    socket.on("session:resume_failed", () => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      if (terminalSessionRef.current?.sessionId === currentSessionIdRef.current) {
        socketRef.current = null;
        socket.removeAllListeners();
        socket.disconnect();
        setSessionReady(false);
        setConnection("idle");
        return;
      }

      socketRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
      forgetCurrentSession();
      setConnection("idle");
      setPhase("landing");
    });
  }

  function startMatchmaking() {
    if (!locationConsent) {
      setLocationStatus("required");
      return;
    }

    if (!hasValidIpLocation(ipLocation)) {
      setLocationStatus(ipLocation ? "invalid" : "required");
      fetchIpLocation();
      return;
    }

    clearQueueUiTimers();

    const queuedAt = getServerNow();

    setPhase("matching");
    setConnection("connecting");
    setResult(null);
    setEndMessage("");
    setDraft("");
    setTurnState(EMPTY_TURN_STATE);
    setPendingGuessConfirm(false);
    setFinalGuessEndsAt(null);
    setIdentityGuess(null);
    setPin(null);
    setModelGuess(null);
    setMessages([]);
    setQueueStatus("searching");
    hiddenAiRequestPendingRef.current = false;
    setConnectedProfiles(1);
    setRequiredProfiles(2);
    setQueueStartedAt(queuedAt);
    queueStartedAtRef.current = queuedAt;
    queueFoundAtRef.current = null;
    setQueueFrozenSeconds(null);
    setNow(queuedAt);
    currentSessionIdRef.current = "";
    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = null;
    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    setSessionId("");
    setSessionReady(false);
    sendingMessageRef.current = false;
    removeActiveSessionId();

    const { generation, socket } = replaceGameSocket();
    registerSocketStateListeners(socket, generation);
    registerSessionListeners(socket, generation);

    socket.on("connect", () => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      setConnection("connected");
      setSessionReady(false);
      requestServerClockSync(socket, generation);

      if (currentSessionIdRef.current) {
        socket.emit("session:resume", {
          playerId: playerIdRef.current,
          sessionId: currentSessionIdRef.current,
        });
      } else {
        socket.emit("queue:join", {
          playerId: playerIdRef.current,
          location: locationConsent ? ipLocation : null,
        });
      }
    });

    socket.on("queue:status", (payload: QueueStatusPayload) => {
      if (isCurrentAttempt(socket, generation) && !currentSessionIdRef.current) {
        applyQueueStatus(payload);
      }
    });

    socket.on("queue:error", (payload: QueueErrorPayload) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      hiddenAiRequestPendingRef.current = false;
      clearQueueUiTimers();
      socketRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
      setPhase("landing");
      setConnection("idle");
      setQueueFrozenSeconds(null);
      setLocationStatus(payload.code === "location_required" ? "invalid" : "unavailable");
    });

    socket.on("session:created", (payload: SessionCreatedPayload) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      syncServerClock(payload);
      hiddenAiRequestPendingRef.current = false;
      markQueueFound();
      rememberSession(payload.sessionId);
      setSessionReady(true);
      queueTimersRef.current.push(
        window.setTimeout(() => {
          if (
            isCurrentAttempt(socket, generation) &&
            socket.connected &&
            currentSessionIdRef.current === payload.sessionId
          ) {
            enterChat(payload);
          }
        }, getChatStartDelay(payload)),
      );
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
      if (!isCurrentAttempt(socket, generation) || payload.sessionId !== currentSessionIdRef.current) {
        return;
      }

      syncServerClock(payload);
      rememberSession(payload.sessionId);
      enterResumedSession(payload);
      setSessionReady(true);
    });

    socket.on("session:resume_failed", () => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      if (terminalSessionRef.current?.sessionId === currentSessionIdRef.current) {
        socketRef.current = null;
        socket.removeAllListeners();
        socket.disconnect();
        setSessionReady(false);
        setConnection("idle");
        return;
      }

      clearQueueUiTimers();
      socketRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
      forgetCurrentSession();
      setConnection("idle");
      setPhase("landing");
    });
  }

  function requestImmediateAiMatch(modelFamily: ModelFamily | null) {
    if (phase !== "matching" || hiddenAiRequestPendingRef.current) {
      return;
    }

    if (!locationConsent || !hasValidIpLocation(ipLocation)) {
      setLocationStatus(ipLocation ? "invalid" : "required");
      return;
    }

    const socket = socketRef.current;

    if (!socket?.connected || currentSessionIdRef.current) {
      return;
    }

    hiddenAiRequestPendingRef.current = true;
    clearQueueUiTimers();
    socket.emit("queue:test_ai", {
      playerId: playerIdRef.current,
      location: ipLocation,
      modelFamily,
    });
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    const socket = socketRef.current;
    const activeSessionId = currentSessionIdRef.current;

    if (
      !text ||
      !activeSessionId ||
      phase !== "chat" ||
      !isPlayerTurn ||
      !sessionReady ||
      !socket?.connected ||
      sendingMessageRef.current
    ) {
      return;
    }

    const generation = gameGenerationRef.current;
    const pendingMessage = pendingMessageRef.current;
    const clientMessageId = pendingMessage?.sessionId === activeSessionId && pendingMessage.text === text
      ? pendingMessage.clientMessageId
      : window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const requestId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

    pendingMessageRef.current = {
      sessionId: activeSessionId,
      clientMessageId,
      requestId,
      text,
    };
    activeSendRequestRef.current = requestId;
    sendingMessageRef.current = true;
    setDraft("");

    socket.timeout(4000).emit(
      "chat:message",
      {
        sessionId: activeSessionId,
        clientMessageId,
        requestId,
        text,
      },
      (error: unknown, response?: ChatSendAck) => {
        if (
          !isCurrentAttempt(socket, generation) ||
          currentSessionIdRef.current !== activeSessionId ||
          activeSendRequestRef.current !== requestId
        ) {
          return;
        }

        activeSendRequestRef.current = "";
        sendingMessageRef.current = false;

        if (error) {
          if (pendingMessageRef.current?.clientMessageId !== clientMessageId) {
            return;
          }
          setDraft((current) => current || text);
          appendSystemMessage(activeSessionId, "chat-timeout", "Message not sent. Check your connection and try again.");
          return;
        }

        if (!response?.ok) {
          if (pendingMessageRef.current?.requestId === requestId) {
            pendingMessageRef.current = null;
          }
          setDraft((current) => current || text);
          appendSystemMessage(
            activeSessionId,
            `chat-error:${response?.code || "unknown"}`,
            response?.error || "Message not sent. Try again.",
          );
          return;
        }

        if (response.sessionId !== activeSessionId || !response.message) {
          setDraft((current) => current || text);
          return;
        }

        if (pendingMessageRef.current?.requestId === requestId) {
          pendingMessageRef.current = null;
        }
        appendMessage(response.message);
      },
    );
  }

  function chooseIdentity(value: IdentityGuess) {
    if (finalGuessExpired) {
      return;
    }

    setIdentityGuess(value);
    setPhase(value === "Human" ? "humanGuess" : "aiGuess");
  }

  function requestGuess() {
    if (!canGuess) {
      return;
    }

    setPendingGuessConfirm(true);
  }

  function confirmGuessLock() {
    const socket = socketRef.current;
    const activeSessionId = currentSessionIdRef.current;

    if (!activeSessionId || !canGuess || !sessionReady || !socket?.connected) {
      return;
    }

    const guessEndsAt = getServerNow() + FINAL_GUESS_SECONDS * 1000;

    setPendingGuessConfirm(false);
    setFinalGuessEndsAt((current) => current || guessEndsAt);
    setTurnState((current) => ({
      ...current,
      currentTurn: "paused",
      turnEndsAt: null,
    }));
    setPhase("identity");

    socket.emit("round:lock", {
      sessionId: activeSessionId,
    });
  }

  function cancelGuessLock() {
    setPendingGuessConfirm(false);
  }

  function submitGuess(nextModelGuess = modelGuess) {
    const socket = socketRef.current;
    const activeSessionId = currentSessionIdRef.current;

    if (!identityGuess || !activeSessionId || finalGuessExpired || !sessionReady || !socket?.connected) {
      return;
    }

    socket.emit("guess:submit", {
      sessionId: activeSessionId,
      identityGuess,
      locationGuess: pin,
      modelFamilyGuess: identityGuess === "AI" ? nextModelGuess : null,
    });
    setPhase("waitingGuess");
  }

  function restart() {
    const socket = socketRef.current;
    const activeSessionId = currentSessionIdRef.current || loadActiveSessionId() || "";
    const shouldAbortSession = phase !== "landing";

    clearQueueUiTimers();
    gameGenerationRef.current += 1;
    currentSessionIdRef.current = "";
    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = null;
    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    sendingMessageRef.current = false;
    setSessionReady(false);
    removeActiveSessionId();
    socketRef.current = null;

    if (socket) {
      socket.removeAllListeners();

      if (shouldAbortSession && socket.connected) {
        socket.timeout(1500).emit(
          "session:abort",
          { sessionId: activeSessionId || undefined },
          () => socket.disconnect(),
        );
      } else {
        socket.emit("queue:leave");
        socket.disconnect();
      }
    }

    setPhase("landing");
    setConnection("idle");
    setSessionId("");
    setChatEndsAt(null);
    setMessages([]);
    setDraft("");
    setIdentityGuess(null);
    setPin(null);
    setModelGuess(null);
    setResult(null);
    setEndMessage("");
    setTurnState(EMPTY_TURN_STATE);
    setPendingGuessConfirm(false);
    setFinalGuessEndsAt(null);
    setQueueStatus("idle");
    hiddenAiRequestPendingRef.current = false;
    setConnectedProfiles(0);
    setRequiredProfiles(2);
    setQueueStartedAt(null);
    queueStartedAtRef.current = null;
    queueFoundAtRef.current = null;
    setQueueFrozenSeconds(null);
  }

  function getQueueTransitionDelay() {
    const foundAt = queueFoundAtRef.current || getServerNow();
    const elapsed = getServerNow() - foundAt;

    queueFoundAtRef.current = foundAt;
    return Math.max(0, MATCH_FOUND_HOLD_MS - elapsed);
  }

  function getChatStartDelay(payload: SessionCreatedPayload) {
    return Number.isFinite(payload.chatStartsAt)
      ? Math.max(0, Number(payload.chatStartsAt) - getServerNow())
      : getQueueTransitionDelay();
  }

  function enterChat(payload: SessionCreatedPayload) {
    currentSessionIdRef.current = payload.sessionId;
    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = null;
    setSessionId(payload.sessionId);
    setSessionReady(true);
    setChatEndsAt(payload.chatEndsAt);
    setNow(getServerNow());
    setMessages((current) => {
      const introMessage: ChatMessage = {
        id: `intro:${payload.sessionId}`,
        author: "system",
        text: payload.intro,
        sentAt: Date.now(),
      };
      const earlyMessages = current.filter((message) => message.id !== introMessage.id);

      return [introMessage, ...earlyMessages];
    });
    setQueueStatus("found");
    setConnectedProfiles(2);
    setPhase("chat");
  }

  function enterResumedSession(payload: SessionResumedPayload) {
    clearQueueUiTimers();
    currentSessionIdRef.current = payload.sessionId;
    locallyEndedSessionRef.current = "";
    sendingMessageRef.current = false;
    const pendingMessage = pendingMessageRef.current;
    const preserveReveal = terminalSessionRef.current?.sessionId === payload.sessionId &&
      terminalSessionRef.current.phase === "reveal" &&
      payload.submitted;
    const pendingWasAccepted = Boolean(
      pendingMessage?.sessionId === payload.sessionId &&
      payload.messages.some((message) => message.clientMessageId === pendingMessage.clientMessageId),
    );

    if (pendingWasAccepted) {
      pendingMessageRef.current = null;
    }

    setSessionId(payload.sessionId);
    setSessionReady(true);
    setChatEndsAt(payload.chatEndsAt);
    setNow(getServerNow());
    setDraft((current) => {
      if (pendingMessage?.sessionId !== payload.sessionId) {
        return current;
      }

      if (pendingWasAccepted) {
        return current === pendingMessage.text ? "" : current;
      }

      return current || pendingMessage.text;
    });
    setTurnState(EMPTY_TURN_STATE);
    setMessages(
      payload.messages.length
        ? payload.messages
        : [
          {
            id: `intro:${payload.sessionId}`,
            author: "system",
            text: payload.intro,
            sentAt: Date.now(),
          },
        ],
    );
    setQueueStatus("found");
    setConnectedProfiles(2);
    setFinalGuessEndsAt(payload.finalGuessEndsAt || null);
    if (!preserveReveal) {
      terminalSessionRef.current = null;
      setResult(null);
      setEndMessage("");
    }
    setPendingGuessConfirm(false);
    setPhase(preserveReveal
      ? "reveal"
      : payload.chatLocked ? (payload.submitted ? "waitingGuess" : "identity") : "chat");
  }

  function recordPersistentScore(payload: ResultPayload) {
    if (scoredSessionsRef.current.has(payload.sessionId)) {
      return;
    }

    scoredSessionsRef.current.add(payload.sessionId);

    setPersistentScore((current) => {
      const isHumanRound = payload.actual.participantType === "Human";
      const next = {
        readEarned: current.readEarned + payload.score.read.earned,
        readPossible: current.readPossible + payload.score.read.possible,
        humanEarned: current.humanEarned + (isHumanRound ? payload.score.round.earned : 0),
        humanPossible: current.humanPossible + (isHumanRound ? payload.score.round.possible : 0),
        aiEarned: current.aiEarned + (!isHumanRound ? payload.score.round.earned : 0),
        aiPossible: current.aiPossible + (!isHumanRound ? payload.score.round.possible : 0),
      };

      savePersistentScore(next);
      return next;
    });
  }

  function setLocationAgreement(agreed: boolean) {
    setLocationConsent(agreed);
    saveLocationConsent(agreed);

    if (!agreed) {
      setIpLocation(null);
      removeIpLocation();
      setLocationStatus("idle");
      return;
    }

    fetchIpLocation();
  }

  async function fetchIpLocation() {
    setLocationStatus("checking");

    try {
      const response = await fetch("https://ipapi.co/json/");

      if (!response.ok) {
        throw new Error("IP location lookup failed");
      }

      const data = await response.json();
      const lat = toLocationNumber(data.latitude ?? data.lat, -90, 90);
      const lng = toLocationNumber(data.longitude ?? data.lon ?? data.lng, -180, 180);
      const next: IpLocation = {
        country: String(data.country_name || data.country || "Unknown"),
        region: String(data.region || data.region_code || ""),
        city: String(data.city || ""),
        lat,
        lng,
        source: "ip",
        updatedAt: Date.now(),
      };

      if (!hasValidIpLocation(next)) {
        throw new Error("IP location lookup returned no coordinates");
      }

      setIpLocation(next);
      saveIpLocation(next);
      setLocationStatus("ready");
    } catch {
      setLocationStatus("unavailable");
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="brandMark" src="/geoturing-logo.png" alt="GeoTuring logo" />
          <div className="brandText">
            <strong>GeoTuring</strong>
          </div>
        </div>
        <nav className="sidebarNav">
          <button
            className="navItem primary"
            type="button"
            disabled={phase === "landing"}
            onClick={restart}
          >
            <span className="navIcon">+</span>
            New game
          </button>
          <a className="navItem" href="/history">
            <span className="navIcon ghost"><HistoryIcon /></span>
            History
          </a>
          <a className="navItem" href="/leaderboard">
            <span className="navIcon ghost"><LeaderboardIcon /></span>
            Leaderboard
          </a>
        </nav>
        <div className="sidebarFooter">
          <StatusPill value={connection} />
        </div>
      </aside>

      <main className="appMain">
        <header className="topbar">
          <div>
            <p className="eyebrow">Anonymous chat · guess human or AI</p>
            <h1>Read the room. Then read the world.</h1>
          </div>
        </header>

      {phase === "landing" && (
        <Landing
          locationStatus={locationStatus}
          locationConsent={locationConsent}
          ipLocation={ipLocation}
          onLocationAgreement={setLocationAgreement}
          onStart={startMatchmaking}
          persistentScore={persistentScore}
        />
      )}
      {phase === "matching" && (
        <Matchmaking
          actualSeconds={actualQueueSeconds}
          connectedProfiles={connectedProfiles}
          requiredProfiles={requiredProfiles}
          status={queueStatus}
        />
      )}
      {(phase === "chat" || phase === "ended" || isFinalGuessPhase || phase === "reveal") && (
        <section className={`roundLayout ${phase === "chat" || phase === "ended" ? "chatOnly" : ""}`}>
          <ChatRoom
            canGuess={phase === "chat" && canGuess}
            counts={chatCounts}
            draft={draft}
            endMessage={endMessage}
            finalGuessSecondsLeft={phase === "reveal" ? 0 : finalGuessSecondsLeft}
            isEnded={phase === "ended"}
            isLocked={isFinalGuessPhase || phase === "reveal"}
            isPlayerTurn={phase === "chat" && isPlayerTurn}
            lockedMessage={
              phase === "waitingGuess"
                ? "Final answer locked. Waiting for the other result beside the chat."
                : phase === "reveal"
                  ? "Round complete. Review the result beside the chat."
                  : "Chat locked. Make your final read beside the chat."
            }
            messages={messages}
            pendingGuessConfirm={phase === "chat" && pendingGuessConfirm}
            secondsLeft={secondsLeft}
            turnSecondsLeft={turnSecondsLeft}
            turnState={turnState}
            onCancelGuess={cancelGuessLock}
            onConfirmGuess={confirmGuessLock}
            onDraft={setDraft}
            onSend={sendMessage}
            onGuess={requestGuess}
            onRestart={restart}
          />
          {phase === "identity" && (
            <IdentityGuessScreen disabled={finalGuessExpired} secondsLeft={finalGuessSecondsLeft} onPick={chooseIdentity} />
          )}
          {phase === "humanGuess" && (
            <HumanGuessScreen
              disabled={finalGuessExpired}
              pin={pin}
              secondsLeft={finalGuessSecondsLeft}
              onPin={setPin}
              onBack={() => setPhase("identity")}
              onSubmit={() => submitGuess()}
            />
          )}
          {phase === "aiGuess" && (
            <AiGuessScreen
              disabled={finalGuessExpired}
              secondsLeft={finalGuessSecondsLeft}
              selected={modelGuess}
              onBack={() => setPhase("identity")}
              onPick={(family) => {
                setModelGuess(family);
                submitGuess(family);
              }}
            />
          )}
          {phase === "waitingGuess" && <WaitingGuessScreen secondsLeft={finalGuessSecondsLeft} />}
          {phase === "reveal" && result && (
            <Reveal
              result={result}
              serverClockOffsetMs={serverClockOffsetRef.current}
              onRestart={restart}
            />
          )}
        </section>
      )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
