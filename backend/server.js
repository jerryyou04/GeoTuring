require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");
const { MODEL_FAMILIES, createMockAiProvider } = require("./aiAdapters");

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

  if (waitingQueue.has(socket.id)) {
    emitQueueStatus(waitingQueue.get(socket.id));
    return;
  }

  const entry = {
    socket,
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
      createAiSession(socket, entry.location);
    }, AI_FALLBACK_SECONDS * 1000);
  }
}

function pairWaitingPlayers() {
  const connectedEntries = [...waitingQueue.values()].filter((entry) => entry.socket.connected);

  while (connectedEntries.length >= 2) {
    const first = connectedEntries.shift();
    const second = connectedEntries.shift();

    if (!first || !second || first.socket.id === second.socket.id) {
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
    expireTimer: null,
  };

  sessions.set(session.id, session);
  socketSessions.set(first.socket.id, session.id);
  socketSessions.set(second.socket.id, session.id);
  first.socket.join(session.id);
  second.socket.join(session.id);
  emitMatchFound([first, second]);
  scheduleSessionExpiry(session);

  [first.socket, second.socket].forEach((socket) => {
    socket.emit("session:created", {
      sessionId: session.id,
      chatEndsAt: session.chatEndsAt,
      chatSeconds: CHAT_SECONDS,
      intro: "An anonymous participant has joined.",
    });
  });

  return session;
}

function createAiSession(socket, playerLocation) {
  const modelFamily = pick(MODEL_FAMILIES);
  const chatEndsAt = Date.now() + CHAT_SECONDS * 1000;
  const session = {
    id: cryptoRandomId(),
    mode: "ai",
    playerSocketId: socket.id,
    playerLocation,
    participant: {
      kind: "AI",
      modelFamily,
      adapter: createMockAiProvider(modelFamily),
    },
    messages: [],
    createdAt: Date.now(),
    chatEndsAt,
    submitted: false,
    disconnected: false,
    expireTimer: null,
  };

  sessions.set(session.id, session);
  socketSessions.set(socket.id, session.id);
  socket.join(session.id);
  scheduleSessionExpiry(session);

  socket.emit("queue:status", {
    connectedProfiles: 2,
    requiredProfiles: 2,
    status: "found",
    queuedAt: Date.now(),
    estimatedSeconds: QUEUE_ESTIMATED_SECONDS,
  });

  socket.emit("session:created", {
    sessionId: session.id,
    chatEndsAt: session.chatEndsAt,
    chatSeconds: CHAT_SECONDS,
    intro: "No person joined in time, so you are chatting with an anonymous AI participant.",
  });

  setTimeout(() => {
    if (!sessions.has(session.id)) {
      return;
    }

    socket.emit("partner:message", {
      sessionId: session.id,
      message: {
        id: cryptoRandomId(),
        author: "partner",
        text: "hey, what should we talk about?",
        sentAt: Date.now(),
      },
    });
  }, 650);

  return session;
}

function createHumanSessionPlayer(entry) {
  return {
    socketId: entry.socket.id,
    location: entry.location,
    submitted: false,
    disconnected: false,
  };
}

function handleChatMessage(socket, payload = {}) {
  const session = sessions.get(payload.sessionId);

  if (!isSocketInSession(session, socket.id)) {
    return;
  }

  const text = String(payload.text || "").trim().slice(0, 400);

  if (!text) {
    return;
  }

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
    return;
  }

  setTimeout(() => {
    const activeSession = sessions.get(payload.sessionId);

    if (!activeSession || activeSession.mode !== "ai" || activeSession.playerSocketId !== socket.id) {
      return;
    }

    const reply = activeSession.participant.adapter.generateReply(activeSession.messages);
    const message = {
      id: cryptoRandomId(),
      author: "partner",
      text: reply,
      sentAt: Date.now(),
    };

    activeSession.messages.push({
      author: "partner",
      text: reply,
      sentAt: message.sentAt,
    });
    socket.emit("partner:message", {
      sessionId: activeSession.id,
      message,
    });
  }, 450 + Math.random() * 700);
}

function handleGuessSubmit(socket, payload = {}) {
  const session = sessions.get(payload.sessionId);

  if (!isSocketInSession(session, socket.id)) {
    return;
  }

  const result = session.mode === "human"
    ? scoreHumanGuess(session, socket.id, payload)
    : scoreAiGuess(session, payload);

  if (!result) {
    return;
  }

  socket.emit("session:result", result);
  markSubmitted(session, socket.id);
  cleanupSessionIfDone(session);
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
  const identityGuess = guess.identityGuess === "Human" ? "Human" : "AI";
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
      locationGuess: sanitizePin(guess.locationGuess),
      modelFamilyGuess: MODEL_FAMILIES.includes(guess.modelFamilyGuess) ? guess.modelFamilyGuess : null,
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

function isSocketInSession(session, socketId) {
  if (!session) {
    return false;
  }

  if (session.mode === "human") {
    return Boolean(session.players[socketId]);
  }

  return session.playerSocketId === socketId;
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
    const done = players.every((player) => player.submitted || player.disconnected);

    if (!done) {
      return;
    }
  } else if (!session.submitted && !session.disconnected) {
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
    participants,
    messages: session.messages.map((message, index) => ({
      id: `${session.id}:${index}`,
      author: message.author,
      authorLabel: getAdminAuthorLabel(session, message.author),
      text: message.text,
      sentAt: message.sentAt,
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
  socket.on("queue:leave", () => removeFromQueue(socket.id));
  socket.on("chat:message", (payload = {}) => handleChatMessage(socket, payload));
  socket.on("guess:submit", (payload = {}) => handleGuessSubmit(socket, payload));
  socket.on("disconnect", () => handleDisconnect(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GeoTuring backend listening on 0.0.0.0:${PORT}`);
});
