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
  GuessPlace,
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
  loadScoredSessionIds,
  removeActiveSessionId,
  removeIpLocation,
  saveActiveSessionId,
  saveIpLocation,
  saveLocationConsent,
  savePersistentScore,
  saveScoredSessionIds,
} from "./storage";
import { AdminEntry } from "./components/AdminConsole";
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
import { Sidebar } from "./components/Sidebar";
import { Reveal } from "./components/Reveal";
import { StatusPill } from "./components/StatusPill";
import { RoundProgress } from "./components/RoundProgress";
import { RoundLayout } from "./components/RoundLayout";

const RECONNECT_UI_GRACE_MS = 5000;

function App() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";

  if (path === ADMIN_CONSOLE_PATH) {
    return <AdminEntry fallback={<GameApp />} />;
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
    sentAt: number;
    playerCount: number;
    attempts: number;
  } | null>(null);
  const activeSendRequestRef = useRef("");
  const locallyEndedSessionRef = useRef("");
  const terminalSessionRef = useRef<{
    sessionId: string;
    phase: "ended" | "reveal";
  } | null>(null);
  const completedSessionIdRef = useRef("");
  const systemMessageSequenceRef = useRef(0);
  const serverClockOffsetRef = useRef(0);
  const hasSyncedServerClockRef = useRef(false);
  const queueStartedAtRef = useRef<number | null>(null);
  const queueFoundAtRef = useRef<number | null>(null);
  const queueTimersRef = useRef<number[]>([]);
  const reconnectUiTimerRef = useRef<number | null>(null);
  const sessionAttachedRef = useRef(false);
  const connectionInterruptionVisibleRef = useRef(false);
  const hiddenAiRequestPendingRef = useRef(false);
  const scoredSessionsRef = useRef<Set<string>>(new Set(loadScoredSessionIds()));
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
  const canStartNewGame = Boolean(
    currentSessionIdRef.current &&
    completedSessionIdRef.current === currentSessionIdRef.current,
  );

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
    } else {
      probeActiveSession();
    }
  }, []);

  useEffect(() => {
    return () => {
      clearQueueUiTimers();
      clearReconnectUiTimer();
      const socket = socketRef.current;
      socketRef.current = null;
      gameGenerationRef.current += 1;
      socket?.removeAllListeners();
      socket?.disconnect();
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

  function clearReconnectUiTimer() {
    if (reconnectUiTimerRef.current !== null) {
      window.clearTimeout(reconnectUiTimerRef.current);
      reconnectUiTimerRef.current = null;
    }
  }

  function markSessionAttached() {
    clearReconnectUiTimer();
    sessionAttachedRef.current = true;
    connectionInterruptionVisibleRef.current = false;
    setSessionReady(true);
    setConnection("connected");
  }

  function prepareGameSocket() {
    clearReconnectUiTimer();
    sessionAttachedRef.current = false;
    connectionInterruptionVisibleRef.current = false;
    const socket = socketRef.current || io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      tryAllTransports: true,
    });
    socket.removeAllListeners();
    const generation = ++gameGenerationRef.current;
    socketRef.current = socket;

    return { generation, socket };
  }

  function registerConnectAction(
    socket: Socket,
    generation: number,
    action: () => void,
  ) {
    let handledSocketId = "";
    const handleConnect = () => {
      if (!isCurrentAttempt(socket, generation) || !socket.connected || !socket.id) {
        return;
      }

      if (handledSocketId === socket.id) {
        return;
      }

      handledSocketId = socket.id;
      action();
    };

    socket.on("connect", handleConnect);

    if (socket.connected) {
      handleConnect();
    } else if (!socket.active) {
      socket.connect();
    }
  }

  function parkSocketWorkflow(socket: Socket, generation: number) {
    if (!isCurrentAttempt(socket, generation)) {
      return;
    }

    gameGenerationRef.current += 1;
    socket.removeAllListeners();
    clearReconnectUiTimer();
    sessionAttachedRef.current = false;
    sendingMessageRef.current = false;
    activeSendRequestRef.current = "";
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
    if (completedSessionIdRef.current !== nextSessionId) {
      completedSessionIdRef.current = "";
    }
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
    clearReconnectUiTimer();
    currentSessionIdRef.current = "";
    sessionAttachedRef.current = false;
    connectionInterruptionVisibleRef.current = false;
    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = null;
    completedSessionIdRef.current = "";
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
    setMessages((current) => current.some((item) => (
      item.id === message.id ||
      Boolean(message.clientMessageId && item.clientMessageId === message.clientMessageId)
    ))
      ? current
      : [...current, message]);
  }

  function buildPendingBubble(pending: NonNullable<typeof pendingMessageRef.current>): ChatMessage {
    return {
      id: `pending:${pending.clientMessageId}`,
      clientMessageId: pending.clientMessageId,
      author: "player",
      text: pending.text,
      sentAt: pending.sentAt,
      delivery: "pending",
    };
  }

  function confirmPendingMessage(clientMessageId: string, confirmedMessage?: ChatMessage) {
    const pending = pendingMessageRef.current;

    if (!pending || pending.clientMessageId !== clientMessageId) {
      return;
    }

    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    sendingMessageRef.current = false;
    setDraft((current) => current === pending.text ? "" : current);
    setMessages((current) => current.map((message) => {
      if (message.clientMessageId !== clientMessageId && message.id !== `pending:${clientMessageId}`) {
        return message;
      }

      return confirmedMessage
        ? { ...confirmedMessage, clientMessageId: confirmedMessage.clientMessageId || clientMessageId }
        : { ...message, delivery: undefined };
    }));
  }

  function discardPendingMessage() {
    const pending = pendingMessageRef.current;

    if (!pending) {
      return;
    }

    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    sendingMessageRef.current = false;
    setMessages((current) => current.filter((message) => (
      message.clientMessageId !== pending.clientMessageId &&
      message.id !== `pending:${pending.clientMessageId}`
    )));
  }

  function failPendingMessage(
    clientMessageId: string,
    kind: string,
    message: string,
  ) {
    const pending = pendingMessageRef.current;

    if (!pending || pending.clientMessageId !== clientMessageId) {
      return;
    }

    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    sendingMessageRef.current = false;
    setMessages((current) => current.filter((item) => (
      item.clientMessageId !== clientMessageId && item.id !== `pending:${clientMessageId}`
    )));
    setDraft((current) => current || pending.text);
    appendSystemMessage(pending.sessionId, kind, message);
  }

  function transmitPendingMessage() {
    const pending = pendingMessageRef.current;
    const socket = socketRef.current;

    if (
      !pending ||
      sendingMessageRef.current ||
      !sessionAttachedRef.current ||
      !socket?.connected ||
      currentSessionIdRef.current !== pending.sessionId
    ) {
      return;
    }

    const generation = gameGenerationRef.current;
    const requestId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    pending.requestId = requestId;
    pending.attempts += 1;
    activeSendRequestRef.current = requestId;
    sendingMessageRef.current = true;

    socket.timeout(4000).emit(
      "chat:message",
      {
        sessionId: pending.sessionId,
        clientMessageId: pending.clientMessageId,
        requestId,
        text: pending.text,
      },
      (error: unknown, response?: ChatSendAck) => {
        const activePending = pendingMessageRef.current;

        if (
          !isCurrentAttempt(socket, generation) ||
          currentSessionIdRef.current !== pending.sessionId ||
          activeSendRequestRef.current !== requestId ||
          activePending?.clientMessageId !== pending.clientMessageId
        ) {
          return;
        }

        activeSendRequestRef.current = "";
        sendingMessageRef.current = false;

        if (error) {
          if (socket.connected && sessionAttachedRef.current) {
            socket.emit("session:resume", {
              playerId: playerIdRef.current,
              sessionId: activePending.sessionId,
            });
          }
          return;
        }

        if (!response?.ok) {
          failPendingMessage(
            activePending.clientMessageId,
            `chat-error:${response?.code || "unknown"}`,
            response?.error || "Message not sent. Try again.",
          );
          return;
        }

        if (response.sessionId !== activePending.sessionId || !response.message) {
          failPendingMessage(
            activePending.clientMessageId,
            "chat-error:invalid-response",
            "Message not sent. Try again.",
          );
          return;
        }

        confirmPendingMessage(activePending.clientMessageId, response.message);
      },
    );
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
    clearReconnectUiTimer();
    sessionAttachedRef.current = false;
    connectionInterruptionVisibleRef.current = false;
    removeStoredSessionIfCurrent(payload.sessionId || currentSessionIdRef.current);
    const message = payload.message || "This round ended.";
    const endedSessionId = payload.sessionId || currentSessionIdRef.current || "current";
    const messageId = `session-ended:${endedSessionId}`;

    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = {
      sessionId: endedSessionId,
      phase: "ended",
    };
    completedSessionIdRef.current = endedSessionId;
    discardPendingMessage();
    setSessionReady(false);
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
    socket.on("queue:superseded", () => {
      if (!isCurrentAttempt(socket, generation) || currentSessionIdRef.current) {
        return;
      }

      clearQueueUiTimers();
      parkSocketWorkflow(socket, generation);
      setConnection("idle");
      setQueueStatus("idle");
      setConnectedProfiles(0);
      setRequiredProfiles(2);
      setQueueStartedAt(null);
      queueStartedAtRef.current = null;
      queueFoundAtRef.current = null;
      setQueueFrozenSeconds(null);
      setPhase("landing");
    });

    socket.on("disconnect", (reason) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      console.info(`[socket] disconnected: ${reason}`);
      sessionAttachedRef.current = false;
      sendingMessageRef.current = false;
      activeSendRequestRef.current = "";

      clearReconnectUiTimer();
      reconnectUiTimerRef.current = window.setTimeout(() => {
        reconnectUiTimerRef.current = null;

        if (!isCurrentAttempt(socket, generation) || sessionAttachedRef.current) {
          return;
        }

        connectionInterruptionVisibleRef.current = true;
        setSessionReady(false);
        setConnection(socket.connected ? "connecting" : "disconnected");
      }, RECONNECT_UI_GRACE_MS);

      if (!socket.active) {
        window.setTimeout(() => {
          if (isCurrentAttempt(socket, generation) && !socket.connected && !socket.active) {
            socket.connect();
          }
        }, 0);
      }
    });

    socket.on("connect_error", (error) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      console.warn(`[socket] connection error: ${error.message}`);
      if (reconnectUiTimerRef.current !== null || connectionInterruptionVisibleRef.current) {
        return;
      }

      reconnectUiTimerRef.current = window.setTimeout(() => {
        reconnectUiTimerRef.current = null;

        if (!isCurrentAttempt(socket, generation) || socket.connected) {
          return;
        }

        connectionInterruptionVisibleRef.current = true;
        setSessionReady(false);
        setConnection("offline");
      }, RECONNECT_UI_GRACE_MS);
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

      const pendingMessage = pendingMessageRef.current;

      if (
        pendingMessage?.sessionId === payload.sessionId &&
        payload.counts.player > pendingMessage.playerCount
      ) {
        confirmPendingMessage(pendingMessage.clientMessageId);
      }

      if (
        locallyEndedSessionRef.current === payload.sessionId &&
        payload.turnEndsAt !== null &&
        payload.turnEndsAt > getServerNow()
      ) {
        locallyEndedSessionRef.current = "";
        completedSessionIdRef.current = "";
        saveActiveSessionId(payload.sessionId);
        setEndMessage("");
        markSessionAttached();
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

      failPendingMessage(
        pendingMessage.clientMessageId,
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
        completedSessionIdRef.current = "";
        saveActiveSessionId(payload.sessionId);
        discardPendingMessage();
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
            : ["identity", "humanGuess", "aiGuess", "waitingGuess"].includes(current)
              ? current
              : "identity"
        ));
      },
    );

    socket.on("session:ended", (payload: { sessionId: string; message?: string; serverNow?: number }) => {
      if (isCurrentSessionEvent(socket, generation, payload)) {
        finishSessionAsEnded(payload);
      }
    });

    socket.on("session:result", (payload: ResultPayload) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      const isComplete = payload.opponentPending !== true;

      setNow(getServerNow());
      clearReconnectUiTimer();
      sessionAttachedRef.current = !isComplete;
      connectionInterruptionVisibleRef.current = false;
      locallyEndedSessionRef.current = "";
      terminalSessionRef.current = {
        sessionId: payload.sessionId,
        phase: "reveal",
      };
      discardPendingMessage();
      setSessionReady(false);
      recordPersistentScore(payload);
      setResult(payload);
      setFinalGuessEndsAt(null);
      if (isComplete) {
        completedSessionIdRef.current = payload.sessionId;
        removeStoredSessionIfCurrent(payload.sessionId);
      } else {
        completedSessionIdRef.current = "";
        saveActiveSessionId(payload.sessionId);
      }
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

        completedSessionIdRef.current = payload.sessionId;
        sessionAttachedRef.current = false;
        setSessionReady(false);
        removeStoredSessionIfCurrent(payload.sessionId);
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

    socket.on(
      "guess:place",
      (payload: {
        sessionId: string;
        target: "self" | "opponent";
        status: "resolved" | "unavailable";
        place: GuessPlace | null;
      }) => {
        if (!isCurrentSessionEvent(socket, generation, payload)) {
          return;
        }

        setResult((current) => {
          if (!current) {
            return current;
          }

          const placeUpdate = {
            locationPlace: payload.place,
            locationPlaceStatus: payload.status,
          } as const;

          if (payload.target === "self") {
            return {
              ...current,
              guess: {
                ...current.guess,
                ...placeUpdate,
              },
            };
          }

          if (!current.opponentGuess) {
            return current;
          }

          return {
            ...current,
            opponentGuess: {
              ...current.opponentGuess,
              ...placeUpdate,
            },
          };
        });
      },
    );

    socket.on("session:superseded", (payload: { sessionId: string }) => {
      if (!isCurrentSessionEvent(socket, generation, payload)) {
        return;
      }

      clearQueueUiTimers();
      parkSocketWorkflow(socket, generation);
      currentSessionIdRef.current = "";
      setSessionId("");
      setSessionReady(false);
      setConnection(socket.connected ? "connected" : "idle");
      setPhase("landing");
    });
  }

  function handleResumeFailed(
    socket: Socket,
    generation: number,
    payload: { reason?: string } = {},
  ) {
    if (!isCurrentAttempt(socket, generation)) {
      return;
    }

    const failedSessionId = currentSessionIdRef.current;
    const terminalState = terminalSessionRef.current;
    const serverConfirmedFinished = payload.reason === "not_found" || payload.reason === "newer_state";

    clearQueueUiTimers();
    sessionAttachedRef.current = false;
    connectionInterruptionVisibleRef.current = false;
    setSessionReady(false);

    if (payload.reason === "superseded") {
      parkSocketWorkflow(socket, generation);
      currentSessionIdRef.current = "";
      setSessionId("");
      setConnection(socket.connected ? "connected" : "idle");
      setPhase("landing");
      return;
    }

    if (serverConfirmedFinished && terminalState?.sessionId === failedSessionId) {
      parkSocketWorkflow(socket, generation);
      setConnection(socket.connected ? "connected" : "idle");
      completedSessionIdRef.current = failedSessionId;
      removeStoredSessionIfCurrent(failedSessionId);

      if (terminalState.phase === "reveal") {
        setResult((current) => current ? { ...current, opponentPending: false } : current);
      }
      return;
    }

    if (!serverConfirmedFinished) {
      setConnection("disconnected");
      return;
    }

    parkSocketWorkflow(socket, generation);
    setConnection("idle");
    forgetCurrentSession();
    setPhase("landing");
  }

  function resumeActiveSession(activeSessionId: string) {
    clearQueueUiTimers();
    currentSessionIdRef.current = activeSessionId;
    setSessionId(activeSessionId);
    saveActiveSessionId(activeSessionId);
    setSessionReady(false);
    setPhase((current) => current === "landing" ? "matching" : current);
    setQueueStatus("found");
    setConnectedProfiles(2);
    setConnection("connecting");
    const { generation, socket } = prepareGameSocket();
    registerSocketStateListeners(socket, generation);
    registerSessionListeners(socket, generation);

    registerConnectAction(socket, generation, () => {
      sessionAttachedRef.current = false;

      if (connectionInterruptionVisibleRef.current) {
        setConnection("connecting");
      }
      requestServerClockSync(socket, generation);
      socket.emit("session:resume", {
        playerId: playerIdRef.current,
        sessionId: currentSessionIdRef.current || activeSessionId,
      });
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      syncServerClock(payload);
      rememberSession(payload.sessionId);
      enterResumedSession(payload);
    });

    socket.on("session:resume_failed", (payload: { reason?: string }) => {
      handleResumeFailed(socket, generation, payload);
    });
  }

  function probeActiveSession() {
    const { generation, socket } = prepareGameSocket();
    registerSocketStateListeners(socket, generation);
    registerSessionListeners(socket, generation);

    registerConnectAction(socket, generation, () => {
      requestServerClockSync(socket, generation);
      socket.emit("session:resume", {
        playerId: playerIdRef.current,
      });
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      syncServerClock(payload);
      rememberSession(payload.sessionId);
      enterResumedSession(payload);
    });

    socket.on("session:resume_failed", (payload: { reason?: string }) => {
      handleResumeFailed(socket, generation, payload);
    });
  }

  function startMatchmaking() {
    const activeSessionId = currentSessionIdRef.current || loadActiveSessionId() || "";

    if (activeSessionId && completedSessionIdRef.current !== activeSessionId) {
      rememberSession(activeSessionId);
      resumeActiveSession(activeSessionId);
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
    completedSessionIdRef.current = "";
    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    setSessionId("");
    setSessionReady(false);
    sendingMessageRef.current = false;
    removeActiveSessionId();

    const { generation, socket } = prepareGameSocket();
    registerSocketStateListeners(socket, generation);
    registerSessionListeners(socket, generation);

    registerConnectAction(socket, generation, () => {
      sessionAttachedRef.current = false;
      requestServerClockSync(socket, generation);

      if (currentSessionIdRef.current) {
        if (connectionInterruptionVisibleRef.current) {
          setConnection("connecting");
        }
        socket.emit("session:resume", {
          playerId: playerIdRef.current,
          sessionId: currentSessionIdRef.current,
        });
      } else {
        clearReconnectUiTimer();
        connectionInterruptionVisibleRef.current = false;
        setConnection("connected");
        setSessionReady(false);
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
      parkSocketWorkflow(socket, generation);
      setPhase("landing");
      setConnection("idle");
      setQueueFrozenSeconds(null);
      if (payload.code === "location_required") {
        setLocationStatus(locationConsent ? "invalid" : "required");
        if (locationConsent) {
          fetchIpLocation();
        }
      } else {
        setLocationStatus("unavailable");
      }
    });

    socket.on("session:created", (payload: SessionCreatedPayload) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      syncServerClock(payload);
      hiddenAiRequestPendingRef.current = false;
      markQueueFound();
      rememberSession(payload.sessionId);
      markSessionAttached();
      queueTimersRef.current.push(
        window.setTimeout(() => {
          if (
            isCurrentAttempt(socket, generation) &&
            socket.connected &&
            sessionAttachedRef.current &&
            currentSessionIdRef.current === payload.sessionId
          ) {
            enterChat(payload);
          }
        }, getChatStartDelay(payload)),
      );
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
      if (!isCurrentAttempt(socket, generation)) {
        return;
      }

      syncServerClock(payload);
      rememberSession(payload.sessionId);
      enterResumedSession(payload);
    });

    socket.on("session:resume_failed", (payload: { reason?: string }) => {
      handleResumeFailed(socket, generation, payload);
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
      !socket ||
      (!socket.connected && !socket.active)
    ) {
      return;
    }

    const existingPending = pendingMessageRef.current;

    if (existingPending) {
      if (existingPending.sessionId === activeSessionId && existingPending.text === text) {
        transmitPendingMessage();
      }
      return;
    }

    const clientMessageId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

    pendingMessageRef.current = {
      sessionId: activeSessionId,
      clientMessageId,
      requestId: "",
      text,
      sentAt: Date.now(),
      playerCount: chatCounts.player,
      attempts: 0,
    };
    appendMessage(buildPendingBubble(pendingMessageRef.current));
    setDraft("");
    transmitPendingMessage();
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

    if (!activeSessionId || !canGuess || !sessionAttachedRef.current || !socket?.connected) {
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

    if (!identityGuess || !activeSessionId || finalGuessExpired || !sessionAttachedRef.current || !socket?.connected) {
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

    if (activeSessionId && completedSessionIdRef.current !== activeSessionId) {
      rememberSession(activeSessionId);

      if (socket?.connected && sessionAttachedRef.current) {
        return;
      }

      resumeActiveSession(activeSessionId);
      return;
    }

    if (phase === "matching" && !activeSessionId) {
      return;
    }

    clearQueueUiTimers();
    clearReconnectUiTimer();
    currentSessionIdRef.current = "";
    locallyEndedSessionRef.current = "";
    terminalSessionRef.current = null;
    completedSessionIdRef.current = "";
    pendingMessageRef.current = null;
    activeSendRequestRef.current = "";
    sessionAttachedRef.current = false;
    connectionInterruptionVisibleRef.current = false;
    sendingMessageRef.current = false;
    setSessionReady(false);
    removeActiveSessionId();

    if (socket) {
      parkSocketWorkflow(socket, gameGenerationRef.current);
      socket.emit("queue:leave");
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
    completedSessionIdRef.current = "";
    setSessionId(payload.sessionId);
    markSessionAttached();
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
    const wasSameSession = currentSessionIdRef.current === payload.sessionId;
    currentSessionIdRef.current = payload.sessionId;
    locallyEndedSessionRef.current = "";
    completedSessionIdRef.current = "";
    saveActiveSessionId(payload.sessionId);
    sendingMessageRef.current = false;
    activeSendRequestRef.current = "";
    const pendingMessage = pendingMessageRef.current;
    const preserveReveal = terminalSessionRef.current?.sessionId === payload.sessionId &&
      terminalSessionRef.current.phase === "reveal" &&
      payload.submitted;
    const resumedBeforeChatStarts = !payload.chatLocked &&
      Number.isFinite(payload.chatStartsAt) &&
      Number(payload.chatStartsAt) > getServerNow();
    const pendingWasAccepted = Boolean(pendingMessage?.sessionId === payload.sessionId && payload.messages.some(
      (message) => (
        message.author === "player" &&
        (
          message.clientMessageId === pendingMessage.clientMessageId ||
          (
            !message.clientMessageId &&
            message.text === pendingMessage.text &&
            Math.abs(message.sentAt - pendingMessage.sentAt) < 15_000
          )
        )
      ),
    ));
    const pendingCanRetry = Boolean(
      pendingMessage?.sessionId === payload.sessionId &&
      !pendingWasAccepted &&
      !payload.chatLocked &&
      !payload.submitted,
    );
    const pendingRetryExhausted = Boolean(
      pendingCanRetry && pendingMessage && pendingMessage.attempts >= 2,
    );
    const shouldRetryPending = pendingCanRetry && !pendingRetryExhausted;

    if (pendingWasAccepted) {
      pendingMessageRef.current = null;
    } else if (pendingMessage && !shouldRetryPending) {
      pendingMessageRef.current = null;
    }

    setSessionId(payload.sessionId);
    markSessionAttached();
    setChatEndsAt(payload.chatEndsAt);
    setNow(getServerNow());
    setDraft((current) => {
      if (pendingMessage?.sessionId !== payload.sessionId) {
        return current;
      }

      if (pendingWasAccepted) {
        return current === pendingMessage.text ? "" : current;
      }

      return shouldRetryPending ? current : current || pendingMessage.text;
    });
    setTurnState(payload.turnState || EMPTY_TURN_STATE);
    const resumedMessages: ChatMessage[] = payload.messages.length
      ? payload.messages
      : [
        {
          id: `intro:${payload.sessionId}`,
          author: "system",
          text: payload.intro,
          sentAt: Date.now(),
        },
      ];
    setMessages(
      shouldRetryPending && pendingMessage
        ? [...resumedMessages, buildPendingBubble(pendingMessage)]
        : resumedMessages,
    );
    if (pendingRetryExhausted && pendingMessage) {
      appendSystemMessage(
        payload.sessionId,
        "chat-timeout",
        "Message not sent. Check your connection and try again.",
      );
    }
    setQueueStatus("found");
    setConnectedProfiles(2);
    setFinalGuessEndsAt(payload.finalGuessEndsAt || null);
    if (!preserveReveal) {
      terminalSessionRef.current = null;
      setResult(null);
      setEndMessage("");
    }
    setPendingGuessConfirm(false);
    if (!wasSameSession) {
      setIdentityGuess(null);
      setPin(null);
      setModelGuess(null);
    }

    setPhase((current) => {
      if (preserveReveal) {
        return "reveal";
      }

      if (payload.chatLocked) {
        if (payload.submitted) {
          return "waitingGuess";
        }

        return wasSameSession && ["identity", "humanGuess", "aiGuess"].includes(current)
          ? current
          : "identity";
      }

      return resumedBeforeChatStarts ? "matching" : "chat";
    });

    if (resumedBeforeChatStarts) {
      queueTimersRef.current.push(window.setTimeout(() => {
        if (currentSessionIdRef.current === payload.sessionId && sessionAttachedRef.current) {
          setPhase((current) => current === "matching" ? "chat" : current);
        }
      }, Math.max(0, Number(payload.chatStartsAt) - getServerNow())));
    }

    if (shouldRetryPending) {
      transmitPendingMessage();
    }
  }

  function recordPersistentScore(payload: ResultPayload) {
    if (scoredSessionsRef.current.has(payload.sessionId)) {
      return;
    }

    scoredSessionsRef.current.add(payload.sessionId);
    saveScoredSessionIds(scoredSessionsRef.current);

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
      <Sidebar
        active="game"
        newGameAction={{
          disabled: !canStartNewGame,
          title: !canStartNewGame && phase !== "landing"
            ? "A new game is available once the current round is fully over."
            : undefined,
          onClick: restart,
        }}
        footer={<StatusPill value={connection} />}
      />

      <main className={`appMain ${phase === "landing" ? "landingMain" : "gameMain"}`}>
        {phase !== "landing" && <header className="topbar">
          <div>
            <h1>{phase === "matching" ? "New round" : phase === "ended" ? "Round ended" : phase === "reveal" ? "Round result" : "Current round"}</h1>
          </div>
          {phase !== "matching" && phase !== "ended" && <RoundProgress phase={phase} />}
        </header>}

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
        <RoundLayout phase={phase}>
          <ChatRoom
            canRestart={canStartNewGame}
            canGuess={phase === "chat" && canGuess}
            counts={chatCounts}
            draft={draft}
            endMessage={endMessage}
            isEnded={phase === "ended"}
            isLocked={isFinalGuessPhase || phase === "reveal"}
            isPlayerTurn={phase === "chat" && isPlayerTurn}
            lockedMessage={
              phase === "waitingGuess"
                ? "Final answer locked. Waiting for the other result."
                : phase === "reveal"
                  ? result?.opponentPending
                    ? "Final answer locked. Finalizing the round."
                    : "Round complete. Review the result."
                  : "Chat locked. Make your final guess."
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
              canRestart={canStartNewGame}
              result={result}
              serverClockOffsetMs={serverClockOffsetRef.current}
              onRestart={restart}
            />
          )}
        </RoundLayout>
      )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
