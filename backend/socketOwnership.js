const { isSocketInSession } = require("./sessionHelpers");

const SUPERSEDED_SESSION_IDS = "supersededSessionIds";
const SUPERSEDED_QUEUE_PLAYER_IDS = "supersededQueuePlayerIds";

function getOwnershipSet(socket, key) {
  if (!socket) {
    return null;
  }

  socket.data ||= {};

  if (!(socket.data[key] instanceof Set)) {
    socket.data[key] = new Set(socket.data[key] || []);
  }

  return socket.data[key];
}

function isSessionOwnershipSuperseded(socket, sessionId) {
  return Boolean(sessionId && getOwnershipSet(socket, SUPERSEDED_SESSION_IDS)?.has(sessionId));
}

function supersedeSessionSocket(socket, sessionId, { notify = true } = {}) {
  if (!socket || !sessionId) {
    return;
  }

  getOwnershipSet(socket, SUPERSEDED_SESSION_IDS).add(sessionId);
  socket.leave?.(sessionId);

  if (notify && socket.connected) {
    socket.emit("session:superseded", { sessionId });
  }
}

function isQueueOwnershipSuperseded(socket, playerId) {
  return Boolean(playerId && getOwnershipSet(socket, SUPERSEDED_QUEUE_PLAYER_IDS)?.has(playerId));
}

function clearQueueOwnershipSuperseded(socket, playerId) {
  if (!socket || !playerId) {
    return;
  }

  getOwnershipSet(socket, SUPERSEDED_QUEUE_PLAYER_IDS).delete(playerId);
}

function supersedeQueueSocket(socket, playerId, { notify = true } = {}) {
  if (!socket || !playerId) {
    return;
  }

  getOwnershipSet(socket, SUPERSEDED_QUEUE_PLAYER_IDS).add(playerId);

  if (notify && socket.connected) {
    socket.emit("queue:superseded", {
      message: "This queue moved to a newer connection.",
    });
  }
}

function isCurrentSessionSocket(session, socket, socketSessions) {
  if (!session || !socket) {
    return false;
  }

  return socketSessions.get(socket.id) === session.id &&
    !isSessionOwnershipSuperseded(socket, session.id) &&
    isSocketInSession(session, socket.id);
}

function transferSessionSocket({
  session,
  playerId,
  socket,
  socketSessions,
  getSocket,
  armTurnTimer,
}) {
  if (!session || !socket || isSessionOwnershipSuperseded(socket, session.id)) {
    return null;
  }

  if (session.mode === "human") {
    const socketPlayer = session.players[socket.id];

    // A socket that already owns one side of a human session cannot claim the
    // other side by resuming with that player's id.
    if (socketPlayer && socketPlayer.playerId !== playerId) {
      return null;
    }

    const oldSocketId = Object.keys(session.players).find(
      (candidateId) => session.players[candidateId].playerId === playerId,
    );

    if (!oldSocketId) {
      return null;
    }

    const player = session.players[oldSocketId];

    if (oldSocketId === socket.id) {
      player.disconnected = false;
      return socket.id;
    }

    const oldSocket = getSocket(oldSocketId);
    const oldSocketOwnedSession = socketSessions.get(oldSocketId) === session.id;

    session.messages.forEach((message) => {
      if (message.author === oldSocketId) {
        message.author = socket.id;
      }
    });

    delete session.players[oldSocketId];
    if (oldSocketOwnedSession) {
      socketSessions.delete(oldSocketId);
    }
    session.players[socket.id] = {
      ...player,
      socketId: socket.id,
      disconnected: false,
    };

    if (session.turnOwner === oldSocketId) {
      session.turnOwner = socket.id;
      armTurnTimer(session);
    }

    if (session.startTurnOwner === oldSocketId) {
      session.startTurnOwner = socket.id;
    }

    if (session.timeout?.canActSocketId === oldSocketId) {
      session.timeout.canActSocketId = socket.id;
    }

    supersedeSessionSocket(oldSocket, session.id);
    return socket.id;
  }

  if (session.playerId !== playerId) {
    return null;
  }

  const oldSocketId = session.playerSocketId;

  if (oldSocketId === socket.id) {
    session.disconnected = false;
    return socket.id;
  }

  const oldSocket = getSocket(oldSocketId);
  const oldSocketOwnedSession = socketSessions.get(oldSocketId) === session.id;

  if (oldSocketOwnedSession) {
    socketSessions.delete(oldSocketId);
  }

  if (session.turnOwner === oldSocketId) {
    session.turnOwner = socket.id;
    armTurnTimer(session);
  }

  if (session.startTurnOwner === oldSocketId) {
    session.startTurnOwner = socket.id;
  }

  if (session.timeout?.canActSocketId === oldSocketId) {
    session.timeout.canActSocketId = socket.id;
  }

  session.messages.forEach((message) => {
    if (message.author === oldSocketId) {
      message.author = socket.id;
    }
  });

  session.playerSocketId = socket.id;
  session.disconnected = false;
  supersedeSessionSocket(oldSocket, session.id);
  return socket.id;
}

module.exports = {
  clearQueueOwnershipSuperseded,
  isCurrentSessionSocket,
  isQueueOwnershipSuperseded,
  isSessionOwnershipSuperseded,
  supersedeQueueSocket,
  supersedeSessionSocket,
  transferSessionSocket,
};
