const crypto = require("crypto");
const {
  ADMIN_API_PATH,
  ADMIN_PASSWORD,
  ADMIN_TOKEN_TTL_MS,
} = require("./config");
const { sha256 } = require("./utils");

function registerAdminRoutes(app, { sessions, waitingQueue, db }) {
  const adminTokens = new Map();
  const adminPasswordHash = ADMIN_PASSWORD ? sha256(ADMIN_PASSWORD) : null;

  app.post(`${ADMIN_API_PATH}/login`, (req, res) => {
    if (!adminPasswordHash) {
      res.status(503).json({
        error: "Admin password is not configured.",
      });
      return;
    }

    if (!isValidAdminPassword(req.body?.password, adminPasswordHash)) {
      res.status(401).json({
        error: "Invalid admin login.",
      });
      return;
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
    adminTokens.set(token, expiresAt);
    purgeExpiredAdminTokens(adminTokens);

    res.json({
      token,
      expiresAt,
    });
  });

  app.get(`${ADMIN_API_PATH}/rooms`, requireAdminAuth(adminTokens), (req, res) => {
    purgeExpiredAdminTokens(adminTokens);
    res.json(buildAdminSnapshot({ sessions, waitingQueue }));
  });

  // Paginated history of every finished game across every player, newest first,
  // with an optional partial player-id filter. Each row carries its transcript.
  app.get(`${ADMIN_API_PATH}/history`, requireAdminAuth(adminTokens), async (req, res) => {
    purgeExpiredAdminTokens(adminTokens);

    if (!db || !db.isDbEnabled()) {
      res.json({ enabled: false, total: 0, page: 1, pageSize: 0, games: [] });
      return;
    }

    const pageSize = clampInt(req.query.pageSize, 25, 1, 100);
    const page = clampInt(req.query.page, 1, 1, 100000);
    const playerId = String(req.query.playerId || "").trim().slice(0, 64);

    try {
      const { total, games } = await db.getAllHistory({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        playerId,
      });

      res.json({ enabled: true, total, page, pageSize, games });
    } catch (error) {
      console.error("Admin history query failed:", error.message);
      res.status(500).json({ error: "history_unavailable" });
    }
  });
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function requireAdminAuth(adminTokens) {
  return (req, res, next) => {
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
  };
}

function isValidAdminPassword(value, adminPasswordHash) {
  if (!adminPasswordHash || typeof value !== "string") {
    return false;
  }

  const candidate = sha256(value);

  return candidate.length === adminPasswordHash.length && crypto.timingSafeEqual(candidate, adminPasswordHash);
}

function purgeExpiredAdminTokens(adminTokens) {
  const now = Date.now();

  for (const [token, expiresAt] of adminTokens.entries()) {
    if (expiresAt <= now) {
      adminTokens.delete(token);
    }
  }
}

function buildAdminSnapshot({ sessions, waitingQueue }) {
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

module.exports = {
  registerAdminRoutes,
};
