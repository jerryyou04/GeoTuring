const {
  AI_CONNECT_MIN_MS,
  AI_CONNECT_MAX_MS,
  RECONNECT_GRACE_MS,
} = require("./config");
const {
  hasValidLocation,
  sanitizeLocation,
  sanitizePlayerId,
} = require("./sanitizers");
const {
  clearQueueOwnershipSuperseded,
  isQueueOwnershipSuperseded,
  supersedeQueueSocket,
} = require("./socketOwnership");
const { randomInt } = require("./utils");

function createQueueService({
  waitingQueue,
  socketSessions,
  createAiSession,
  createHumanSession,
  findSessionByPlayerId,
  resumeSession,
  reconnectGraceMs = RECONNECT_GRACE_MS,
}) {
  function addToQueue(socket, payload = {}) {
    if (resumeMappedActiveSession(socket)) {
      return;
    }

    const playerId = sanitizePlayerId(payload.playerId);
    const activeSession = findSessionByPlayerId(playerId);

    if (isQueueOwnershipSuperseded(socket, playerId)) {
      if (activeSession || findQueuedPlayer(playerId)) {
        supersedeQueueSocket(socket, playerId);
        return;
      }

      clearQueueOwnershipSuperseded(socket, playerId);
    }

    socket.data.playerId = playerId;
    const requestedSessionId = String(payload.sessionId || "").trim();

    if (activeSession) {
      resumeSession(socket, {
        playerId,
        sessionId: activeSession.id,
      });
      return;
    }

    if (requestedSessionId) {
      const resumableSession = findSessionByPlayerId(playerId, requestedSessionId);

      if (resumableSession?.id === requestedSessionId) {
        resumeSession(socket, {
          playerId,
          sessionId: requestedSessionId,
        });
        return;
      }

      socket.emit("session:resume_failed", {
        reason: "not_found",
      });
      return;
    }

    releaseStaleSocketSession(socket);

    const recoverableEntry = findQueuedPlayer(playerId);

    if (recoverableEntry) {
      rebindQueueEntry(recoverableEntry, socket);
      emitQueueStatus(recoverableEntry);
      pairWaitingPlayers();

      if (waitingQueue.get(socket.id) === recoverableEntry) {
        scheduleFallback(recoverableEntry);
      }
      return;
    }

    removeQueuedPlayer(playerId);

    const entry = {
      socket,
      playerId,
      location: sanitizeLocation(payload.location),
      queuedAt: Date.now(),
      fallbackAt: null,
      fallbackTimer: null,
      disconnectTimer: null,
    };

    if (!hasValidLocation(entry.location)) {
      socket.emit("queue:error", {
        code: "location_required",
        message: "A valid rough IP location is required for human matchmaking.",
      });
      return;
    }

    waitingQueue.set(socket.id, entry);
    entry.fallbackAt = Date.now() + randomInt(AI_CONNECT_MIN_MS, AI_CONNECT_MAX_MS);
    emitQueueStatus(entry);
    pairWaitingPlayers();

    if (waitingQueue.has(socket.id)) {
      scheduleFallback(entry);
    }
  }

  function createRequestedAiSession(socket, payload = {}) {
    if (resumeMappedActiveSession(socket)) {
      return;
    }

    const playerId = sanitizePlayerId(payload.playerId);
    const activeSession = findSessionByPlayerId(playerId);

    if (isQueueOwnershipSuperseded(socket, playerId)) {
      if (activeSession || findQueuedPlayer(playerId)) {
        supersedeQueueSocket(socket, playerId);
        return;
      }

      clearQueueOwnershipSuperseded(socket, playerId);
    }

    socket.data.playerId = playerId;

    if (activeSession) {
      resumeSession(socket, {
        playerId,
        sessionId: activeSession.id,
      });
      return;
    }

    releaseStaleSocketSession(socket);
    const queueEntry = waitingQueue.get(socket.id) ||
      [...waitingQueue.values()].find((entry) => entry.playerId === playerId);
    removeQueuedPlayer(playerId);

    const location = sanitizeLocation(payload.location);

    if (!hasValidLocation(location)) {
      socket.emit("queue:error", {
        code: "location_required",
        message: "A valid rough IP location is required for AI testing.",
      });
      return;
    }

    createAiSession(socket, location, payload.modelFamily, queueEntry?.queuedAt || Date.now());
  }

  function releaseStaleSocketSession(socket) {
    const mappedSessionId = socketSessions.get(socket.id);

    if (!mappedSessionId) {
      return;
    }

    socketSessions.delete(socket.id);
    socket.leave?.(mappedSessionId);
  }

  function resumeMappedActiveSession(socket) {
    const mappedSessionId = socketSessions.get(socket.id);

    if (!mappedSessionId) {
      return false;
    }

    const mappedPlayerId = String(socket.data?.playerId || "").trim();

    if (!mappedPlayerId) {
      socket.emit("session:resume_failed", { reason: "socket_in_use" });
      return true;
    }

    const mappedSession = findSessionByPlayerId(mappedPlayerId, mappedSessionId);

    if (!mappedSession || mappedSession.ended || mappedSession.completed) {
      releaseStaleSocketSession(socket);
      return false;
    }

    resumeSession(socket, {
      playerId: mappedPlayerId,
      sessionId: mappedSession.id,
    });
    return true;
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
      emitMatchFound([first, second]);
      createHumanSession(first, second);
    }
  }

  function findQueuedPlayer(playerId) {
    return [...waitingQueue.values()].find((entry) => entry.playerId === playerId) || null;
  }

  function rebindQueueEntry(entry, socket) {
    const oldSocket = entry.socket;
    const oldSocketId = oldSocket.id;

    if (entry.disconnectTimer) {
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = null;
    }

    if (waitingQueue.get(oldSocketId) === entry) {
      waitingQueue.delete(oldSocketId);
    }

    entry.socket = socket;
    waitingQueue.set(socket.id, entry);

    if (oldSocketId !== socket.id) {
      supersedeQueueSocket(oldSocket, entry.playerId);
    }
  }

  function scheduleFallback(entry) {
    if (entry.fallbackTimer) {
      clearTimeout(entry.fallbackTimer);
    }

    const delay = Math.max(0, entry.fallbackAt - Date.now());
    entry.fallbackTimer = setTimeout(() => {
      entry.fallbackTimer = null;
      const socket = entry.socket;

      if (waitingQueue.get(socket.id) !== entry || !socket.connected) {
        return;
      }

      removeFromQueue(socket.id);
      createAiSession(socket, entry.location, null, entry.queuedAt);
      // Random per-player wait so the AI "connects" at a realistic, variable
      // time rather than a fixed beat. A second human joining first still
      // pre-empts this via pairWaitingPlayers (it clears the timer).
    }, delay);
  }

  function emitQueueStatus(entry) {
    entry.socket.emit("queue:status", {
      connectedProfiles: 1,
      requiredProfiles: 2,
      status: "searching",
      queuedAt: entry.queuedAt,
      serverNow: Date.now(),
    });
  }

  function emitMatchFound(entries) {
    entries.forEach((entry) => {
      entry.socket.emit("queue:status", {
        connectedProfiles: 2,
        requiredProfiles: 2,
        status: "found",
        queuedAt: entry.queuedAt,
        serverNow: Date.now(),
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

    if (entry.disconnectTimer) {
      clearTimeout(entry.disconnectTimer);
    }

    waitingQueue.delete(socketId);
  }

  function markDisconnected(socketId) {
    const entry = waitingQueue.get(socketId);

    if (!entry) {
      return false;
    }

    if (entry.disconnectTimer) {
      clearTimeout(entry.disconnectTimer);
    }

    entry.disconnectTimer = setTimeout(() => {
      entry.disconnectTimer = null;

      if (waitingQueue.get(entry.socket.id) === entry && !entry.socket.connected) {
        removeFromQueue(entry.socket.id);
      }
    }, reconnectGraceMs);
    return true;
  }

  function removeQueuedPlayer(playerId) {
    for (const [socketId, entry] of waitingQueue.entries()) {
      if (entry.playerId === playerId) {
        removeFromQueue(socketId);
      }
    }
  }

  return {
    addToQueue,
    createRequestedAiSession,
    markDisconnected,
    removeFromQueue,
    removeQueuedPlayer,
  };
}

module.exports = {
  createQueueService,
};
