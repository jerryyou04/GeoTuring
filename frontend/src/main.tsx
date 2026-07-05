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
  const socketRef = useRef<Socket | null>(null);
  const serverClockOffsetRef = useRef(0);
  const hasSyncedServerClockRef = useRef(false);
  const queueStartedAtRef = useRef<number | null>(null);
  const queueFoundAtRef = useRef<number | null>(null);
  const queueTimersRef = useRef<number[]>([]);
  const hiddenAiRequestPendingRef = useRef(false);
  const scoredSessionsRef = useRef<Set<string>>(new Set());
  const [phase, setPhase] = useState<Phase>("landing");
  const [connection, setConnection] = useState("idle");
  const [sessionId, setSessionId] = useState("");
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
  const [queueStatus, setQueueStatus] = useState<QueueStatus>("idle");
  const [connectedProfiles, setConnectedProfiles] = useState(0);
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
  const canGuess =
    !chatTimerExpired &&
    !turnTimerExpired &&
    chatCounts.player >= MIN_MESSAGES_PER_SIDE &&
    chatCounts.partner >= MIN_MESSAGES_PER_SIDE;
  const isPlayerTurn =
    phase === "chat" &&
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
    if (locationConsent && !ipLocation && locationStatus === "idle") {
      fetchIpLocation();
    }
  }, [locationConsent, ipLocation, locationStatus]);

  useEffect(() => {
    const activeSessionId = loadActiveSessionId();

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

  function requestServerClockSync(socket: Socket) {
    const sentAt = Date.now();

    socket.timeout(2000).emit("clock:sync", {}, (error: unknown, payload?: ServerClockPayload) => {
      if (error || !payload || !Number.isFinite(payload.serverNow)) {
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

  function resumeActiveSession(activeSessionId: string) {
    clearQueueUiTimers();
    setConnection("connecting");
    socketRef.current?.disconnect();

    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnection("connected");
      requestServerClockSync(socket);
      socket.emit("session:resume", {
        playerId: playerIdRef.current,
        sessionId: activeSessionId,
      });
    });

    socket.on("disconnect", () => {
      setConnection("disconnected");
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
      syncServerClock(payload);
      saveActiveSessionId(payload.sessionId);
      enterResumedSession(payload);
    });

    socket.on("session:resume_failed", () => {
      removeActiveSessionId();
      setConnection("idle");
      setPhase("landing");
    });

    socket.on("partner:message", (payload: { message: ChatMessage }) => {
      setMessages((current) => [...current, payload.message]);
    });

    socket.on("turn:update", (payload: TurnStatePayload) => {
      syncServerClock(payload);
      setTurnState(payload);

      if (payload.message) {
        setMessages((current) => [
          ...current,
          {
            id: `${Date.now()}`,
            author: "system",
            text: payload.message,
            sentAt: Date.now(),
          },
        ]);
      }
    });

    socket.on("chat:error", (payload: ChatErrorPayload) => {
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "Wait for your turn before sending a message.",
          sentAt: Date.now(),
        },
      ]);
    });

    socket.on("guess:error", (payload: GuessErrorPayload) => {
      setPendingGuessConfirm(false);
      setFinalGuessEndsAt(null);
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "More messages are required before guessing.",
          sentAt: Date.now(),
        },
      ]);
      setPhase("chat");
    });

    socket.on("round:locked", (payload: { message?: string; guessEndsAt?: number; serverNow?: number }) => {
      syncServerClock(payload);
      setPendingGuessConfirm(false);
      setFinalGuessEndsAt(payload.guessEndsAt || null);
      setTurnState((current) => ({
        ...current,
        currentTurn: "paused",
        turnEndsAt: null,
      }));
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "The chat is locked. Make your final read.",
          sentAt: Date.now(),
        },
      ]);
      setPhase((current) => (current === "waitingGuess" ? current : "identity"));
    });

    socket.on("guess:submitted", () => {
      setPhase("waitingGuess");
    });

    socket.on("partner:left", (payload: { message?: string }) => {
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "Your partner disconnected. You can still make your guess.",
          sentAt: Date.now(),
        },
      ]);
    });

    socket.on("session:ended", (payload: { message?: string; serverNow?: number }) => {
      syncServerClock(payload);
      removeActiveSessionId();
      const message = payload.message || "This round ended.";
      setEndMessage(message);
      setTurnState((current) => ({
        ...current,
        currentTurn: "paused",
        turnEndsAt: null,
      }));
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: message,
          sentAt: Date.now(),
        },
      ]);
      setPhase("ended");
    });

    socket.on("session:result", (payload: ResultPayload) => {
      setNow(getServerNow());
      recordPersistentScore(payload);
      setResult(payload);
      setFinalGuessEndsAt(null);
      removeActiveSessionId();
      setPhase("reveal");
    });

    socket.on(
      "opponent:guess",
      (payload: { opponentGuess: ResultPayload["opponentGuess"]; opponentExplanation?: string | null }) => {
        setResult((current) =>
          current
            ? {
                ...current,
                opponentGuess: payload.opponentGuess,
                opponentExplanation: payload.opponentExplanation ?? null,
                opponentPending: false,
              }
            : current,
        );
      },
    );

    socket.on("connect_error", () => {
      setConnection("offline");
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

    socketRef.current?.disconnect();
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnection("connected");
      requestServerClockSync(socket);
      socket.emit("queue:join", {
        playerId: playerIdRef.current,
        sessionId: loadActiveSessionId(),
        location: locationConsent ? ipLocation : null,
      });
    });

    socket.on("disconnect", () => {
      setConnection("disconnected");
    });

    socket.on("queue:status", (payload: QueueStatusPayload) => {
      applyQueueStatus(payload);
    });

    socket.on("queue:error", (payload: QueueErrorPayload) => {
      hiddenAiRequestPendingRef.current = false;
      clearQueueUiTimers();
      socket.disconnect();
      setPhase("landing");
      setConnection("idle");
      setQueueFrozenSeconds(null);
      setLocationStatus(payload.code === "location_required" ? "invalid" : "unavailable");
    });

    socket.on("session:created", (payload: SessionCreatedPayload) => {
      syncServerClock(payload);
      hiddenAiRequestPendingRef.current = false;
      markQueueFound();
      saveActiveSessionId(payload.sessionId);
      queueTimersRef.current.push(
        window.setTimeout(() => enterChat(payload), getChatStartDelay(payload)),
      );
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
      syncServerClock(payload);
      saveActiveSessionId(payload.sessionId);
      enterResumedSession(payload);
    });

    socket.on("session:resume_failed", () => {
      removeActiveSessionId();
    });

    socket.on("partner:message", (payload: { message: ChatMessage }) => {
      setMessages((current) => [...current, payload.message]);
    });

    socket.on("turn:update", (payload: TurnStatePayload) => {
      syncServerClock(payload);
      setTurnState(payload);

      if (payload.message) {
        setMessages((current) => [
          ...current,
          {
            id: `${Date.now()}`,
            author: "system",
            text: payload.message,
            sentAt: Date.now(),
          },
        ]);
      }
    });

    socket.on("chat:error", (payload: ChatErrorPayload) => {
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "Wait for your turn before sending a message.",
          sentAt: Date.now(),
        },
      ]);
    });

    socket.on("guess:error", (payload: GuessErrorPayload) => {
      setPendingGuessConfirm(false);
      setFinalGuessEndsAt(null);
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "More messages are required before guessing.",
          sentAt: Date.now(),
        },
      ]);
      setPhase("chat");
    });

    socket.on("round:locked", (payload: { message?: string; guessEndsAt?: number; serverNow?: number }) => {
      syncServerClock(payload);
      setPendingGuessConfirm(false);
      setFinalGuessEndsAt(payload.guessEndsAt || null);
      setTurnState((current) => ({
        ...current,
        currentTurn: "paused",
        turnEndsAt: null,
      }));
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "The chat is locked. Make your final read.",
          sentAt: Date.now(),
        },
      ]);
      setPhase("identity");
    });

    socket.on("guess:submitted", () => {
      setPhase("waitingGuess");
    });

    socket.on("partner:left", (payload: { message?: string }) => {
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: payload.message || "Your partner disconnected. You can still make your guess.",
          sentAt: Date.now(),
        },
      ]);
    });

    socket.on("session:ended", (payload: { message?: string; serverNow?: number }) => {
      syncServerClock(payload);
      removeActiveSessionId();
      const message = payload.message || "This round ended.";
      setEndMessage(message);
      setTurnState((current) => ({
        ...current,
        currentTurn: "paused",
        turnEndsAt: null,
      }));
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}`,
          author: "system",
          text: message,
          sentAt: Date.now(),
        },
      ]);
      setPhase("ended");
    });

    socket.on("session:result", (payload: ResultPayload) => {
      setNow(getServerNow());
      recordPersistentScore(payload);
      setResult(payload);
      setFinalGuessEndsAt(null);
      removeActiveSessionId();
      setPhase("reveal");
    });

    socket.on(
      "opponent:guess",
      (payload: { opponentGuess: ResultPayload["opponentGuess"]; opponentExplanation?: string | null }) => {
        setResult((current) =>
          current
            ? {
                ...current,
                opponentGuess: payload.opponentGuess,
                opponentExplanation: payload.opponentExplanation ?? null,
                opponentPending: false,
              }
            : current,
        );
      },
    );

    socket.on("connect_error", () => {
      setConnection("offline");
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

    hiddenAiRequestPendingRef.current = true;
    clearQueueUiTimers();
    socketRef.current?.emit("queue:test_ai", {
      playerId: playerIdRef.current,
      location: ipLocation,
      modelFamily,
    });
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();

    if (!text || !sessionId || phase !== "chat" || !isPlayerTurn) {
      return;
    }

    setMessages((current) => [
      ...current,
      {
        id: `${Date.now()}`,
        author: "player",
        text,
        sentAt: Date.now(),
      },
    ]);
    socketRef.current?.emit("chat:message", {
      sessionId,
      text,
    });
    setDraft("");
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
    if (!sessionId || !canGuess) {
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

    socketRef.current?.emit("round:lock", {
      sessionId,
    });
  }

  function cancelGuessLock() {
    setPendingGuessConfirm(false);
  }

  function submitGuess(nextModelGuess = modelGuess) {
    if (!identityGuess || !sessionId || finalGuessExpired) {
      return;
    }

    socketRef.current?.emit("guess:submit", {
      sessionId,
      identityGuess,
      locationGuess: identityGuess === "Human" ? pin : null,
      modelFamilyGuess: identityGuess === "AI" ? nextModelGuess : null,
    });
    setPhase("waitingGuess");
  }

  function restart() {
    clearQueueUiTimers();
    removeActiveSessionId();
    socketRef.current?.disconnect();
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
    setSessionId(payload.sessionId);
    setChatEndsAt(payload.chatEndsAt);
    setNow(getServerNow());
    setMessages((current) => {
      const introMessage: ChatMessage = {
        id: "intro",
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
    setSessionId(payload.sessionId);
    setChatEndsAt(payload.chatEndsAt);
    setNow(getServerNow());
    setMessages(
      payload.messages.length
        ? payload.messages
        : [
          {
            id: "intro",
            author: "system",
            text: payload.intro,
            sentAt: Date.now(),
          },
        ],
    );
    setQueueStatus("found");
    setConnectedProfiles(2);
    setFinalGuessEndsAt(payload.finalGuessEndsAt || null);
    setResult(null);
    setEndMessage("");
    setPendingGuessConfirm(false);
    setPhase(payload.chatLocked ? (payload.submitted ? "waitingGuess" : "identity") : "chat");
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
