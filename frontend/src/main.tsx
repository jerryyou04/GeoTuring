import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import { io, Socket } from "socket.io-client";
import "leaflet/dist/leaflet.css";
import "./styles.css";

type Phase = "landing" | "matching" | "chat" | "identity" | "humanGuess" | "aiGuess" | "waitingGuess" | "reveal" | "ended";
type IdentityGuess = "Human" | "AI";
type ModelFamily = "ChatGPT" | "Gemini" | "Claude" | "Grok";
type QueueStatus = "idle" | "searching" | "found";

interface ChatMessage {
  id: string;
  author: "player" | "partner" | "system";
  text: string;
  sentAt: number;
}

interface SessionCreatedPayload {
  sessionId: string;
  chatEndsAt: number;
  chatSeconds: number;
  intro: string;
}

interface SessionResumedPayload extends SessionCreatedPayload {
  messages: ChatMessage[];
  chatLocked: boolean;
  finalGuessEndsAt: number | null;
  submitted: boolean;
}

interface QueueStatusPayload {
  connectedProfiles: number;
  requiredProfiles: number;
  status: QueueStatus;
  queuedAt: number;
  estimatedSeconds: number;
}

interface QueueErrorPayload {
  code?: string;
  message?: string;
}

interface ChatErrorPayload {
  code?: string;
  message?: string;
  retryAt?: number;
}

interface GuessErrorPayload {
  code?: string;
  message?: string;
  counts?: MessageCounts;
  required?: number;
}

interface MessageCounts {
  player: number;
  partner: number;
}

interface TurnStatePayload {
  sessionId: string;
  currentTurn: "player" | "partner" | "paused";
  turnEndsAt: number | null;
  canGuessEarly: boolean;
  canAbort: boolean;
  message?: string;
  counts: MessageCounts;
  required: number;
}

interface ResultPayload {
  sessionId: string;
  correctIdentity: boolean;
  score: {
    read: {
      earned: number;
      possible: number;
    };
    round: {
      earned: number;
      possible: number;
      type: "location" | "modelFamily";
    };
  };
  distanceKm: number | null;
  guess: {
    identityGuess: IdentityGuess | null;
    locationGuess: Pin | null;
    modelFamilyGuess: ModelFamily | null;
    submitted: boolean;
  };
  opponentGuess: SubmittedGuess | null;
  actual: {
    participantType: IdentityGuess;
    region?: string;
    country?: string;
    lat?: number;
    lng?: number;
    modelFamily?: ModelFamily;
  };
  explanation: string;
}

interface SubmittedGuess {
  identityGuess: IdentityGuess | null;
  locationGuess: Pin | null;
  modelFamilyGuess: ModelFamily | null;
  submitted: boolean;
}

interface Pin {
  lat: number;
  lng: number;
}

interface PersistentScore {
  readEarned: number;
  readPossible: number;
  humanEarned: number;
  humanPossible: number;
  aiEarned: number;
  aiPossible: number;
}

interface IpLocation {
  country: string;
  region: string;
  city: string;
  lat: number | null;
  lng: number | null;
  source: "ip";
  updatedAt: number;
}

interface AdminSnapshot {
  generatedAt: number;
  waiting: AdminWaitingEntry[];
  rooms: AdminRoom[];
}

interface AdminLocation {
  country?: string;
  region?: string;
  city?: string;
  lat: number | null;
  lng: number | null;
  source?: "ip";
  updatedAt?: number;
}

interface AdminWaitingEntry {
  socketId: string;
  connected: boolean;
  queuedAt: number;
  location: AdminLocation;
}

interface AdminParticipant {
  label: string;
  socketId: string | null;
  type: IdentityGuess;
  location?: AdminLocation;
  modelFamily?: ModelFamily;
  submitted: boolean;
  disconnected: boolean;
}

interface AdminRoom {
  id: string;
  mode: "human" | "ai";
  createdAt: number;
  chatEndsAt: number;
  aiResponseStatus: AdminAiResponseStatus | null;
  participants: AdminParticipant[];
  messages: AdminTranscriptMessage[];
}

interface AdminAiResponseStatus {
  state: "idle" | "generating" | "typing" | "sent" | "failed";
  responseText: string | null;
  source: string | null;
  failed: boolean;
  error: string | null;
  model: string | null;
  delayMs: number | null;
  updatedAt: number;
}

interface AdminTranscriptAiMeta {
  source: string;
  failed: boolean;
  error: string | null;
  model: string | null;
  typingDelayMs: number;
  targetTypingMs: number;
}

interface AdminTranscriptMessage {
  id: string;
  author: string;
  authorLabel: string;
  text: string;
  sentAt: number;
  ai: AdminTranscriptAiMeta | null;
}

const API_URL = resolveServiceUrl(
  import.meta.env.NEXT_PUBLIC_API_URL || import.meta.env.VITE_API_URL,
);

const SOCKET_URL = resolveServiceUrl(
  import.meta.env.NEXT_PUBLIC_SOCKET_URL || import.meta.env.VITE_SOCKET_URL || API_URL,
);

const MODEL_FAMILIES: ModelFamily[] = ["ChatGPT", "Gemini", "Claude", "Grok"];
const SCORE_STORAGE_KEY = "geoturing:scoreboard:v1";
const LOCATION_CONSENT_STORAGE_KEY = "geoturing:location-consent:v1";
const IP_LOCATION_STORAGE_KEY = "geoturing:ip-location:v1";
const PLAYER_ID_STORAGE_KEY = "geoturing:player-id:v1";
const ACTIVE_SESSION_STORAGE_KEY = "geoturing:active-session:v1";
const ADMIN_CONSOLE_PATH = "/host-monitor";
const ADMIN_API_PATH = "/admin/host-monitor";
const ADMIN_TOKEN_STORAGE_KEY = "geoturing:admin-token:v1";
const MIN_MESSAGES_PER_SIDE = 2;
const TURN_SECONDS = 25;
const FINAL_GUESS_SECONDS = 30;
const EMPTY_TURN_STATE: TurnStatePayload = {
  sessionId: "",
  currentTurn: "paused",
  turnEndsAt: null,
  canGuessEarly: false,
  canAbort: false,
  counts: {
    player: 0,
    partner: 0,
  },
  required: MIN_MESSAGES_PER_SIDE,
};
const EMPTY_PERSISTENT_SCORE: PersistentScore = {
  readEarned: 0,
  readPossible: 0,
  humanEarned: 0,
  humanPossible: 0,
  aiEarned: 0,
  aiPossible: 0,
};
const QUEUE_FOUND_DELAY_MS = 2400;
const MATCH_FOUND_HOLD_MS = 1800;
const GUESS_MARKER = L.divIcon({
  className: "guessMarker",
  html: "<span></span>",
  iconSize: [34, 44],
  iconAnchor: [17, 42],
});

function App() {
  return window.location.pathname === ADMIN_CONSOLE_PATH ? <AdminConsole /> : <GameApp />;
}

function GameApp() {
  const playerIdRef = useRef(loadOrCreatePlayerId());
  const socketRef = useRef<Socket | null>(null);
  const queueStartedAtRef = useRef<number | null>(null);
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
  const [estimatedQueueSeconds, setEstimatedQueueSeconds] = useState(8);
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
  const canGuess = chatCounts.player >= MIN_MESSAGES_PER_SIDE && chatCounts.partner >= MIN_MESSAGES_PER_SIDE;
  const isPlayerTurn = phase === "chat" && turnState.currentTurn === "player";
  const isFinalGuessPhase = phase === "identity" || phase === "humanGuess" || phase === "aiGuess" || phase === "waitingGuess";
  const finalGuessExpired = isFinalGuessPhase && finalGuessEndsAt !== null && finalGuessEndsAt <= now;
  const turnSecondsLeft = turnState.turnEndsAt
    ? Math.max(0, Math.ceil((turnState.turnEndsAt - now) / 1000))
    : TURN_SECONDS;
  const finalGuessSecondsLeft = finalGuessEndsAt
    ? Math.max(0, Math.ceil((finalGuessEndsAt - now) / 1000))
    : FINAL_GUESS_SECONDS;

  useEffect(() => {
    if (phase !== "chat" && phase !== "matching" && !isFinalGuessPhase) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 500);

    return () => window.clearInterval(timer);
  }, [isFinalGuessPhase, phase]);

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

  function applyQueueStatus(payload: QueueStatusPayload) {
    const queuedAt = Number.isFinite(payload.queuedAt)
      ? payload.queuedAt
      : queueStartedAtRef.current || Date.now();

    setQueueStatus(payload.status);
    setConnectedProfiles(payload.connectedProfiles);
    setRequiredProfiles(payload.requiredProfiles);
    setQueueStartedAt(queuedAt);
    queueStartedAtRef.current = queuedAt;
    setEstimatedQueueSeconds(payload.estimatedSeconds);

    if (payload.status === "found") {
      setQueueFrozenSeconds((current) => current ?? Math.max(0, Math.floor((Date.now() - queuedAt) / 1000)));
      return;
    }

    setQueueFrozenSeconds(null);
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
      socket.emit("session:resume", {
        playerId: playerIdRef.current,
        sessionId: activeSessionId,
      });
    });

    socket.on("disconnect", () => {
      setConnection("disconnected");
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
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

    socket.on("round:locked", (payload: { message?: string; guessEndsAt?: number }) => {
      setPendingGuessConfirm(false);
      setFinalGuessEndsAt(payload.guessEndsAt || null);
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

    socket.on("session:ended", (payload: { message?: string }) => {
      removeActiveSessionId();
      const message = payload.message || "This round ended.";
      setEndMessage(message);
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
      recordPersistentScore(payload);
      setResult(payload);
      setFinalGuessEndsAt(null);
      removeActiveSessionId();
      setPhase("reveal");
    });

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

    const queuedAt = Date.now();

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
    setQueueFrozenSeconds(null);
    setEstimatedQueueSeconds(8);
    setNow(queuedAt);

    socketRef.current?.disconnect();
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnection("connected");
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
      hiddenAiRequestPendingRef.current = false;
      saveActiveSessionId(payload.sessionId);
      queueTimersRef.current.push(
        window.setTimeout(() => enterChat(payload), getQueueTransitionDelay()),
      );
    });

    socket.on("session:resumed", (payload: SessionResumedPayload) => {
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

    socket.on("round:locked", (payload: { message?: string; guessEndsAt?: number }) => {
      setPendingGuessConfirm(false);
      setFinalGuessEndsAt(payload.guessEndsAt || null);
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

    socket.on("session:ended", (payload: { message?: string }) => {
      removeActiveSessionId();
      const message = payload.message || "This round ended.";
      setEndMessage(message);
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
      recordPersistentScore(payload);
      setResult(payload);
      setFinalGuessEndsAt(null);
      removeActiveSessionId();
      setPhase("reveal");
    });

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
    setQueueFrozenSeconds(null);
    setEstimatedQueueSeconds(8);
  }

  function getQueueTransitionDelay() {
    const startedAt = queueStartedAtRef.current || Date.now();
    const elapsed = Date.now() - startedAt;

    return Math.max(0, QUEUE_FOUND_DELAY_MS + MATCH_FOUND_HOLD_MS - elapsed);
  }

  function enterChat(payload: SessionCreatedPayload) {
    setSessionId(payload.sessionId);
    setChatEndsAt(payload.chatEndsAt);
    setNow(Date.now());
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
    setNow(Date.now());
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
    <main className="appShell">
      <header className="topbar">
        <div>
          <p className="eyebrow">GeoTuring (Preview)</p>
          <h1>Read the room. Then read the world.</h1>
        </div>
        <StatusPill value={connection} />
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
          estimatedSeconds={estimatedQueueSeconds}
          requiredProfiles={requiredProfiles}
          status={queueStatus}
        />
      )}
      {(phase === "chat" || phase === "ended" || isFinalGuessPhase) && (
        <ChatRoom
          canGuess={phase === "chat" && canGuess}
          counts={chatCounts}
          draft={draft}
          endMessage={endMessage}
          finalGuessSecondsLeft={finalGuessSecondsLeft}
          isEnded={phase === "ended"}
          isLocked={isFinalGuessPhase}
          isPlayerTurn={phase === "chat" && isPlayerTurn}
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
      )}
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
      {phase === "reveal" && result && <Reveal result={result} onRestart={restart} />}
    </main>
  );
}

function AdminConsole() {
  const [password, setPassword] = useState("");
  const [token, setToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "");
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(token ? "Connecting" : "Locked");

  useEffect(() => {
    if (!token) {
      return;
    }

    let cancelled = false;

    async function loadRooms() {
      try {
        const response = await fetch(`${API_URL}${ADMIN_API_PATH}/rooms`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.status === 401) {
          sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
          setToken("");
          setSnapshot(null);
          setStatus("Locked");
          setError("Admin session expired. Log in again.");
          return;
        }

        if (!response.ok) {
          throw new Error(`Room snapshot failed with ${response.status}`);
        }

        const payload = (await response.json()) as AdminSnapshot;

        if (!cancelled) {
          setSnapshot(payload);
          setStatus("Live");
          setError("");
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus("Offline");
          setError(loadError instanceof Error ? loadError.message : "Could not load rooms.");
        }
      }
    }

    loadRooms();
    const timer = window.setInterval(loadRooms, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Checking");
    setError("");

    try {
      const response = await fetch(`${API_URL}${ADMIN_API_PATH}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || `Login failed with ${response.status}`);
      }

      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, payload.token);
      setToken(payload.token);
      setPassword("");
      setStatus("Live");
    } catch (loginError) {
      setStatus("Locked");
      setError(loginError instanceof Error ? loginError.message : "Login failed.");
    }
  }

  function logout() {
    sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    setToken("");
    setSnapshot(null);
    setStatus("Locked");
  }

  return (
    <main className="appShell adminShell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Operations console</p>
          <h1>Room monitor</h1>
        </div>
        <div className="adminTopActions">
          <StatusPill value={status} />
          {token && (
            <button className="secondaryButton" onClick={logout}>
              Log out
            </button>
          )}
        </div>
      </header>

      {!token ? (
        <section className="centerPanel adminLogin">
          <p className="roundLabel">Admin login</p>
          <h2>Enter the monitor password.</h2>
          <form onSubmit={login}>
            <input
              autoComplete="current-password"
              autoFocus
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              type="password"
              value={password}
            />
            <button className="primaryButton" disabled={!password} type="submit">
              Unlock
            </button>
          </form>
          {error && <p className="adminError">{error}</p>}
        </section>
      ) : (
        <AdminDashboard error={error} snapshot={snapshot} />
      )}
    </main>
  );
}

function AdminDashboard({ error, snapshot }: { error: string; snapshot: AdminSnapshot | null }) {
  return (
    <section className="adminDashboard">
      <div className="adminSummary">
        <AdminMetric label="Active rooms" value={snapshot ? snapshot.rooms.length : 0} />
        <AdminMetric label="Waiting players" value={snapshot ? snapshot.waiting.length : 0} />
        <AdminMetric label="Last refresh" value={snapshot ? formatTimestamp(snapshot.generatedAt) : "Pending"} />
      </div>

      {error && <p className="adminError">{error}</p>}

      {snapshot && snapshot.waiting.length > 0 && (
        <section className="adminPanel">
          <div className="adminPanelHeader">
            <p className="roundLabel">Queue</p>
            <h2>Waiting players</h2>
          </div>
          <div className="adminQueueList">
            {snapshot.waiting.map((entry) => (
              <div className="adminQueueRow" key={entry.socketId}>
                <strong>{shortSocketId(entry.socketId)}</strong>
                <span>{entry.connected ? "Connected" : "Disconnected"}</span>
                <span>{locationText(entry.location)}</span>
                <time>{formatTimestamp(entry.queuedAt)}</time>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="adminRooms">
        {snapshot?.rooms.length ? (
          snapshot.rooms.map((room) => <AdminRoomCard key={room.id} room={room} />)
        ) : (
          <div className="adminPanel emptyRooms">
            <p className="roundLabel">Rooms</p>
            <h2>No active rooms.</h2>
          </div>
        )}
      </section>
    </section>
  );
}

function AdminMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AdminRoomCard({ room }: { room: AdminRoom }) {
  return (
    <article className="adminPanel roomCard">
      <div className="adminPanelHeader">
        <div>
          <p className="roundLabel">{room.mode === "human" ? "Human room" : "AI room"}</p>
          <h2>{room.id}</h2>
        </div>
        <div className="roomTimes">
          <span>Created {formatTimestamp(room.createdAt)}</span>
          <span>Ends {formatTimestamp(room.chatEndsAt)}</span>
        </div>
      </div>

      {room.aiResponseStatus && (
        <div className={`aiAdminStatus ${room.aiResponseStatus.failed ? "failed" : ""}`}>
          <div>
            <span>AI status</span>
            <strong>{formatAiState(room.aiResponseStatus.state)}</strong>
          </div>
          <div>
            <span>Source</span>
            <strong>{formatAiSource(room.aiResponseStatus.source)}</strong>
          </div>
          {room.aiResponseStatus.delayMs !== null && (
            <div>
              <span>Typing delay</span>
              <strong>{formatMs(room.aiResponseStatus.delayMs)}</strong>
            </div>
          )}
          {room.aiResponseStatus.error && (
            <div className="aiAdminError">
              <span>Failure</span>
              <strong>{room.aiResponseStatus.error}</strong>
            </div>
          )}
          {room.aiResponseStatus.responseText && (
            <div className="aiAdminResponse">
              <span>Exact response</span>
              <strong>{room.aiResponseStatus.responseText}</strong>
            </div>
          )}
        </div>
      )}

      <div className="participantGrid">
        {room.participants.map((participant) => (
          <div className="participantCard" key={`${room.id}:${participant.label}`}>
            <div>
              <strong>{participant.label}</strong>
              <span>{participant.type}</span>
            </div>
            <small>{participant.socketId ? shortSocketId(participant.socketId) : participant.modelFamily}</small>
            <small>{participant.location ? locationText(participant.location) : "Model family monitor"}</small>
            <div className="adminFlags">
              <span>{participant.submitted ? "Submitted" : "Open"}</span>
              <span>{participant.disconnected ? "Left" : "Connected"}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="transcript">
        {room.messages.length ? (
          room.messages.map((message) => (
            <div className="transcriptMessage" key={message.id}>
              <div>
                <strong>{message.authorLabel}</strong>
                <time>{formatTimestamp(message.sentAt)}</time>
              </div>
              {message.ai && (
                <div className={`aiTranscriptMeta ${message.ai.failed ? "failed" : ""}`}>
                  <span>{formatAiSource(message.ai.source)}</span>
                  <span>{message.ai.failed ? "Fallback after failure" : "Delivered"}</span>
                  <span>{formatMs(message.ai.typingDelayMs)} delay</span>
                  {message.ai.error && <span>{message.ai.error}</span>}
                </div>
              )}
              <p>{message.text}</p>
            </div>
          ))
        ) : (
          <p className="emptyTranscript">No chat messages yet.</p>
        )}
      </div>
    </article>
  );
}

function formatAiState(value: string) {
  const labels: Record<string, string> = {
    idle: "Idle",
    generating: "Generating",
    typing: "Typing",
    sent: "Sent",
    failed: "Failed",
  };

  return labels[value] || value;
}

function formatAiSource(value: string | null) {
  if (!value) {
    return "Unknown";
  }

  const labels: Record<string, string> = {
    openrouter: "OpenRouter",
    local: "Local mock",
    local_fallback: "Local fallback",
  };

  return labels[value] || value;
}

function formatMs(value: number) {
  if (!Number.isFinite(value)) {
    return "0.0s";
  }

  return `${(value / 1000).toFixed(1)}s`;
}

function StatusPill({ value }: { value: string }) {
  const statusClass = value.toLowerCase();

  return (
    <div className={`statusPill ${statusClass === "connected" || statusClass === "live" ? "online" : ""}`}>
      <span />
      {value}
    </div>
  );
}

function Landing({
  ipLocation,
  locationConsent,
  locationStatus,
  onLocationAgreement,
  onStart,
  persistentScore,
}: {
  ipLocation: IpLocation | null;
  locationConsent: boolean;
  locationStatus: string;
  onLocationAgreement: (agreed: boolean) => void;
  onStart: () => void;
  persistentScore: PersistentScore;
}) {
  const hasLocation = hasValidIpLocation(ipLocation);
  const canUsePrimaryAction = locationConsent && locationStatus !== "checking";

  return (
    <section className="heroPanel">
      <div className="heroCopy">
        <p className="roundLabel">Real-time deduction MVP</p>
        <h2>Chat anonymously with a stranger or a machine.</h2>
        <p>
          Ask a few questions, decide whether your partner is human or AI, then
          make the second guess: place their location on the world map or call
          the model family.
        </p>
        <button className="primaryButton" disabled={!canUsePrimaryAction} onClick={onStart}>
          {locationStatus === "checking" ? "Checking location" : hasLocation ? "Start matchmaking" : "Check location"}
        </button>
      </div>
      <div className="scoreSidebar">
        <IpLocationConsentCard
          agreed={locationConsent}
          location={ipLocation}
          onAgreement={onLocationAgreement}
          status={locationStatus}
        />
        <PersistentScoreboard score={persistentScore} />
        <div className="scorePreview" aria-label="Scoring preview">
          <div>
            <span>Read score</span>
            <strong>0/1 or 1/1</strong>
          </div>
          <div>
            <span>Human round</span>
            <strong>0-100</strong>
          </div>
          <div>
            <span>AI round</span>
            <strong>0/1 or 1/1</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function IpLocationConsentCard({
  agreed,
  location,
  onAgreement,
  status,
}: {
  agreed: boolean;
  location: IpLocation | null;
  onAgreement: (agreed: boolean) => void;
  status: string;
}) {
  const statusText = getIpLocationStatusText(status, agreed, location);

  return (
    <aside className="locationCard" aria-label="Rough location">
      <div>
        <p className="roundLabel">Rough location consent</p>
        <strong>{location ? location.country : agreed ? "Checking IP" : "Required"}</strong>
        <span>{statusText}</span>
      </div>
      <label className="consentCheck">
        <input
          checked={agreed}
          onChange={(event) => onAgreement(event.target.checked)}
          type="checkbox"
        />
        <span>I agree to a rough IP-based location check while playing.</span>
      </label>
    </aside>
  );
}

function PersistentScoreboard({ score }: { score: PersistentScore }) {
  const readPercent =
    score.readPossible === 0 ? 0 : Math.round((score.readEarned / score.readPossible) * 100);
  const humanAverage =
    score.humanPossible === 0 ? 0 : Math.round((score.humanEarned / score.humanPossible) * 100);
  const aiPercent = score.aiPossible === 0 ? 0 : Math.round((score.aiEarned / score.aiPossible) * 100);

  return (
    <aside className="persistentScore" aria-label="Persistent score">
      <p className="roundLabel">Your scoreboard</p>
      <div className="persistentScoreRows">
        <ScoreLine label="Reads" value={`${score.readEarned}/${score.readPossible}`} detail={`${readPercent}%`} />
        <ScoreLine label="Human score" value={`${score.humanEarned}/${score.humanPossible}`} detail={`${humanAverage}% avg`} />
        <ScoreLine label="AI score" value={`${score.aiEarned}/${score.aiPossible}`} detail={`${aiPercent}%`} />
      </div>
    </aside>
  );
}

function ScoreLine({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Matchmaking({
  actualSeconds,
  connectedProfiles,
  estimatedSeconds,
  requiredProfiles,
  status,
}: {
  actualSeconds: number;
  connectedProfiles: number;
  estimatedSeconds: number;
  requiredProfiles: number;
  status: QueueStatus;
}) {
  const isFound = status === "found";

  return (
    <section className={`queuePanel ${isFound ? "matchFound" : ""}`}>
      <div className="queueFrame">
        <div className="queueHeader">
          <p className="roundLabel">Blind pick queue</p>
          <h2>{isFound ? "Match found!" : "Finding match"}</h2>
        </div>

        <div className="summonerSlots" aria-label={`${connectedProfiles} of ${requiredProfiles} profiles connected`}>
          <ProfileSlot label="You" active={connectedProfiles >= 1} />
          <ProfileSlot label="Unknown" active={connectedProfiles >= 2} />
        </div>

        <div className="queueMeter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (connectedProfiles / requiredProfiles) * 100)}%` }} />
        </div>

        <div className="queueStatusLine">
          <strong>
            {Math.min(connectedProfiles, requiredProfiles)}/{requiredProfiles} profiles connected
          </strong>
          <span>{isFound ? "Entering game..." : "Searching for a worthy opponent"}</span>
        </div>

        <div className="queueTimes">
          <div>
            <span>Actual Queue Time</span>
            <strong>{formatSeconds(actualSeconds)}</strong>
          </div>
          <div>
            <span>Estimated Queue Time</span>
            <strong>{formatSeconds(estimatedSeconds)}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProfileSlot({ active, label }: { active: boolean; label: string }) {
  return (
    <div className={`profileSlot ${active ? "active" : ""}`}>
      <div className="portrait">
        {active ? <span className="profileIcon" /> : <span className="unknownIcon">?</span>}
      </div>
      <strong>{active ? label : "Waiting..."}</strong>
      <small>{active ? "Connected" : "Pending"}</small>
    </div>
  );
}

function ChatRoom({
  canGuess,
  counts,
  messages,
  draft,
  endMessage,
  finalGuessSecondsLeft,
  isEnded,
  isLocked,
  isPlayerTurn,
  pendingGuessConfirm,
  secondsLeft,
  turnSecondsLeft,
  turnState,
  onCancelGuess,
  onConfirmGuess,
  onDraft,
  onSend,
  onGuess,
  onRestart,
}: {
  canGuess: boolean;
  counts: MessageCounts;
  messages: ChatMessage[];
  draft: string;
  endMessage: string;
  finalGuessSecondsLeft: number;
  isEnded: boolean;
  isLocked: boolean;
  isPlayerTurn: boolean;
  pendingGuessConfirm: boolean;
  secondsLeft: number;
  turnSecondsLeft: number;
  turnState: TurnStatePayload;
  onCancelGuess: () => void;
  onConfirmGuess: () => void;
  onDraft: (value: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onGuess: () => void;
  onRestart: () => void;
}) {
  const canSend = draft.trim().length > 0 && isPlayerTurn && !isEnded && !isLocked;
  const guessLabel = canGuess
    ? "Guess"
    : `Guess ${Math.min(counts.player, MIN_MESSAGES_PER_SIDE)}/${MIN_MESSAGES_PER_SIDE} ${Math.min(
      counts.partner,
      MIN_MESSAGES_PER_SIDE,
    )}/${MIN_MESSAGES_PER_SIDE}`;
  const turnLabel =
    turnState.currentTurn === "player"
      ? "Your turn"
      : turnState.currentTurn === "partner"
        ? "Their turn"
        : turnState.canAbort
          ? "Ready"
          : "Waiting";
  const turnClockLabel = isEnded
    ? "--"
    : isLocked
      ? `${finalGuessSecondsLeft}s`
      : turnState.currentTurn === "paused"
        ? "--"
        : `${turnSecondsLeft}s`;
  const showPartnerTyping = !isEnded && !isLocked && turnState.currentTurn === "partner";

  return (
    <section className="gamePanel chatLayout">
      <div className="chatHeader">
        <div>
          <p className="roundLabel">Anonymous chat</p>
          <h2>Find the tell.</h2>
        </div>
        <div className="timerStack">
          <div>
            <span>Round</span>
            <strong>{formatSeconds(secondsLeft)}</strong>
          </div>
          <div className={isPlayerTurn ? "activeTurn" : ""}>
            <span>{isEnded ? "Ended" : isLocked ? "Guess" : turnLabel}</span>
            <strong>{turnClockLabel}</strong>
          </div>
        </div>
      </div>

      {isEnded && <div className="chatEndedBanner">{endMessage || "This round ended."}</div>}

      <div className="messages" aria-live="polite">
        {messages.map((message) => (
          <div className={`message ${message.author}`} key={message.id}>
            {message.text}
          </div>
        ))}
        {showPartnerTyping && (
          <div className="message partner typingBubble" aria-label="Their turn, typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      {isEnded ? (
        <div className="composer endedComposer">
          <button className="primaryButton" type="button" onClick={onRestart}>
            Play again
          </button>
        </div>
      ) : isLocked ? (
        <div className="chatEndedBanner">Chat locked. Use the final guess below.</div>
      ) : (
        <div className="chatControls">
          {pendingGuessConfirm && (
            <div className="guessConfirm">
              <span>Lock chat and make final guesses?</span>
              <div>
                <button className="secondaryButton" type="button" onClick={onCancelGuess}>
                  Cancel
                </button>
                <button className="primaryButton" type="button" onClick={onConfirmGuess}>
                  Lock round
                </button>
              </div>
            </div>
          )}
          <form className="composer" onSubmit={onSend}>
            <input
              disabled={!isPlayerTurn}
              maxLength={400}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder={isPlayerTurn ? "Ask something revealing..." : "Waiting for their message..."}
            />
            <button disabled={!canSend} type="submit">
              Send
            </button>
            <button className="secondaryButton" disabled={!canGuess} type="button" onClick={onGuess}>
              {guessLabel}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

function FinalGuessTimer({ secondsLeft }: { secondsLeft: number }) {
  return (
    <div className="finalGuessTimer" aria-label={`${secondsLeft} seconds left to guess`}>
      <span>Guess timer</span>
      <strong>{secondsLeft}s</strong>
    </div>
  );
}

function IdentityGuessScreen({
  disabled,
  secondsLeft,
  onPick,
}: {
  disabled: boolean;
  secondsLeft: number;
  onPick: (value: IdentityGuess) => void;
}) {
  return (
    <section className="centerPanel">
      <div className="finalGuessHeader">
        <div>
          <p className="roundLabel">First guess</p>
          <h2>Who were you talking to?</h2>
        </div>
        <FinalGuessTimer secondsLeft={secondsLeft} />
      </div>
      <div className="choiceGrid two">
        <button disabled={disabled} onClick={() => onPick("Human")}>
          <span>Human</span>
          <small>Next: place a map pin</small>
        </button>
        <button disabled={disabled} onClick={() => onPick("AI")}>
          <span>AI</span>
          <small>Next: pick the model family</small>
        </button>
      </div>
    </section>
  );
}

function HumanGuessScreen({
  disabled,
  pin,
  secondsLeft,
  onPin,
  onBack,
  onSubmit,
}: {
  disabled: boolean;
  pin: Pin | null;
  secondsLeft: number;
  onPin: (pin: Pin) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="gamePanel">
      <div className="chatHeader">
        <div>
          <p className="roundLabel">Human read</p>
          <h2>Place the origin pin.</h2>
        </div>
        <div className="guessHeaderActions">
          <FinalGuessTimer secondsLeft={secondsLeft} />
          <button className="secondaryButton" disabled={disabled} onClick={onBack}>
            Back
          </button>
        </div>
      </div>

      <GuessMap disabled={disabled} pin={pin} onPin={onPin} />

      <div className="mapFooter">
        <span>
          {disabled
            ? "Final guess time expired."
            : pin
              ? `${pin.lat.toFixed(1)} lat, ${pin.lng.toFixed(1)} lng`
              : "Tap the map to place a pin."}
        </span>
        <button className="primaryButton" disabled={disabled || !pin} onClick={onSubmit}>
          Lock human guess
        </button>
      </div>
    </section>
  );
}

function GuessMap({ disabled, pin, onPin }: { disabled: boolean; pin: Pin | null; onPin: (pin: Pin) => void }) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onPinRef = useRef(onPin);
  const disabledRef = useRef(disabled);

  useEffect(() => {
    onPinRef.current = onPin;
  }, [onPin]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapElementRef.current, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: true,
      zoomControl: false,
    });

    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    map.on("click", (event: L.LeafletMouseEvent) => {
      if (disabledRef.current) {
        return;
      }

      onPinRef.current({
        lat: event.latlng.lat,
        lng: event.latlng.lng,
      });
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    window.setTimeout(() => map.invalidateSize(), 0);

    if (!pin) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    const latLng = L.latLng(pin.lat, pin.lng);

    if (!markerRef.current) {
      markerRef.current = L.marker(latLng, {
        icon: GUESS_MARKER,
      }).addTo(map);
    } else {
      markerRef.current.setLatLng(latLng);
    }
  }, [pin]);

  return (
    <div className="guessMapShell">
      <div className="guessMap" ref={mapElementRef} />
      <div className="mapCallout">
        {disabled ? "Final guess time expired." : "Click anywhere to place your final guess."}
      </div>
    </div>
  );
}

function AiGuessScreen({
  disabled,
  secondsLeft,
  selected,
  onPick,
  onBack,
}: {
  disabled: boolean;
  secondsLeft: number;
  selected: ModelFamily | null;
  onPick: (family: ModelFamily) => void;
  onBack: () => void;
}) {
  return (
    <section className="centerPanel">
      <div className="chatHeader compact">
        <div>
          <p className="roundLabel">AI read</p>
          <h2>Pick the model family.</h2>
        </div>
        <div className="guessHeaderActions">
          <FinalGuessTimer secondsLeft={secondsLeft} />
          <button className="secondaryButton" disabled={disabled} onClick={onBack}>
            Back
          </button>
        </div>
      </div>
      <div className="choiceGrid">
        {MODEL_FAMILIES.map((family) => (
          <button
            className={selected === family ? "selected" : ""}
            disabled={disabled}
            key={family}
            onClick={() => onPick(family)}
          >
            <span>{family}</span>
            <small>Lock answer</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function WaitingGuessScreen({ secondsLeft }: { secondsLeft: number }) {
  return (
    <section className="centerPanel finalGuessPanel">
      <p className="roundLabel">Final read locked</p>
      <h2>Waiting for opponent's guess.</h2>
      <p>{secondsLeft}s left before missing guesses are scored as zero.</p>
    </section>
  );
}

function Reveal({ result, onRestart }: { result: ResultPayload; onRestart: () => void }) {
  const actual =
    result.actual.participantType === "Human"
      ? `${result.actual.region}, ${result.actual.country}`
      : `${result.actual.modelFamily}`;
  const roundLabel = result.score.round.type === "location" ? "Location round" : "AI family round";
  const roundDetail =
    result.score.round.type === "location"
      ? result.distanceKm === null
        ? "No valid location pin"
        : `${result.distanceKm} km away`
      : `You guessed ${result.guess.modelFamilyGuess || "no family"}`;

  return (
    <section className="gamePanel reveal">
      <p className="roundLabel">Reveal</p>
      <div className="revealTop">
        <h2>{result.correctIdentity ? "Correct read." : "Wrong read."}</h2>
        <div className="scoreBadges">
          <div className="scoreBadge">
            <span>Read</span>
            <strong>
              {result.score.read.earned}/{result.score.read.possible}
            </strong>
          </div>
          <div className="scoreBadge">
            <span>Round</span>
            <strong>
              {result.score.round.earned}/{result.score.round.possible}
            </strong>
          </div>
        </div>
      </div>
      <div className="revealGrid">
        <ResultStat label="Actual" value={`${result.actual.participantType}: ${actual}`} />
        <ResultStat label="Your read" value={result.guess.identityGuess || "No guess"} />
        <ResultStat label={roundLabel} value={`${result.score.round.earned}/${result.score.round.possible}`} />
        <ResultStat label="Round detail" value={roundDetail} />
      </div>
      <OpponentGuess guess={result.opponentGuess} />
      <p className="explanation">{result.explanation}</p>
      <button className="primaryButton" onClick={onRestart}>
        Play again
      </button>
    </section>
  );
}

function OpponentGuess({ guess }: { guess: SubmittedGuess | null }) {
  if (!guess) {
    return null;
  }

  const label = guess.submitted ? guess.identityGuess || "No guess" : "No guess";
  const detail =
    guess.identityGuess === "Human"
      ? guess.locationGuess
        ? `${guess.locationGuess.lat.toFixed(2)}, ${guess.locationGuess.lng.toFixed(2)}`
        : "No location pin"
      : guess.identityGuess === "AI"
        ? guess.modelFamilyGuess || "No model family"
        : "Timed out";

  return (
    <div className="opponentGuess">
      <div>
        <p className="roundLabel">Opponent guess</p>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      {guess.identityGuess === "Human" && guess.locationGuess && <GuessPreviewMap pin={guess.locationGuess} />}
    </div>
  );
}

function GuessPreviewMap({ pin }: { pin: Pin }) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapElementRef.current, {
      center: [pin.lat, pin.lng],
      zoom: 4,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);
    L.marker([pin.lat, pin.lng], {
      icon: GUESS_MARKER,
    }).addTo(map);
    mapRef.current = map;
    window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [pin.lat, pin.lng]);

  return <div className="opponentGuessMap" ref={mapElementRef} />;
}

function ResultStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="resultStat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatSeconds(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getVisibleMessageCounts(messages: ChatMessage[]): MessageCounts {
  return {
    player: messages.filter((message) => message.author === "player").length,
    partner: messages.filter((message) => message.author === "partner").length,
  };
}

function formatTimestamp(value: number) {
  if (!Number.isFinite(value)) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function shortSocketId(socketId: string) {
  return socketId.length <= 8 ? socketId : `${socketId.slice(0, 8)}...`;
}

function locationText(location?: AdminLocation | null) {
  if (!location) {
    return "Unknown location";
  }

  const place = [location.city, location.region, location.country].filter(Boolean).join(", ");
  const coordinates =
    Number.isFinite(location.lat) && Number.isFinite(location.lng)
      ? `${Number(location.lat).toFixed(2)}, ${Number(location.lng).toFixed(2)}`
      : "";

  return [place, coordinates].filter(Boolean).join(" / ") || "Unknown location";
}

function resolveServiceUrl(configuredUrl?: string) {
  const fallbackUrl =
    typeof window !== "undefined" && isProductionHost(window.location.hostname)
      ? "https://api.geoturing.com"
      : "http://localhost:3000";
  const value = configuredUrl || fallbackUrl;

  if (typeof window === "undefined") {
    return value;
  }

  try {
    const url = new URL(value);
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";

    if (window.location.protocol === "https:" && url.protocol === "http:" && !isLocal) {
      url.protocol = "https:";
    }

    if (window.location.protocol === "https:" && isProductionHost(window.location.hostname) && isLocal) {
      return "https://api.geoturing.com";
    }

    return url.toString().replace(/\/$/, "");
  } catch {
    return fallbackUrl;
  }
}

function isProductionHost(hostname: string) {
  return hostname === "geoturing.com" || hostname === "www.geoturing.com";
}

function getIpLocationStatusText(status: string, agreed: boolean, location: IpLocation | null) {
  if (hasValidIpLocation(location)) {
    const place = [location.city, location.region].filter(Boolean).join(", ");

    return place ? `${place}. Estimated from your IP.` : "Estimated from your IP.";
  }

  if (!agreed) {
    return "Required so another player can guess your rough whereabouts.";
  }

  if (status === "checking") {
    return "Checking your rough IP location.";
  }

  if (status === "unavailable") {
    return "IP lookup failed. Refresh or try again before matchmaking.";
  }

  if (status === "invalid") {
    return "Your saved location had no usable coordinates, so it is being checked again.";
  }

  return "Location check will run from your network/IP.";
}

function loadPersistentScore(): PersistentScore {
  if (typeof window === "undefined") {
    return EMPTY_PERSISTENT_SCORE;
  }

  try {
    const raw = window.localStorage.getItem(SCORE_STORAGE_KEY);

    if (!raw) {
      return EMPTY_PERSISTENT_SCORE;
    }

    const parsed = JSON.parse(raw) as Partial<PersistentScore>;

    return {
      readEarned: toScoreNumber(parsed.readEarned),
      readPossible: toScoreNumber(parsed.readPossible),
      humanEarned: toScoreNumber(parsed.humanEarned),
      humanPossible: toScoreNumber(parsed.humanPossible),
      aiEarned: toScoreNumber(parsed.aiEarned),
      aiPossible: toScoreNumber(parsed.aiPossible),
    };
  } catch {
    return EMPTY_PERSISTENT_SCORE;
  }
}

function savePersistentScore(score: PersistentScore) {
  try {
    window.localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(score));
  } catch {
    // The in-memory scoreboard still updates if storage is unavailable.
  }
}

function loadLocationConsent() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(LOCATION_CONSENT_STORAGE_KEY) === "true";
}

function saveLocationConsent(agreed: boolean) {
  try {
    window.localStorage.setItem(LOCATION_CONSENT_STORAGE_KEY, String(agreed));
  } catch {
    // The current checkbox state still works if storage is unavailable.
  }
}

function loadOrCreatePlayerId() {
  if (typeof window === "undefined") {
    return createPlayerId();
  }

  try {
    const existing = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY);

    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) {
      return existing;
    }

    const next = createPlayerId();
    window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return createPlayerId();
  }
}

function createPlayerId() {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `player-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function loadActiveSessionId() {
  if (typeof window === "undefined") {
    return "";
  }

  try {
    return window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function saveActiveSessionId(sessionId: string) {
  try {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Session resume is best effort when storage is unavailable.
  }
}

function removeActiveSessionId() {
  try {
    window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // Nothing else to do if storage is unavailable.
  }
}

function loadIpLocation(): IpLocation | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(IP_LOCATION_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<IpLocation>;
    const country = typeof parsed.country === "string" ? parsed.country : "";

    if (!country) {
      return null;
    }

    const location = {
      country,
      region: typeof parsed.region === "string" ? parsed.region : "",
      city: typeof parsed.city === "string" ? parsed.city : "",
      lat: toLocationNumber(parsed.lat, -90, 90),
      lng: toLocationNumber(parsed.lng, -180, 180),
      source: "ip",
      updatedAt: toScoreNumber(parsed.updatedAt),
    };

    return hasValidIpLocation(location) ? location : null;
  } catch {
    return null;
  }
}

function saveIpLocation(location: IpLocation) {
  try {
    window.localStorage.setItem(IP_LOCATION_STORAGE_KEY, JSON.stringify(location));
  } catch {
    // Location still appears for the current session if storage is unavailable.
  }
}

function removeIpLocation() {
  try {
    window.localStorage.removeItem(IP_LOCATION_STORAGE_KEY);
  } catch {
    // Nothing else to do if storage is unavailable.
  }
}

function toScoreNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function toLocationNumber(value: unknown, min: number, max: number) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function hasValidIpLocation(location: IpLocation | AdminLocation | null | undefined) {
  return Boolean(
    location &&
    Number.isFinite(location.lat) &&
    Number.isFinite(location.lng) &&
    Math.abs(Number(location.lat)) <= 90 &&
    Math.abs(Number(location.lng)) <= 180,
  );
}

createRoot(document.getElementById("root")!).render(<App />);
