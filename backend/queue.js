const {
  AI_FALLBACK_SECONDS,
  QUEUE_ESTIMATED_SECONDS,
} = require("./config");
const {
  hasValidLocation,
  sanitizeLocation,
  sanitizePlayerId,
} = require("./sanitizers");

function createQueueService({
  waitingQueue,
  socketSessions,
  createAiSession,
  createHumanSession,
  findSessionByPlayerId,
  resumeSession,
}) {
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

  return {
    addToQueue,
    createRequestedAiSession,
    removeFromQueue,
    removeQueuedPlayer,
  };
}

module.exports = {
  createQueueService,
};
