const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isCurrentSessionSocket,
  transferSessionSocket,
} = require("../socketOwnership");

function createSocket(id) {
  return {
    id,
    connected: true,
    data: {},
    events: [],
    leftRooms: [],
    disconnectCalls: 0,
    emit(event, payload) {
      this.events.push({ event, payload });
    },
    leave(roomId) {
      this.leftRooms.push(roomId);
    },
    disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
  };
}

test("human session ownership transfers atomically without disconnecting the old socket", () => {
  const oldSocket = createSocket("human-old");
  const newSocket = createSocket("human-new");
  const partnerSocket = createSocket("human-partner");
  const socketSessions = new Map([
    [oldSocket.id, "human-session"],
    [partnerSocket.id, "human-session"],
  ]);
  const sockets = new Map([
    [oldSocket.id, oldSocket],
    [newSocket.id, newSocket],
    [partnerSocket.id, partnerSocket],
  ]);
  const armedSessions = [];
  const session = {
    id: "human-session",
    mode: "human",
    players: {
      [oldSocket.id]: {
        socketId: oldSocket.id,
        playerId: "player-a",
        disconnected: true,
        submitted: false,
      },
      [partnerSocket.id]: {
        socketId: partnerSocket.id,
        playerId: "player-b",
        disconnected: false,
        submitted: false,
      },
    },
    messages: [
      { id: "a", author: oldSocket.id, clientMessageId: "client-a" },
      { id: "b", author: partnerSocket.id },
    ],
    turnOwner: oldSocket.id,
    startTurnOwner: oldSocket.id,
    timeout: { canActSocketId: oldSocket.id },
  };

  const result = transferSessionSocket({
    session,
    playerId: "player-a",
    socket: newSocket,
    socketSessions,
    getSocket: (socketId) => sockets.get(socketId),
    armTurnTimer: (targetSession) => armedSessions.push(targetSession.id),
  });

  assert.equal(result, newSocket.id);
  assert.equal(oldSocket.connected, true);
  assert.equal(oldSocket.disconnectCalls, 0);
  assert.deepEqual(oldSocket.leftRooms, [session.id]);
  assert.deepEqual(oldSocket.events, [
    { event: "session:superseded", payload: { sessionId: session.id } },
  ]);
  assert.equal(socketSessions.has(oldSocket.id), false);
  assert.equal(session.players[oldSocket.id], undefined);
  assert.equal(session.players[newSocket.id].playerId, "player-a");
  assert.equal(session.players[newSocket.id].disconnected, false);
  assert.equal(session.messages[0].author, newSocket.id);
  assert.equal(session.messages[0].clientMessageId, "client-a");
  assert.equal(session.turnOwner, newSocket.id);
  assert.equal(session.startTurnOwner, newSocket.id);
  assert.equal(session.timeout.canActSocketId, newSocket.id);
  assert.deepEqual(armedSessions, [session.id]);

  assert.equal(isCurrentSessionSocket(session, newSocket, socketSessions), false);
  socketSessions.set(newSocket.id, session.id);
  assert.equal(isCurrentSessionSocket(session, oldSocket, socketSessions), false);
  assert.equal(isCurrentSessionSocket(session, newSocket, socketSessions), true);

  const staleTakeover = transferSessionSocket({
    session,
    playerId: "player-a",
    socket: oldSocket,
    socketSessions,
    getSocket: (socketId) => sockets.get(socketId),
    armTurnTimer() {},
  });
  assert.equal(staleTakeover, null);
  assert.equal(session.players[newSocket.id].playerId, "player-a");
});

test("a mapped human socket cannot claim and overwrite its partner slot", () => {
  const firstSocket = createSocket("human-first");
  const secondSocket = createSocket("human-second");
  const socketSessions = new Map([
    [firstSocket.id, "human-session"],
    [secondSocket.id, "human-session"],
  ]);
  const session = {
    id: "human-session",
    mode: "human",
    players: {
      [firstSocket.id]: {
        socketId: firstSocket.id,
        playerId: "player-a",
        disconnected: false,
      },
      [secondSocket.id]: {
        socketId: secondSocket.id,
        playerId: "player-b",
        disconnected: false,
      },
    },
    messages: [],
    turnOwner: firstSocket.id,
    startTurnOwner: null,
    timeout: null,
  };

  const result = transferSessionSocket({
    session,
    playerId: "player-b",
    socket: firstSocket,
    socketSessions,
    getSocket: () => undefined,
    armTurnTimer() {},
  });

  assert.equal(result, null);
  assert.deepEqual(Object.keys(session.players).sort(), [firstSocket.id, secondSocket.id].sort());
  assert.equal(session.players[firstSocket.id].playerId, "player-a");
  assert.equal(session.players[secondSocket.id].playerId, "player-b");
  assert.equal(session.turnOwner, firstSocket.id);
  assert.equal(socketSessions.get(firstSocket.id), session.id);
  assert.equal(socketSessions.get(secondSocket.id), session.id);
});

test("AI session ownership handoff keeps the old transport open and preserves retry ids", () => {
  const oldSocket = createSocket("ai-old");
  const newSocket = createSocket("ai-new");
  const socketSessions = new Map([[oldSocket.id, "ai-session"]]);
  const session = {
    id: "ai-session",
    mode: "ai",
    playerId: "player-ai",
    playerSocketId: oldSocket.id,
    disconnected: true,
    messages: [
      { id: "message", author: oldSocket.id, clientMessageId: "stable-retry-id" },
      { id: "reply", author: "partner" },
    ],
    turnOwner: oldSocket.id,
    startTurnOwner: oldSocket.id,
    timeout: null,
  };

  const result = transferSessionSocket({
    session,
    playerId: session.playerId,
    socket: newSocket,
    socketSessions,
    getSocket: (socketId) => socketId === oldSocket.id ? oldSocket : undefined,
    armTurnTimer() {},
  });

  assert.equal(result, newSocket.id);
  assert.equal(oldSocket.connected, true);
  assert.equal(oldSocket.disconnectCalls, 0);
  assert.deepEqual(oldSocket.leftRooms, [session.id]);
  assert.equal(session.playerSocketId, newSocket.id);
  assert.equal(session.disconnected, false);
  assert.equal(session.messages[0].author, newSocket.id);
  assert.equal(session.messages[0].clientMessageId, "stable-retry-id");
  assert.equal(session.messages[1].author, "partner");
  assert.equal(socketSessions.has(oldSocket.id), false);

  socketSessions.set(newSocket.id, session.id);
  assert.equal(isCurrentSessionSocket(session, oldSocket, socketSessions), false);
  assert.equal(isCurrentSessionSocket(session, newSocket, socketSessions), true);
});
