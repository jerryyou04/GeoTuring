require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const { MODEL_FAMILIES, createAiProvider } = require("./aiAdapters");
const {
  AI_SEND_DEADLINE_BUFFER_MS,
  AI_LOCK_DELAY_MIN_MS,
  AI_LOCK_DELAY_MAX_MS,
  AI_OPPONENT_GUESS_ENABLED,
  CHAT_SECONDS,
  FINAL_GUESS_MS,
  FRONTEND_URL,
  GUESS_GRACE_SECONDS,
  MIN_MESSAGES_PER_SIDE,
  PORT,
  QUEUE_ESTIMATED_SECONDS,
  TURN_MS,
} = require("./config");
const {
  clamp,
  cryptoRandomId,
  haversineKm,
  pick,
  sleep,
} = require("./utils");
const {
  createNoGuess,
  revealSubmittedGuess,
  sanitizePlayerId,
  sanitizeSubmittedGuess,
} = require("./sanitizers");
const {
  scoreAiGuess,
  scoreHumanGuess,
} = require("./scoring");
const {
  areHumanFinalGuessesDone,
  buildSessionResumePayload,
  getHumanPartnerSocketId,
  getPersonalMessageCounts,
  isGuessReady,
  isSocketInSession,
  markSubmitted,
  serializeMessagesForSocket,
} = require("./sessionHelpers");
const { registerAdminRoutes } = require("./admin");
const { createQueueService } = require("./queue");
const db = require("./db");
const {
  createAiResponseStatus,
  decideAiLock,
  getAiSendDelay,
  isMessageHostile,
  markAiResponseStatus,
  normalizeAiReplyResult,
} = require("./aiRuntime");

const app = express();
const server = http.createServer(app);

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

app.get("/api/history", async (req, res) => {
  const playerId = sanitizePlayerId(req.query.playerId);

  if (!playerId) {
    res.status(400).json({ error: "playerId_required" });
    return;
  }

  try {
    const games = await db.getPlayerHistory(playerId, 100);
    res.json({ enabled: db.isDbEnabled(), games });
  } catch (error) {
    console.error("History query failed:", error.message);
    res.status(500).json({ error: "history_unavailable" });
  }
});

function persistResultHistory(playerId, result, transcript = [], opponent = null) {
  if (!playerId || !result || !db.isDbEnabled()) {
    return;
  }

  db
    .saveGameHistory({
      playerId,
      sessionId: result.sessionId,
      opponentType: result.actual?.participantType || "Unknown",
      identityGuess: result.guess?.identityGuess || null,
      correctIdentity: Boolean(result.correctIdentity),
      readEarned: result.score?.read?.earned ?? 0,
      readPossible: result.score?.read?.possible ?? 0,
      roundType: result.score?.round?.type || "location",
      roundEarned: result.score?.round?.earned ?? 0,
      roundPossible: result.score?.round?.possible ?? 0,
      distanceKm: result.distanceKm ?? null,
      modelFamily: result.actual?.modelFamily || null,
      modelFamilyGuess: result.guess?.modelFamilyGuess || null,
      actualRegion: result.actual?.region || null,
      actualCountry: result.actual?.country || null,
      opponentIdentityGuess: opponent?.identityGuess ?? null,
      opponentCorrectIdentity: opponent?.correctIdentity ?? null,
      opponentDistanceKm: opponent?.distanceKm ?? null,
      opponentModelFamilyGuess: opponent?.modelFamilyGuess ?? null,
      opponentExplanation: opponent?.explanation ?? null,
      transcript,
    })
    .catch((error) => console.error("Failed to save game history:", error.message));
}

// The stored transcript is the chat from this player's own perspective
// ("player" / "partner"), so their history and the admin view read naturally.
function buildStoredTranscript(session, socketId) {
  return serializeMessagesForSocket(session, socketId);
}

// How the human opponent read THIS player: their identity call, whether it was
// right (this player is human), and either how far their location pin landed or
// which model they mistook the player for. Null unless both sides have guessed.
function buildOpponentGuessRecord(session, socketId) {
  if (session.mode !== "human") {
    return null;
  }

  const partnerSocketId = getHumanPartnerSocketId(session, socketId);
  const partner = partnerSocketId ? session.players[partnerSocketId] : null;
  const me = session.players[socketId];

  if (!partner || !partner.submitted || !partner.guess || !me) {
    return null;
  }

  const guess = partner.guess;
  const identityGuess = guess.identityGuess === "Human" || guess.identityGuess === "AI" ? guess.identityGuess : null;
  const correctIdentity = identityGuess === "Human";
  let distanceKm = null;

  if (
    identityGuess === "Human" &&
    Number.isFinite(guess.locationGuess?.lat) &&
    Number.isFinite(guess.locationGuess?.lng) &&
    Number.isFinite(me.location?.lat) &&
    Number.isFinite(me.location?.lng)
  ) {
    distanceKm = Math.round(
      haversineKm(guess.locationGuess.lat, guess.locationGuess.lng, me.location.lat, me.location.lng),
    );
  }

  return {
    identityGuess,
    correctIdentity,
    distanceKm,
    modelFamilyGuess: identityGuess === "AI" ? guess.modelFamilyGuess || null : null,
  };
}

// Persist both human players' rows once when the game is fully settled, so each
// row can carry the other side's guess. Guarded against double-writes.
function persistHumanGameHistory(session) {
  if (session.mode !== "human" || session.historyPersisted) {
    return;
  }

  session.historyPersisted = true;

  Object.keys(session.players).forEach((socketId) => {
    const player = session.players[socketId];

    if (!player.result) {
      return;
    }

    persistResultHistory(
      player.playerId,
      player.result,
      buildStoredTranscript(session, socketId),
      buildOpponentGuessRecord(session, socketId),
    );
  });
}

// Fire off the AI's own end-of-game read of the human (in parallel with the
// human's guessing window). Resolves to a sanitized guess+explanation, or a
// { failed } marker — never throws.
function startAiOpponentGuess(session) {
  if (!AI_OPPONENT_GUESS_ENABLED || session.aiGuessStarted || session.mode !== "ai") {
    return;
  }

  session.aiGuessStarted = true;

  const adapter = session.participant?.adapter;

  if (!adapter || typeof adapter.generateGuess !== "function") {
    session.aiGuess = { failed: true };
    return;
  }

  session.aiGuessPromise = (async () => {
    try {
      const raw = await adapter.generateGuess(session.messages, { sessionId: session.id });
      session.aiGuess = interpretAiGuess(raw);
    } catch (error) {
      console.warn(`AI opponent guess failed for session ${session.id}: ${error.message}`);
      session.aiGuess = { failed: true };
    }

    return session.aiGuess;
  })();
}

// Turn the provider's raw fields into a sanitized guess (reusing the human
// guess sanitizer) plus a trimmed explanation. Invalid/failed -> { failed }.
function interpretAiGuess(raw) {
  if (!raw || raw.failed) {
    return { failed: true };
  }

  const verdict = String(raw.verdict || "").toLowerCase();
  const identityGuess = verdict === "human" ? "Human" : verdict === "ai" ? "AI" : null;

  if (!identityGuess) {
    return { failed: true };
  }

  const guess = sanitizeSubmittedGuess({
    identityGuess,
    locationGuess: { lat: raw.latitude, lng: raw.longitude },
    modelFamilyGuess: raw.modelFamily,
  });
  const explanation = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 240) : "";

  return { failed: false, guess, explanation };
}

// The AI's read of the human, in the same record shape persistResultHistory
// expects for a human opponent (plus an explanation). Null when no valid guess.
function buildAiOpponentRecord(session) {
  const resolved = session.aiGuess && !session.aiGuess.failed ? session.aiGuess : null;

  if (!resolved) {
    return null;
  }

  const guess = resolved.guess;
  const identityGuess = guess.identityGuess === "Human" || guess.identityGuess === "AI" ? guess.identityGuess : null;

  if (!identityGuess) {
    return null;
  }

  const location = session.playerLocation;
  let distanceKm = null;

  if (
    identityGuess === "Human" &&
    Number.isFinite(guess.locationGuess?.lat) &&
    Number.isFinite(guess.locationGuess?.lng) &&
    Number.isFinite(location?.lat) &&
    Number.isFinite(location?.lng)
  ) {
    distanceKm = Math.round(
      haversineKm(guess.locationGuess.lat, guess.locationGuess.lng, location.lat, location.lng),
    );
  }

  return {
    identityGuess,
    correctIdentity: identityGuess === "Human", // the player really is human
    distanceKm,
    modelFamilyGuess: identityGuess === "AI" ? guess.modelFamilyGuess || null : null,
    explanation: resolved.explanation || null,
  };
}

// Emit the human's result for an AI game, attaching the AI's read of them. If the
// AI's guess is still in flight, send it as pending and fill it in via a late
// opponent:guess event — mirroring the human-vs-human flow. Persists + deletes once.
function finalizeAiSession(session) {
  if (session.aiFinalized) {
    return;
  }

  if (!session.aiGuessStarted) {
    // Feature disabled / no guess kicked off — plain result, no opponent section.
    io.to(session.playerSocketId).emit("session:result", session.result);
    completeAiSession(session);
    return;
  }

  const pending = session.aiGuess === null; // still in flight
  const resolved = session.aiGuess && !session.aiGuess.failed ? session.aiGuess : null;

  io.to(session.playerSocketId).emit("session:result", {
    ...session.result,
    opponentActual: revealHumanLocation(session.playerLocation || {}),
    opponentGuessEndsAt: session.finalGuessEndsAt || null,
    opponentGuess: resolved ? revealSubmittedGuess(resolved.guess) : null,
    opponentExplanation: resolved ? resolved.explanation : null,
    opponentPending: pending,
  });

  if (!pending || !session.aiGuessPromise) {
    completeAiSession(session);
    return;
  }

  // Guess still running: keep the session alive and fill it in when it lands.
  session.aiGuessPromise
    .catch(() => {})
    .then(() => {
      emitAiGuessFill(session);
      completeAiSession(session);
    });
}

function emitAiGuessFill(session) {
  const resolved = session.aiGuess && !session.aiGuess.failed ? session.aiGuess : null;

  io.to(session.playerSocketId).emit("opponent:guess", {
    sessionId: session.id,
    opponentGuess: resolved ? revealSubmittedGuess(resolved.guess) : null,
    opponentExplanation: resolved ? resolved.explanation : null,
  });
}

function completeAiSession(session) {
  if (session.aiFinalized) {
    return;
  }

  session.aiFinalized = true;
  persistResultHistory(
    session.playerId,
    session.result,
    buildStoredTranscript(session, session.playerSocketId),
    buildAiOpponentRecord(session),
  );
  deleteSession(session.id);
}

const sessions = new Map();
const waitingQueue = new Map();
const socketSessions = new Map();
const queueService = createQueueService({
  waitingQueue,
  socketSessions,
  createAiSession,
  createHumanSession,
  findSessionByPlayerId,
  resumeSession,
});
registerAdminRoutes(app, { sessions, waitingQueue, db });

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
    historyPersisted: false,
    timeout: null,
    expireTimer: null,
  };

  sessions.set(session.id, session);
  socketSessions.set(first.socket.id, session.id);
  socketSessions.set(second.socket.id, session.id);
  first.socket.join(session.id);
  second.socket.join(session.id);
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
    aiResponseStatus: createAiResponseStatus("idle"),
    aiLockPending: false,
    aiLockTimer: null,
    aiLockEligibleTurns: 0,
    aiGuessStarted: false,
    aiGuess: null,
    aiGuessPromise: null,
    aiFinalized: false,
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

  // The AI already committed to locking after its last message. Keep this human
  // message in the log, but don't start another AI turn — the pending lock will
  // close the chat. This is the "send a message then guess before they reply"
  // case from the AI's side (#4).
  if (session.aiLockPending) {
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

    const partnerSocketId = getHumanPartnerSocketId(session, socket.id);
    const partner = partnerSocketId ? session.players[partnerSocketId] : null;
    const partnerAlreadyDone = Boolean(partner && partner.submitted);

    // Hand this player their own result right away. The opponent's guess stays
    // pending (with a countdown) until they answer.
    emitHumanPlayerResult(session, socket.id);

    // If the opponent already finished, fill their guess into the result they
    // received earlier.
    if (partnerSocketId && partnerAlreadyDone) {
      emitOpponentGuessFill(session, partnerSocketId);
    }

    if (areHumanFinalGuessesDone(session)) {
      clearFinalGuessTimer(session);
      persistHumanGameHistory(session);
      deleteSession(session.id);
    }

    return;
  }

  if (session.submitted) {
    return;
  }

  session.guess = sanitizeSubmittedGuess(payload);
  session.result = scoreAiGuess(session, session.guess);
  session.submitted = true;
  finalizeAiSession(session);
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

  lockChat(session, { by: socket.id });
}

// Single transition for ending the chat and opening the final-guess window,
// shared by the human guess button, the timeout paths, and the AI's own lock.
function lockChat(session, { by = null, message } = {}) {
  session.chatLocked = true;
  clearTurnTimer(session);
  clearAiLockTimer(session);
  session.aiLockPending = false;
  session.turnOwner = null;
  session.turnEndsAt = null;
  session.timeout = null;
  startFinalGuessTimer(session);
  emitRoundLocked(session, by, message);

  // The AI now makes its own read of the human, in parallel with the human's
  // guessing window, so it's usually ready by the time they submit.
  if (session.mode === "ai") {
    startAiOpponentGuess(session);
  }
}

function clearAiLockTimer(session) {
  if (session.aiLockTimer) {
    clearTimeout(session.aiLockTimer);
    session.aiLockTimer = null;
  }
}

// Commit the AI to ending the chat after a varied delay. Once a lock is pending
// no new AI turn is started (see handleChatMessage), so a fast human reply during
// the window can't spawn a second, half-finished AI response.
function scheduleAiLock(session, plan) {
  if (session.aiLockPending || session.chatLocked || session.ended) {
    return;
  }

  session.aiLockPending = true;
  const delay = clamp(plan.delayMs || 0, AI_LOCK_DELAY_MIN_MS, AI_LOCK_DELAY_MAX_MS);
  session.aiLockTimer = setTimeout(() => fireAiLock(session.id), delay);
}

function fireAiLock(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    return;
  }

  session.aiLockTimer = null;
  session.aiLockPending = false;

  if (session.ended || session.chatLocked) {
    return;
  }

  if (Date.now() >= session.chatEndsAt) {
    handleChatExpired(sessionId);
    return;
  }

  // Safety net: never lock a round that isn't guess-ready, so the AI can never
  // trip the early-abort path.
  if (!isGuessReady(session)) {
    return;
  }

  lockChat(session, { message: "Your partner locked the chat. Make your final read." });
}

function lastHumanMessageHostile(session) {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];

    if (message.author === session.playerSocketId) {
      return isMessageHostile(message.text);
    }
  }

  return false;
}

function emitAiPartnerMessage(session, text) {
  const sentAt = Date.now();

  session.messages.push({
    author: "partner",
    text,
    sentAt,
    ai: {
      source: "local",
      failed: false,
      error: null,
      model: "lock-signoff",
    },
  });

  io.to(session.playerSocketId).emit("partner:message", {
    sessionId: session.id,
    message: {
      id: cryptoRandomId(),
      author: "partner",
      text,
      sentAt,
    },
  });
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
  queueService.removeQueuedPlayer(playerId);

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

  // If this player already locked in their guess, re-send their result so they
  // land back on the reveal (opponent still pending if they have not answered).
  if (session.mode === "human") {
    const resumedPlayer = session.players[socket.id];

    if (resumedPlayer && resumedPlayer.submitted && resumedPlayer.result) {
      emitHumanPlayerResult(session, socket.id);
    }
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

  // Decide once per turn whether the AI ends the chat early, and how. Evaluated
  // only when the round is already guess-ready, so the AI can never trip the
  // early-abort path (#1).
  let lockPlan = { lock: false };

  if (isGuessReady(session) && Date.now() < session.chatEndsAt - AI_SEND_DEADLINE_BUFFER_MS) {
    session.aiLockEligibleTurns += 1;
    lockPlan = decideAiLock({
      turnsSinceEligible: session.aiLockEligibleTurns,
      hostile: lastHumanMessageHostile(session),
      msLeftInChat: session.chatEndsAt - Date.now(),
    });
  }

  // Bored / done talking: skip the reply, maybe drop a short sign-off, then lock (#3).
  if (lockPlan.lock && lockPlan.mode === "instead-of-reply") {
    if (lockPlan.parting) {
      emitAiPartnerMessage(session, lockPlan.parting);
    }
    scheduleAiLock(session, lockPlan);
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

  const { delayMs, targetTypingMs } = getAiSendDelay({
    replyText: replyResult.text,
    turnStartedAt,
    turnEndsAt: session.turnEndsAt,
  });

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

  // Had enough info, or a parting shot before a drive-by lock: send this message,
  // then commit to ending the chat after a varied beat (#2, #4).
  if (lockPlan.lock && lockPlan.mode === "after-reply") {
    scheduleAiLock(session, lockPlan);
  }
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

  lockChat(session, { message: "The turn timer expired, so the chat is locked. Make your final read." });
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

  lockChat(session, { message: "Time ran out, so the chat is locked. Make your final read." });
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
    const socketIds = Object.keys(session.players);
    const alreadyDone = socketIds.filter((socketId) => session.players[socketId].submitted);

    socketIds.forEach((socketId) => {
      const player = session.players[socketId];

      if (!player.submitted) {
        player.guess = createNoGuess();
        player.result = scoreHumanGuess(session, socketId, player.guess);
        player.submitted = true;
        // First result for the player who ran out of time.
        emitHumanPlayerResult(session, socketId);
      }
    });

    // Anyone who already had their result now learns the opponent's missing guess.
    alreadyDone.forEach((socketId) => emitOpponentGuessFill(session, socketId));

    clearFinalGuessTimer(session);
    persistHumanGameHistory(session);
    deleteSession(session.id);
    return;
  }

  if (!session.submitted) {
    session.guess = createNoGuess();
    session.result = scoreAiGuess(session, session.guess);
    session.submitted = true;
    finalizeAiSession(session);
  }
}

function emitHumanPlayerResult(session, socketId) {
  const player = session.players[socketId];

  if (!player || !player.result) {
    return;
  }

  const partnerSocketId = getHumanPartnerSocketId(session, socketId);
  const partner = partnerSocketId ? session.players[partnerSocketId] : null;
  const opponentReady = Boolean(partner && partner.submitted);

  io.to(socketId).emit("session:result", {
    ...player.result,
    opponentGuess: opponentReady ? revealSubmittedGuess(partner.guess) : null,
    opponentActual: revealHumanLocation(player.location),
    opponentPending: !opponentReady,
    opponentGuessEndsAt: session.finalGuessEndsAt || null,
  });
}

function emitOpponentGuessFill(session, socketId) {
  const partnerSocketId = getHumanPartnerSocketId(session, socketId);
  const partner = partnerSocketId ? session.players[partnerSocketId] : null;

  if (!partner) {
    return;
  }

  io.to(socketId).emit("opponent:guess", {
    sessionId: session.id,
    opponentGuess: revealSubmittedGuess(partner.guess),
  });
}

function revealHumanLocation(location = {}) {
  return {
    participantType: "Human",
    region: location.region,
    country: location.country,
    lat: location.lat,
    lng: location.lng,
  };
}

function clearFinalGuessTimer(session) {
  if (session.finalGuessTimer) {
    clearTimeout(session.finalGuessTimer);
    session.finalGuessTimer = null;
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

function handleDisconnect(socket) {
  queueService.removeFromQueue(socket.id);

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
  clearAiLockTimer(session);

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

io.on("connection", (socket) => {
  socket.emit("connected", {
    socketId: socket.id,
  });

  socket.on("queue:join", (payload = {}) => queueService.addToQueue(socket, payload));
  socket.on("queue:test_ai", (payload = {}) => queueService.createRequestedAiSession(socket, payload));
  socket.on("queue:leave", () => queueService.removeFromQueue(socket.id));
  socket.on("session:resume", (payload = {}) => resumeSession(socket, payload));
  socket.on("chat:message", (payload = {}) => handleChatMessage(socket, payload));
  socket.on("round:lock", (payload = {}) => handleRoundLock(socket, payload));
  socket.on("guess:submit", (payload = {}) => handleGuessSubmit(socket, payload));
  socket.on("disconnect", () => handleDisconnect(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GeoTuring backend listening on 0.0.0.0:${PORT}`);
  db.initDb().catch((error) => console.error("Database init failed:", error.message));
});
