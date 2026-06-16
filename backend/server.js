require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
const { MODEL_FAMILIES, createAiProvider } = require("./aiAdapters");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const CHAT_SECONDS = 90;

const corsOptions = {
  origin: FRONTEND_URL,
};

app.use(cors(corsOptions));
app.use(express.json());

const io = new Server(server, {
  cors: corsOptions,
});

app.get("/", (req, res) => {
  res.json({
    name: "GeoTuring API",
    status: "ok",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
  });
});

const sessions = new Map();
const waitingQueue = new Map();
const socketSessions = new Map();
const AI_FALLBACK_SECONDS = 20;
const QUEUE_ESTIMATED_SECONDS = 8;
const GUESS_GRACE_SECONDS = 300;
const MIN_MESSAGES_PER_SIDE = 2;
const TURN_SECONDS = 25;
const TURN_MS = TURN_SECONDS * 1000;
const AI_TYPING_MIN_RATIO = 0.05;
const AI_TYPING_MAX_RATIO = 0.82;
const AI_SEND_DEADLINE_BUFFER_MS = 750;
const FINAL_GUESS_SECONDS = 25;
const FINAL_GUESS_MS = FINAL_GUESS_SECONDS * 1000;
const ADMIN_API_PATH = "/admin/host-monitor";
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const adminTokens = new Map();
const adminPasswordHash = ADMIN_PASSWORD ? sha256(ADMIN_PASSWORD) : null;

app.post(`${ADMIN_API_PATH}/login`, (req, res) => {
  if (!adminPasswordHash) {
    res.status(503).json({
      error: "Admin password is not configured.",
    });
    return;
  }

  if (!isValidAdminPassword(req.body?.password)) {
    res.status(401).json({
      error: "Invalid admin login.",
    });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
  adminTokens.set(token, expiresAt);
  purgeExpiredAdminTokens();

  res.json({
    token,
    expiresAt,
  });
});

app.get(`${ADMIN_API_PATH}/rooms`, requireAdminAuth, (req, res) => {
  res.json(buildAdminSnapshot());
});

function addToQueue(socket, payload = {}) {
  if (socketSessions.has(socket.id)) {
    return;
  }

  const playerId = sanitizePlayerId(payload.playerId);
  socket.data.playerId = playerId;
  const resumableSession = findSessionByPlayerId(playerId, payload.sessionId);

  if (resumableSession) {
    resumeSession(socket, {
      playerId,
      sessionId: resumableSession.id,
    });
    return;
  }

  if (waitingQueue.has(socket.id)) {
    emitQueueStatus(waitingQueue.get(socket.id));
    return;
  }

  removeQueuedPlayer(playerId);

  const entry = {
    socket,
    playerId,
    location: sanitizeLocation(payload.location),
    queuedAt: Date.now(),
    fallbackTimer: null,
  };

  if (!hasValidLocation(entry.location)) {
    socket.emit("queue:error", {
      code: "location_required",
      message: "A valid rough IP location is required for human matchmaking.",
    });
    return;
  }

  waitingQueue.set(socket.id, entry);
  emitQueueStatus(entry);
  pairWaitingPlayers();

  if (waitingQueue.has(socket.id)) {
    entry.fallbackTimer = setTimeout(() => {
      if (!waitingQueue.has(socket.id) || !socket.connected) {
        return;
      }

      removeFromQueue(socket.id);
      createAiSession(socket, entry.location, null, entry.queuedAt);
    }, AI_FALLBACK_SECONDS * 1000);
  }
}

function pairWaitingPlayers() {
  const connectedEntries = [...waitingQueue.values()].filter((entry) => entry.socket.connected);

  while (connectedEntries.length >= 2) {
    const first = connectedEntries.shift();
    const secondIndex = connectedEntries.findIndex((entry) => entry.playerId !== first?.playerId);
    const second = secondIndex >= 0 ? connectedEntries.splice(secondIndex, 1)[0] : null;

    if (!first || !second || first.socket.id === second.socket.id || first.playerId === second.playerId) {
      continue;
    }

    removeFromQueue(first.socket.id);
    removeFromQueue(second.socket.id);
    createHumanSession(first, second);
  }
}

function emitQueueStatus(entry) {
  entry.socket.emit("queue:status", {
    connectedProfiles: 1,
    requiredProfiles: 2,
    status: "searching",
    queuedAt: entry.queuedAt,
    estimatedSeconds: QUEUE_ESTIMATED_SECONDS,
  });
}

function emitMatchFound(entries) {
  entries.forEach((entry) => {
    entry.socket.emit("queue:status", {
      connectedProfiles: 2,
      requiredProfiles: 2,
      status: "found",
      queuedAt: entry.queuedAt,
      estimatedSeconds: QUEUE_ESTIMATED_SECONDS,
    });
  });
}

function removeFromQueue(socketId) {
  const entry = waitingQueue.get(socketId);

  if (!entry) {
    return;
  }

  if (entry.fallbackTimer) {
    clearTimeout(entry.fallbackTimer);
  }

  waitingQueue.delete(socketId);
}

function removeQueuedPlayer(playerId) {
  for (const [socketId, entry] of waitingQueue.entries()) {
    if (entry.playerId === playerId) {
      removeFromQueue(socketId);
    }
  }
}

function createHumanSession(first, second) {
  const chatEndsAt = Date.now() + CHAT_SECONDS * 1000;
  const session = {
    id: cryptoRandomId(),
    mode: "human",
    players: {
      [first.socket.id]: createHumanSessionPlayer(first),
      [second.socket.id]: createHumanSessionPlayer(second),
    },
    messages: [],
    createdAt: Date.now(),
    chatEndsAt,
    ended: false,
    chatLocked: false,
    turnOwner: null,
    turnEndsAt: null,
    turnTimer: null,
    chatTimer: null,
    finalGuessEndsAt: null,
    finalGuessTimer: null,
    aiResponseStatus: createAiResponseStatus("idle"),
    timeout: null,
    expireTimer: null,
  };

  sessions.set(session.id, session);
  socketSessions.set(first.socket.id, session.id);
  socketSessions.set(second.socket.id, session.id);
  first.socket.join(session.id);
  second.socket.join(session.id);
  emitMatchFound([first, second]);
  scheduleChatEnd(session);
  scheduleSessionExpiry(session);

  [first.socket, second.socket].forEach((socket) => {
    socket.emit("session:created", {
      sessionId: session.id,
      chatEndsAt: session.chatEndsAt,
      chatSeconds: CHAT_SECONDS,
      intro: "An anonymous participant has joined.",
    });
  });

  startTurn(session, pick([first.socket.id, second.socket.id]));

  return session;
}

function createAiSession(socket, playerLocation, requestedModelFamily = null, queuedAt = Date.now()) {
  const modelFamily = MODEL_FAMILIES.includes(requestedModelFamily) ? requestedModelFamily : pick(MODEL_FAMILIES);
  const chatEndsAt = Date.now() + CHAT_SECONDS * 1000;
  const playerId = sanitizePlayerId(socket.data.playerId);
  const session = {
    id: cryptoRandomId(),
    mode: "ai",
    playerSocketId: socket.id,
    playerId,
    playerLocation,
    participant: {
      kind: "AI",
      modelFamily,
      adapter: createAiProvider(modelFamily),
    },
    messages: [],
    createdAt: Date.now(),
    chatEndsAt,
    submitted: false,
    disconnected: false,
    ended: false,
    chatLocked: false,
    turnOwner: null,
    turnEndsAt: null,
    turnTimer: null,
    chatTimer: null,
    finalGuessEndsAt: null,
    finalGuessTimer: null,
    timeout: null,
    expireTimer: null,
  };

  sessions.set(session.id, session);
  socketSessions.set(socket.id, session.id);
  socket.join(session.id);
  scheduleChatEnd(session);
  scheduleSessionExpiry(session);

  socket.emit("queue:status", {
    connectedProfiles: 2,
    requiredProfiles: 2,
    status: "found",
    queuedAt,
    estimatedSeconds: QUEUE_ESTIMATED_SECONDS,
  });

  socket.emit("session:created", {
    sessionId: session.id,
    chatEndsAt: session.chatEndsAt,
    chatSeconds: CHAT_SECONDS,
    intro: "An anonymous participant has joined.",
  });

  startTurn(session, pick([socket.id, "partner"]));

  return session;
}

function createRequestedAiSession(socket, payload = {}) {
  if (socketSessions.has(socket.id)) {
    return;
  }

  const queueEntry = waitingQueue.get(socket.id);
  removeFromQueue(socket.id);

  const playerId = sanitizePlayerId(payload.playerId);
  const location = sanitizeLocation(payload.location);
  socket.data.playerId = playerId;

  if (!hasValidLocation(location)) {
    socket.emit("queue:error", {
      code: "location_required",
      message: "A valid rough IP location is required for AI testing.",
    });
    return;
  }

  createAiSession(socket, location, payload.modelFamily, queueEntry?.queuedAt || Date.now());
}

function createHumanSessionPlayer(entry) {
  return {
    socketId: entry.socket.id,
    playerId: entry.playerId,
    location: entry.location,
    submitted: false,
    disconnected: false,
    guess: null,
    result: null,
  };
}

function handleChatMessage(socket, payload = {}) {
  const session = sessions.get(payload.sessionId);

  if (!isSocketInSession(session, socket.id) || session.ended || session.chatLocked) {
    return;
  }

  if (Date.now() >= session.chatEndsAt) {
    handleChatExpired(session.id);
    return;
  }

  const text = String(payload.text || "").trim().slice(0, 400);

  if (!text) {
    return;
  }

  if (session.turnOwner !== socket.id) {
    socket.emit("chat:error", {
      code: "not_your_turn",
      message: "Wait for your turn before sending a message.",
    });
    return;
  }

  clearTurnTimer(session);
  session.timeout = null;

  session.messages.push({
    author: socket.id,
    text,
    sentAt: Date.now(),
  });

  if (session.mode === "human") {
    const partnerSocketId = getHumanPartnerSocketId(session, socket.id);

    if (!partnerSocketId) {
      return;
    }

    socket.to(partnerSocketId).emit("partner:message", {
      sessionId: session.id,
      message: {
        id: cryptoRandomId(),
        author: "partner",
        text,
        sentAt: Date.now(),
      },
    });
    startTurn(session, partnerSocketId);
    return;
  }

  startTurn(session, "partner");
}

function handleGuessSubmit(socket, payload = {}) {
  const session = sessions.get(payload.sessionId);

  if (!isSocketInSession(session, socket.id) || session.ended) {
    return;
  }

  if (!session.chatLocked) {
    socket.emit("guess:error", {
      code: "not_ready",
      message: "Lock the round before submitting a final guess.",
      counts: getPersonalMessageCounts(session, socket.id),
      required: MIN_MESSAGES_PER_SIDE,
    });
    return;
  }

  if (session.finalGuessEndsAt && Date.now() >= session.finalGuessEndsAt) {
    finalizeMissingGuesses(session.id);
    return;
  }

  if (session.mode === "human") {
    const player = session.players[socket.id];

    if (!player || player.submitted) {
      return;
    }

    player.guess = sanitizeSubmittedGuess(payload);
    player.result = scoreHumanGuess(session, socket.id, player.guess);
    markSubmitted(session, socket.id);
    socket.emit("guess:submitted", {
      sessionId: session.id,
      waitingForOpponent: !areHumanFinalGuessesDone(session),
    });
    emitHumanResultsIfReady(session);
    return;
  }

  if (session.submitted) {
    return;
  }

  session.guess = sanitizeSubmittedGuess(payload);
  session.result = scoreAiGuess(session, session.guess);
  session.submitted = true;
  socket.emit("session:result", session.result);
  deleteSession(session.id);
}

function handleRoundLock(socket, payload = {}) {
  const session = sessions.get(payload.sessionId);

  if (!isSocketInSession(session, socket.id) || session.ended || session.chatLocked) {
    return;
  }

  if (Date.now() >= session.chatEndsAt) {
    handleChatExpired(session.id);
    return;
  }

  if (!isGuessReady(session)) {
    socket.emit("guess:error", {
      code: "not_ready",
      message: `At least ${MIN_MESSAGES_PER_SIDE} messages from each side are required before guessing.`,
      counts: getPersonalMessageCounts(session, socket.id),
      required: MIN_MESSAGES_PER_SIDE,
    });
    return;
  }

  session.chatLocked = true;
  clearTurnTimer(session);
  session.turnOwner = null;
  session.turnEndsAt = null;
  session.timeout = null;
  startFinalGuessTimer(session);
  emitRoundLocked(session, socket.id);
}

function scoreHumanGuess(session, socketId, guess) {
  const player = session.players[socketId];
  const partnerSocketId = getHumanPartnerSocketId(session, socketId);
  const partner = partnerSocketId ? session.players[partnerSocketId] : null;

  if (!player || !partner) {
    return null;
  }

  return buildScoreResult({
    session,
    guess,
    actualParticipant: {
      kind: "Human",
      location: partner.location,
    },
  });
}

function scoreAiGuess(session, guess) {
  return buildScoreResult({
    session,
    guess,
    actualParticipant: session.participant,
  });
}

function buildScoreResult({ session, guess, actualParticipant }) {
  const actualType = actualParticipant.kind;
  const identityGuess = guess.identityGuess === "Human" || guess.identityGuess === "AI" ? guess.identityGuess : null;
  const correctIdentity = identityGuess === actualType;
  const readScore = correctIdentity ? 1 : 0;
  const roundType = actualType === "Human" ? "location" : "modelFamily";
  const roundPossible = actualType === "Human" ? 100 : 1;
  let distanceKm = null;
  let roundScore = 0;

  if (
    actualType === "Human" &&
    identityGuess === "Human" &&
    Number.isFinite(guess.locationGuess?.lat) &&
    Number.isFinite(guess.locationGuess?.lng) &&
    Number.isFinite(actualParticipant.location?.lat) &&
    Number.isFinite(actualParticipant.location?.lng)
  ) {
    distanceKm = haversineKm(
      guess.locationGuess.lat,
      guess.locationGuess.lng,
      actualParticipant.location.lat,
      actualParticipant.location.lng,
    );
    roundScore = Math.max(0, Math.round(100 * (1 - distanceKm / 10000)));
  }

  if (
    actualType === "AI" &&
    identityGuess === "AI" &&
    guess.modelFamilyGuess === session.participant.modelFamily
  ) {
    roundScore = 1;
  }

  return {
    sessionId: session.id,
    correctIdentity,
    score: {
      read: {
        earned: readScore,
        possible: 1,
      },
      round: {
        earned: roundScore,
        possible: roundPossible,
        type: roundType,
      },
    },
    distanceKm: distanceKm === null ? null : Math.round(distanceKm),
    guess: {
      identityGuess,
      locationGuess: guess.locationGuess,
      modelFamilyGuess: guess.modelFamilyGuess,
      submitted: Boolean(guess.submitted),
    },
    actual: revealParticipant(actualParticipant),
    explanation: buildExplanation(actualParticipant, correctIdentity, distanceKm),
  };
}

function revealParticipant(participant) {
  if (participant.kind === "Human") {
    const location = participant.location || {};

    return {
      participantType: "Human",
      region: location.region,
      country: location.country,
      lat: location.lat,
      lng: location.lng,
    };
  }

  return {
    participantType: "AI",
    modelFamily: participant.modelFamily,
  };
}

function buildExplanation(participant, correctIdentity, distanceKm) {
  if (participant.kind === "Human") {
    const location = participant.location || {};
    const place = [location.region, location.country].filter(Boolean).join(", ") || "the partner's rough location";
    const locationText =
      distanceKm === null
        ? "Your round score is 0/100 because no valid human-location comparison was available."
        : `Your location score is based on a pin ${Math.round(distanceKm)} km from ${place}.`;

    return `${correctIdentity ? "You called the identity correctly." : "The identity read was off."} ${locationText}`;
  }

  return `${correctIdentity ? "You spotted the AI." : "The identity read was off."} The AI round score is 1/1 only for the exact family: ${participant.modelFamily}.`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusKm * c;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function findSessionByPlayerId(playerId, preferredSessionId = "") {
  if (!playerId) {
    return null;
  }

  const preferredSession = preferredSessionId ? sessions.get(preferredSessionId) : null;

  if (isPlayerInSession(preferredSession, playerId)) {
    return preferredSession;
  }

  return [...sessions.values()].find((session) => isPlayerInSession(session, playerId) && !session.ended) || null;
}

function isPlayerInSession(session, playerId) {
  if (!session || session.ended) {
    return false;
  }

  if (session.mode === "human") {
    return Object.values(session.players).some((player) => player.playerId === playerId);
  }

  return session.playerId === playerId;
}

function resumeSession(socket, payload = {}) {
  const playerId = sanitizePlayerId(payload.playerId);
  const session = findSessionByPlayerId(playerId, payload.sessionId);

  if (!session) {
    socket.emit("session:resume_failed", {
      reason: "not_found",
    });
    return;
  }

  socket.data.playerId = playerId;
  removeQueuedPlayer(playerId);

  const socketId = reattachSessionSocket(session, playerId, socket);

  if (!socketId) {
    socket.emit("session:resume_failed", {
      reason: "not_found",
    });
    return;
  }

  socket.join(session.id);
  socketSessions.set(socket.id, session.id);
  socket.emit("session:resumed", buildSessionResumePayload(session, socket.id));

  if (session.chatLocked) {
    socket.emit("round:locked", {
      sessionId: session.id,
      guessEndsAt: session.finalGuessEndsAt,
      message: "The chat is locked. Make your final read.",
    });
  } else {
    emitTurnState(session);
  }
}

function reattachSessionSocket(session, playerId, socket) {
  if (session.mode === "human") {
    const oldSocketId = Object.keys(session.players).find((socketId) => session.players[socketId].playerId === playerId);

    if (!oldSocketId) {
      return null;
    }

    const player = session.players[oldSocketId];
    session.messages.forEach((message) => {
      if (message.author === oldSocketId) {
        message.author = socket.id;
      }
    });
    io.sockets.sockets.get(oldSocketId)?.leave(session.id);
    delete session.players[oldSocketId];
    socketSessions.delete(oldSocketId);
    session.players[socket.id] = {
      ...player,
      socketId: socket.id,
      disconnected: false,
    };

    if (session.turnOwner === oldSocketId) {
      session.turnOwner = socket.id;
    }

    if (session.timeout?.canActSocketId === oldSocketId) {
      session.timeout.canActSocketId = socket.id;
    }

    return socket.id;
  }

  if (session.playerId !== playerId) {
    return null;
  }

  const oldSocketId = session.playerSocketId;
  io.sockets.sockets.get(oldSocketId)?.leave(session.id);
  socketSessions.delete(oldSocketId);

  if (session.turnOwner === oldSocketId) {
    session.turnOwner = socket.id;
  }

  session.messages.forEach((message) => {
    if (message.author === oldSocketId) {
      message.author = socket.id;
    }
  });

  session.playerSocketId = socket.id;
  session.disconnected = false;
  return socket.id;
}

function buildSessionResumePayload(session, socketId) {
  const submitted = session.mode === "human"
    ? Boolean(session.players[socketId]?.submitted)
    : Boolean(session.submitted);

  return {
    sessionId: session.id,
    chatEndsAt: session.chatEndsAt,
    chatSeconds: CHAT_SECONDS,
    intro: "An anonymous participant has joined.",
    messages: serializeMessagesForSocket(session, socketId),
    chatLocked: session.chatLocked,
    finalGuessEndsAt: session.finalGuessEndsAt,
    submitted,
  };
}

function serializeMessagesForSocket(session, socketId) {
  return session.messages.map((message, index) => ({
    id: `${session.id}:${index}`,
    author: getClientMessageAuthor(session, socketId, message.author),
    text: message.text,
    sentAt: message.sentAt,
  }));
}

function getClientMessageAuthor(session, socketId, author) {
  if (author === "system") {
    return "system";
  }

  if (session.mode === "ai") {
    return author === "partner" ? "partner" : "player";
  }

  return author === socketId ? "player" : "partner";
}

function isSocketInSession(session, socketId) {
  if (!session) {
    return false;
  }

  if (session.mode === "human") {
    return Boolean(session.players[socketId]);
  }

  return session.playerSocketId === socketId;
}

function startTurn(session, owner) {
  if (!sessions.has(session.id) || session.ended) {
    return;
  }

  clearTurnTimer(session);
  session.timeout = null;
  session.turnOwner = owner;
  session.turnEndsAt = Date.now() + TURN_MS;
  emitTurnState(session);

  if (owner === "partner" && session.mode === "ai") {
    session.turnTimer = setTimeout(() => handleTurnTimeout(session.id, owner), TURN_MS);
    sendAiTurnMessage(session.id).catch((error) => {
      console.warn(`AI turn failed for session ${session.id}: ${error.message}`);
      markAiResponseStatus(session, {
        state: "failed",
        error: error.message,
      });
    });
    return;
  }

  session.turnTimer = setTimeout(() => handleTurnTimeout(session.id, owner), TURN_MS);
}

async function sendAiTurnMessage(sessionId) {
  const session = sessions.get(sessionId);

  if (!session || session.mode !== "ai" || session.ended || session.turnOwner !== "partner") {
    return;
  }

  const turnStartedAt = Date.now();
  markAiResponseStatus(session, {
    state: "generating",
    error: null,
    responseText: null,
  });

  let replyResult;

  try {
    replyResult = normalizeAiReplyResult(await session.participant.adapter.generateReply(session.messages, {
      sessionId: session.id,
    }));
  } catch (error) {
    markAiResponseStatus(session, {
      state: "failed",
      error: error.message,
    });
    return;
  }

  const currentSession = sessions.get(sessionId);

  if (!currentSession || currentSession !== session || session.ended || session.turnOwner !== "partner") {
    return;
  }

  if (!replyResult.text) {
    markAiResponseStatus(session, {
      state: "failed",
      error: "AI generated an empty response.",
    });
    return;
  }

  const targetTypingMs = getAiTypingDelay(replyResult.text);
  const elapsedMs = Date.now() - turnStartedAt;
  const remainingMs = Math.max(0, session.turnEndsAt - Date.now() - AI_SEND_DEADLINE_BUFFER_MS);
  const delayMs = Math.min(Math.max(0, targetTypingMs - elapsedMs), remainingMs);

  markAiResponseStatus(session, {
    state: "typing",
    responseText: replyResult.text,
    source: replyResult.source,
    failed: replyResult.failed,
    error: replyResult.error,
    model: replyResult.model,
    delayMs,
  });

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  if (!sessions.has(sessionId) || session.ended || session.chatLocked || session.turnOwner !== "partner") {
    return;
  }

  if (Date.now() >= session.turnEndsAt) {
    handleTurnTimeout(session.id, "partner");
    return;
  }

  const message = {
    id: cryptoRandomId(),
    author: "partner",
    text: replyResult.text,
    sentAt: Date.now(),
  };

  session.messages.push({
    author: "partner",
    text: replyResult.text,
    sentAt: message.sentAt,
    ai: {
      source: replyResult.source,
      failed: replyResult.failed,
      error: replyResult.error,
      model: replyResult.model,
      typingDelayMs: Math.round(delayMs),
      targetTypingMs: Math.round(targetTypingMs),
    },
  });

  markAiResponseStatus(session, {
    state: "sent",
    responseText: replyResult.text,
    source: replyResult.source,
    failed: replyResult.failed,
    error: replyResult.error,
    model: replyResult.model,
    delayMs,
  });

  io.to(session.playerSocketId).emit("partner:message", {
    sessionId: session.id,
    message,
  });
  startTurn(session, session.playerSocketId);
}

function getAiTypingDelay(reply) {
  const text = String(reply || "");
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const estimatedTypingMs = 850 + chars * 38 + words * 95;
  const randomMultiplier = 0.72 + Math.random() * 0.58;
  const randomJitterMs = randomInt(-220, 420);
  const minMs = TURN_MS * AI_TYPING_MIN_RATIO;
  const maxMs = TURN_MS * AI_TYPING_MAX_RATIO;

  return Math.round(clamp(estimatedTypingMs * randomMultiplier + randomJitterMs, minMs, maxMs));
}

function normalizeAiReplyResult(value) {
  if (typeof value === "string") {
    return {
      text: value,
      source: "unknown",
      failed: false,
      error: null,
      model: null,
    };
  }

  if (typeof value === "object" && value !== null) {
    return {
      text: String(value.text || ""),
      source: String(value.source || "unknown"),
      failed: Boolean(value.failed),
      error: value.error ? String(value.error).slice(0, 240) : null,
      model: value.model ? String(value.model).slice(0, 120) : null,
    };
  }

  return {
    text: "",
    source: "unknown",
    failed: true,
    error: "AI provider returned no response.",
    model: null,
  };
}

function createAiResponseStatus(state, overrides = {}) {
  return {
    state,
    responseText: null,
    source: null,
    failed: false,
    error: null,
    model: null,
    delayMs: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function markAiResponseStatus(session, updates) {
  if (session.mode !== "ai") {
    return;
  }

  session.aiResponseStatus = {
    ...createAiResponseStatus(session.aiResponseStatus?.state || "idle"),
    ...session.aiResponseStatus,
    ...updates,
    updatedAt: Date.now(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function handleTurnTimeout(sessionId, owner) {
  const session = sessions.get(sessionId);

  if (!session || session.ended || session.turnOwner !== owner) {
    return;
  }

  clearTurnTimer(session);

  if (!isGuessReady(session)) {
    session.ended = true;
    emitSessionEnded(session, "The round auto-aborted because the turn timer expired before enough messages were exchanged.");
    deleteSession(session.id);
    return;
  }

  session.chatLocked = true;
  session.turnOwner = null;
  session.turnEndsAt = null;
  session.timeout = null;
  startFinalGuessTimer(session);
  emitRoundLocked(session, null, "The turn timer expired, so the chat is locked. Make your final read.");
}

function scheduleChatEnd(session) {
  if (session.chatTimer) {
    clearTimeout(session.chatTimer);
  }

  session.chatTimer = setTimeout(() => handleChatExpired(session.id), Math.max(0, session.chatEndsAt - Date.now()));
}

function handleChatExpired(sessionId) {
  const session = sessions.get(sessionId);

  if (!session || session.ended || session.chatLocked) {
    return;
  }

  clearTurnTimer(session);

  if (!isGuessReady(session)) {
    session.ended = true;
    emitSessionEnded(session, "The round ended because time ran out before enough messages were exchanged.");
    deleteSession(session.id);
    return;
  }

  session.chatLocked = true;
  session.turnOwner = null;
  session.turnEndsAt = null;
  session.timeout = null;
  startFinalGuessTimer(session);
  emitRoundLocked(session, null, "Time ran out, so the chat is locked. Make your final read.");
}

function clearTurnTimer(session) {
  if (session.turnTimer) {
    clearTimeout(session.turnTimer);
    session.turnTimer = null;
  }
}

function emitTurnState(session, message = "") {
  if (session.mode === "human") {
    Object.keys(session.players).forEach((socketId) => {
      io.to(socketId).emit("turn:update", buildTurnPayload(session, socketId, message));
    });
    return;
  }

  io.to(session.playerSocketId).emit("turn:update", buildTurnPayload(session, session.playerSocketId, message));
}

function buildTurnPayload(session, socketId, message = "") {
  const currentTurn = session.turnOwner
    ? session.turnOwner === socketId
      ? "player"
      : "partner"
    : "paused";

  return {
    sessionId: session.id,
    currentTurn,
    turnEndsAt: session.turnEndsAt,
    canGuessEarly: false,
    canAbort: false,
    message,
    counts: getPersonalMessageCounts(session, socketId),
    required: MIN_MESSAGES_PER_SIDE,
  };
}

function getMessageCounts(session) {
  if (session.mode === "human") {
    const socketIds = Object.keys(session.players);

    return {
      player: session.messages.filter((message) => message.author === socketIds[0]).length,
      partner: session.messages.filter((message) => message.author === socketIds[1]).length,
    };
  }

  return {
    player: session.messages.filter((message) => message.author === session.playerSocketId).length,
    partner: session.messages.filter((message) => message.author === "partner").length,
  };
}

function getPersonalMessageCounts(session, socketId) {
  if (session.mode === "human") {
    const partnerSocketId = getHumanPartnerSocketId(session, socketId);

    return {
      player: session.messages.filter((message) => message.author === socketId).length,
      partner: session.messages.filter((message) => message.author === partnerSocketId).length,
    };
  }

  return getMessageCounts(session);
}

function isGuessReady(session) {
  const counts = getMessageCounts(session);

  return counts.player >= MIN_MESSAGES_PER_SIDE && counts.partner >= MIN_MESSAGES_PER_SIDE;
}

function startFinalGuessTimer(session) {
  if (session.finalGuessTimer) {
    clearTimeout(session.finalGuessTimer);
  }

  session.finalGuessEndsAt = Date.now() + FINAL_GUESS_MS;
  session.finalGuessTimer = setTimeout(() => finalizeMissingGuesses(session.id), FINAL_GUESS_MS);
}

function finalizeMissingGuesses(sessionId) {
  const session = sessions.get(sessionId);

  if (!session || session.ended || !session.chatLocked) {
    return;
  }

  if (session.mode === "human") {
    Object.keys(session.players).forEach((socketId) => {
      const player = session.players[socketId];

      if (!player.submitted) {
        player.guess = createNoGuess();
        player.result = scoreHumanGuess(session, socketId, player.guess);
        player.submitted = true;
      }
    });
    emitHumanResultsIfReady(session);
    return;
  }

  if (!session.submitted) {
    session.guess = createNoGuess();
    session.result = scoreAiGuess(session, session.guess);
    session.submitted = true;
    io.to(session.playerSocketId).emit("session:result", session.result);
    deleteSession(session.id);
  }
}

function emitHumanResultsIfReady(session) {
  if (!areHumanFinalGuessesDone(session)) {
    return;
  }

  clearFinalGuessTimer(session);

  Object.keys(session.players).forEach((socketId) => {
    const player = session.players[socketId];
    const partnerSocketId = getHumanPartnerSocketId(session, socketId);
    const partner = partnerSocketId ? session.players[partnerSocketId] : null;

    if (player.result) {
      io.to(socketId).emit("session:result", {
        ...player.result,
        opponentGuess: partner ? revealSubmittedGuess(partner.guess) : null,
      });
    }
  });

  deleteSession(session.id);
}

function areHumanFinalGuessesDone(session) {
  return Object.values(session.players).every((player) => player.submitted);
}

function clearFinalGuessTimer(session) {
  if (session.finalGuessTimer) {
    clearTimeout(session.finalGuessTimer);
    session.finalGuessTimer = null;
  }
}

function sanitizeSubmittedGuess(payload = {}) {
  const identityGuess = payload.identityGuess === "Human" || payload.identityGuess === "AI" ? payload.identityGuess : null;

  return {
    identityGuess,
    locationGuess: sanitizePin(payload.locationGuess),
    modelFamilyGuess: MODEL_FAMILIES.includes(payload.modelFamilyGuess) ? payload.modelFamilyGuess : null,
    submitted: Boolean(identityGuess),
  };
}

function createNoGuess() {
  return {
    identityGuess: null,
    locationGuess: null,
    modelFamilyGuess: null,
    submitted: false,
  };
}

function revealSubmittedGuess(guess) {
  if (!guess) {
    return null;
  }

  return {
    identityGuess: guess.identityGuess,
    locationGuess: guess.locationGuess,
    modelFamilyGuess: guess.modelFamilyGuess,
    submitted: guess.submitted,
  };
}

function notifySessionEnded(session, submitterSocketId, message = "Your partner locked a guess, so this round ended.") {
  if (session.mode === "human") {
    const partnerSocketId = getHumanPartnerSocketId(session, submitterSocketId);

    if (partnerSocketId) {
      io.to(partnerSocketId).emit("session:ended", {
        sessionId: session.id,
        message,
      });
    }
  }
}

function emitSessionEnded(session, message) {
  if (session.mode === "human") {
    Object.keys(session.players).forEach((socketId) => {
      io.to(socketId).emit("session:ended", {
        sessionId: session.id,
        message,
      });
    });
    return;
  }

  io.to(session.playerSocketId).emit("session:ended", {
    sessionId: session.id,
    message,
  });
}

function emitRoundLocked(session, lockerSocketId = null, fallbackMessage = "The chat is locked. Make your final read.") {
  if (session.mode === "human") {
    Object.keys(session.players).forEach((socketId) => {
      io.to(socketId).emit("round:locked", {
        sessionId: session.id,
        guessEndsAt: session.finalGuessEndsAt,
        message:
          lockerSocketId === socketId
            ? "You locked the chat. Make your final read."
            : lockerSocketId
              ? "Your partner locked the chat. Make your final read."
              : fallbackMessage,
      });
    });
    return;
  }

  io.to(session.playerSocketId).emit("round:locked", {
    sessionId: session.id,
    guessEndsAt: session.finalGuessEndsAt,
    message: fallbackMessage,
  });
}

function getHumanPartnerSocketId(session, socketId) {
  return Object.keys(session.players).find((candidateId) => candidateId !== socketId) || null;
}

function markSubmitted(session, socketId) {
  if (session.mode === "human") {
    session.players[socketId].submitted = true;
    return;
  }

  session.submitted = true;
}

function handleDisconnect(socket) {
  removeFromQueue(socket.id);

  const sessionId = socketSessions.get(socket.id);
  const session = sessionId ? sessions.get(sessionId) : null;

  if (!session) {
    socketSessions.delete(socket.id);
    return;
  }

  if (session.mode === "human") {
    const player = session.players[socket.id];

    if (player) {
      player.disconnected = true;
    }

    const partnerSocketId = getHumanPartnerSocketId(session, socket.id);

    if (partnerSocketId && session.players[partnerSocketId] && !session.players[partnerSocketId].disconnected) {
      socket.to(partnerSocketId).emit("partner:left", {
        sessionId: session.id,
        message: "Your partner disconnected. You can still make your guess.",
      });
    }
  } else {
    session.disconnected = true;
  }

  socketSessions.delete(socket.id);
  cleanupSessionIfDone(session);
}

function cleanupSessionIfDone(session) {
  if (!sessions.has(session.id)) {
    return;
  }

  if (session.mode === "human") {
    const players = Object.values(session.players);
    const done = players.every((player) => player.submitted);

    if (!done) {
      return;
    }
  } else if (!session.submitted) {
    return;
  }

  deleteSession(session.id);
}

function deleteSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    return;
  }

  if (session.expireTimer) {
    clearTimeout(session.expireTimer);
  }
  if (session.chatTimer) {
    clearTimeout(session.chatTimer);
  }
  clearTurnTimer(session);
  clearFinalGuessTimer(session);

  if (session.mode === "human") {
    Object.keys(session.players).forEach((socketId) => socketSessions.delete(socketId));
  } else {
    socketSessions.delete(session.playerSocketId);
  }

  sessions.delete(sessionId);
}

function scheduleSessionExpiry(session) {
  const ttlMs = CHAT_SECONDS * 1000 + GUESS_GRACE_SECONDS * 1000;

  session.expireTimer = setTimeout(() => {
    deleteSession(session.id);
  }, ttlMs);
}

function sanitizeLocation(value = {}) {
  const location = typeof value === "object" && value !== null ? value : {};

  return {
    country: sanitizeText(location.country, "Unknown"),
    region: sanitizeText(location.region, ""),
    city: sanitizeText(location.city, ""),
    lat: toFiniteRangeNumber(location.lat, -90, 90),
    lng: toFiniteRangeNumber(location.lng, -180, 180),
    source: "ip",
  };
}

function sanitizePlayerId(value) {
  if (typeof value !== "string") {
    return cryptoRandomId();
  }

  const trimmed = value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);

  return trimmed || cryptoRandomId();
}

function hasValidLocation(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

function sanitizePin(value = {}) {
  const pin = typeof value === "object" && value !== null ? value : {};
  const lat = toFiniteRangeNumber(pin.lat, -90, 90);
  const lng = toFiniteRangeNumber(pin.lng, -180, 180);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    lat,
    lng,
  };
}

function sanitizeText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().slice(0, 80);

  return trimmed || fallback;
}

function toFiniteRangeNumber(value, min, max) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < min || number > max) {
    return null;
  }

  return number;
}

function requireAdminAuth(req, res, next) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : "";
  const expiresAt = token ? adminTokens.get(token) : null;

  if (!expiresAt || expiresAt <= Date.now()) {
    if (token) {
      adminTokens.delete(token);
    }

    res.status(401).json({
      error: "Admin login required.",
    });
    return;
  }

  next();
}

function isValidAdminPassword(value) {
  if (!adminPasswordHash || typeof value !== "string") {
    return false;
  }

  return crypto.timingSafeEqual(sha256(value), adminPasswordHash);
}

function purgeExpiredAdminTokens() {
  const now = Date.now();

  for (const [token, expiresAt] of adminTokens.entries()) {
    if (expiresAt <= now) {
      adminTokens.delete(token);
    }
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function buildAdminSnapshot() {
  purgeExpiredAdminTokens();

  return {
    generatedAt: Date.now(),
    waiting: [...waitingQueue.values()].map((entry) => ({
      socketId: entry.socket.id,
      connected: entry.socket.connected,
      queuedAt: entry.queuedAt,
      location: entry.location,
    })),
    rooms: [...sessions.values()].map(describeAdminRoom),
  };
}

function describeAdminRoom(session) {
  const participants = session.mode === "human"
    ? Object.values(session.players).map((player, index) => ({
        label: `Player ${index + 1}`,
        socketId: player.socketId,
        type: "Human",
        location: player.location,
        submitted: player.submitted,
        disconnected: player.disconnected,
      }))
    : [
        {
          label: "Player",
          socketId: session.playerSocketId,
          type: "Human",
          location: session.playerLocation,
          submitted: session.submitted,
          disconnected: session.disconnected,
        },
        {
          label: "AI",
          socketId: null,
          type: "AI",
          modelFamily: session.participant.modelFamily,
          submitted: false,
          disconnected: false,
        },
      ];

  return {
    id: session.id,
    mode: session.mode,
    createdAt: session.createdAt,
    chatEndsAt: session.chatEndsAt,
    aiResponseStatus: session.mode === "ai" ? session.aiResponseStatus : null,
    participants,
    messages: session.messages.map((message, index) => ({
      id: `${session.id}:${index}`,
      author: message.author,
      authorLabel: getAdminAuthorLabel(session, message.author),
      text: message.text,
      sentAt: message.sentAt,
      ai: message.ai || null,
    })),
  };
}

function getAdminAuthorLabel(session, author) {
  if (session.mode === "ai") {
    return author === "partner" ? "AI" : "Player";
  }

  const socketIds = Object.keys(session.players);
  const index = socketIds.indexOf(author);

  return index === -1 ? "Unknown" : `Player ${index + 1}`;
}

io.on("connection", (socket) => {
  socket.emit("connected", {
    socketId: socket.id,
  });

  socket.on("queue:join", (payload = {}) => addToQueue(socket, payload));
  socket.on("queue:test_ai", (payload = {}) => createRequestedAiSession(socket, payload));
  socket.on("queue:leave", () => removeFromQueue(socket.id));
  socket.on("session:resume", (payload = {}) => resumeSession(socket, payload));
  socket.on("chat:message", (payload = {}) => handleChatMessage(socket, payload));
  socket.on("round:lock", (payload = {}) => handleRoundLock(socket, payload));
  socket.on("guess:submit", (payload = {}) => handleGuessSubmit(socket, payload));
  socket.on("disconnect", () => handleDisconnect(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GeoTuring backend listening on 0.0.0.0:${PORT}`);
});
