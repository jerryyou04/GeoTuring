const test = require("node:test");
const assert = require("node:assert/strict");
const { createQueueService } = require("../queue");
const { resolveClientMessageId } = require("../sessionHelpers");

function createSocket(id = "socket-1") {
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
    disconnect() {
      this.disconnectCalls += 1;
      this.connected = false;
    },
    leave(roomId) {
      this.leftRooms.push(roomId);
    },
  };
}

function createService(overrides = {}) {
  const waitingQueue = new Map();
  const socketSessions = overrides.socketSessions || new Map();
  const calls = {
    createAi: [],
    find: [],
    resume: [],
  };
  const service = createQueueService({
    waitingQueue,
    socketSessions,
    createAiSession(...args) {
      calls.createAi.push(args);
    },
    createHumanSession() {},
    findSessionByPlayerId(playerId, sessionId) {
      calls.find.push({ playerId, sessionId });

      if (sessionId && Object.hasOwn(overrides, "preferredSession")) {
        return overrides.preferredSession;
      }

      if (!sessionId && Object.hasOwn(overrides, "activeSession")) {
        return overrides.activeSession;
      }

      return overrides.resumableSession || null;
    },
    resumeSession(socket, payload) {
      calls.resume.push({ socket, payload });
    },
    reconnectGraceMs: overrides.reconnectGraceMs,
  });

  return { calls, service, socketSessions, waitingQueue };
}

const validQueuePayload = {
  playerId: "player-123",
  location: {
    country: "Canada",
    region: "Ontario",
    city: "Toronto",
    lat: 43.65,
    lng: -79.38,
  },
};

test("a fresh queue request resumes an unfinished session instead of creating another game", () => {
  const socket = createSocket();
  const { calls, service, waitingQueue } = createService({
    resumableSession: { id: "old-session" },
  });

  service.addToQueue(socket, validQueuePayload);

  assert.deepEqual(calls.find, [
    {
      playerId: validQueuePayload.playerId,
      sessionId: undefined,
    },
  ]);
  assert.deepEqual(calls.resume.map(({ payload }) => payload), [
    {
      playerId: validQueuePayload.playerId,
      sessionId: "old-session",
    },
  ]);
  assert.equal(waitingQueue.size, 0);
});

test("an explicit active session id still resumes the game", () => {
  const socket = createSocket();
  const resumableSession = { id: "active-session" };
  const { calls, service, waitingQueue } = createService({ resumableSession });

  service.addToQueue(socket, {
    ...validQueuePayload,
    sessionId: resumableSession.id,
  });

  assert.deepEqual(calls.find, [
    {
      playerId: validQueuePayload.playerId,
      sessionId: undefined,
    },
  ]);
  assert.equal(calls.resume.length, 1);
  assert.equal(calls.resume[0].socket, socket);
  assert.deepEqual(calls.resume[0].payload, {
    playerId: validQueuePayload.playerId,
    sessionId: resumableSession.id,
  });
  assert.equal(waitingQueue.size, 0);
});

test("a stale explicit session id cannot bypass a different unfinished session", () => {
  const socket = createSocket();
  const { calls, service, waitingQueue } = createService({
    preferredSession: { id: "different-session" },
    activeSession: { id: "active-session" },
  });

  service.addToQueue(socket, {
    ...validQueuePayload,
    sessionId: "requested-session",
  });

  assert.deepEqual(calls.find, [
    {
      playerId: validQueuePayload.playerId,
      sessionId: undefined,
    },
  ]);
  assert.deepEqual(calls.resume.map(({ payload }) => payload), [
    {
      playerId: validQueuePayload.playerId,
      sessionId: "active-session",
    },
  ]);
  assert.equal(waitingQueue.size, 0);
});

test("an explicit completed session can still recover its retained result when no game is active", () => {
  const socket = createSocket();
  const completedSession = { id: "completed-session" };
  const { calls, service, waitingQueue } = createService({
    activeSession: null,
    preferredSession: completedSession,
  });

  service.addToQueue(socket, {
    ...validQueuePayload,
    sessionId: completedSession.id,
  });

  assert.deepEqual(calls.find, [
    {
      playerId: validQueuePayload.playerId,
      sessionId: undefined,
    },
    {
      playerId: validQueuePayload.playerId,
      sessionId: completedSession.id,
    },
  ]);
  assert.deepEqual(calls.resume.map(({ payload }) => payload), [
    {
      playerId: validQueuePayload.playerId,
      sessionId: completedSession.id,
    },
  ]);
  assert.equal(waitingQueue.size, 0);
});

test("an explicit missing session fails only when the player has no active game", () => {
  const socket = createSocket();
  const { calls, service, waitingQueue } = createService({
    preferredSession: null,
    activeSession: null,
  });

  service.addToQueue(socket, {
    ...validQueuePayload,
    sessionId: "missing-session",
  });

  assert.equal(calls.resume.length, 0);
  assert.equal(waitingQueue.size, 0);
  assert.deepEqual(calls.find, [
    {
      playerId: validQueuePayload.playerId,
      sessionId: undefined,
    },
    {
      playerId: validQueuePayload.playerId,
      sessionId: "missing-session",
    },
  ]);
  assert.deepEqual(socket.events.at(-1), {
    event: "session:resume_failed",
    payload: { reason: "not_found" },
  });
});

test("a requested AI game resumes an unfinished session instead of replacing it", () => {
  const socket = createSocket();
  const oldSession = { id: "old-session" };
  const { calls, service } = createService({ resumableSession: oldSession });

  service.createRequestedAiSession(socket, {
    ...validQueuePayload,
    modelFamily: "ChatGPT",
  });

  assert.deepEqual(calls.find, [
    {
      playerId: validQueuePayload.playerId,
      sessionId: undefined,
    },
  ]);
  assert.deepEqual(calls.resume.map(({ payload }) => payload), [
    {
      playerId: validQueuePayload.playerId,
      sessionId: oldSession.id,
    },
  ]);
  assert.equal(calls.createAi.length, 0);
});

test("a completed socket mapping is released before joining a fresh queue", () => {
  const socket = createSocket();
  socket.data.playerId = validQueuePayload.playerId;
  const socketSessions = new Map([[socket.id, "completed-session"]]);
  const { calls, service, waitingQueue } = createService({ socketSessions });

  service.addToQueue(socket, validQueuePayload);

  assert.equal(calls.resume.length, 0);
  assert.equal(socketSessions.has(socket.id), false);
  assert.deepEqual(socket.leftRooms, ["completed-session"]);
  assert.equal(waitingQueue.has(socket.id), true);

  service.removeFromQueue(socket.id);
});

test("a changed queue player id cannot escape the socket's mapped active game", () => {
  const socket = createSocket();
  socket.data.playerId = "original-player";
  const activeSession = { id: "active-session", completed: false, ended: false };
  const socketSessions = new Map([[socket.id, activeSession.id]]);
  const { calls, service, waitingQueue } = createService({
    socketSessions,
    preferredSession: activeSession,
  });

  service.addToQueue(socket, {
    ...validQueuePayload,
    playerId: "different-player",
  });

  assert.deepEqual(calls.resume.map(({ payload }) => payload), [
    { playerId: "original-player", sessionId: activeSession.id },
  ]);
  assert.equal(waitingQueue.size, 0);
  assert.equal(socketSessions.get(socket.id), activeSession.id);
});

test("a changed AI-request player id cannot escape the socket's mapped active game", () => {
  const socket = createSocket();
  socket.data.playerId = "original-player";
  const activeSession = { id: "active-session", completed: false, ended: false };
  const socketSessions = new Map([[socket.id, activeSession.id]]);
  const { calls, service } = createService({
    socketSessions,
    preferredSession: activeSession,
  });

  service.createRequestedAiSession(socket, {
    ...validQueuePayload,
    playerId: "different-player",
    modelFamily: "Claude",
  });

  assert.deepEqual(calls.resume.map(({ payload }) => payload), [
    { playerId: "original-player", sessionId: activeSession.id },
  ]);
  assert.equal(calls.createAi.length, 0);
  assert.equal(socketSessions.get(socket.id), activeSession.id);
});

test("an AI request removes every queued socket for the same player", () => {
  const queuedSocket = createSocket("queued-socket");
  const aiSocket = createSocket("ai-socket");
  const { calls, service, waitingQueue } = createService();

  service.addToQueue(queuedSocket, validQueuePayload);
  assert.equal(waitingQueue.has(queuedSocket.id), true);

  service.createRequestedAiSession(aiSocket, {
    ...validQueuePayload,
    modelFamily: "Claude",
  });

  assert.equal(waitingQueue.size, 0);
  assert.equal(calls.createAi.length, 1);
  assert.equal(calls.createAi[0][0], aiSocket);
  assert.equal(calls.createAi[0][2], "Claude");
  assert.equal(calls.createAi[0][3], queuedSocket.events[0].payload.queuedAt);
});

test("a reconnecting player keeps the same queue entry and fallback deadline", () => {
  const firstSocket = createSocket("socket-before-drop");
  const replacementSocket = createSocket("socket-after-drop");
  const { service, waitingQueue } = createService();

  service.addToQueue(firstSocket, validQueuePayload);
  const originalEntry = waitingQueue.get(firstSocket.id);
  const originalQueuedAt = originalEntry.queuedAt;
  const originalFallbackAt = originalEntry.fallbackAt;

  firstSocket.connected = false;
  assert.equal(service.markDisconnected(firstSocket.id), true);
  service.addToQueue(replacementSocket, validQueuePayload);

  assert.equal(waitingQueue.has(firstSocket.id), false);
  assert.equal(waitingQueue.get(replacementSocket.id), originalEntry);
  assert.equal(originalEntry.socket, replacementSocket);
  assert.equal(originalEntry.queuedAt, originalQueuedAt);
  assert.equal(originalEntry.fallbackAt, originalFallbackAt);
  assert.equal(replacementSocket.events.at(-1).payload.queuedAt, originalQueuedAt);

  service.removeFromQueue(replacementSocket.id);
});

test("a half-open old queue socket is made inert without closing its transport", () => {
  const firstSocket = createSocket("socket-still-half-open");
  const replacementSocket = createSocket("socket-replacement");
  const { service, waitingQueue } = createService();

  service.addToQueue(firstSocket, validQueuePayload);
  const originalEntry = waitingQueue.get(firstSocket.id);
  const originalQueuedAt = originalEntry.queuedAt;
  const originalFallbackAt = originalEntry.fallbackAt;

  service.addToQueue(replacementSocket, validQueuePayload);

  assert.equal(waitingQueue.has(firstSocket.id), false);
  assert.equal(waitingQueue.get(replacementSocket.id), originalEntry);
  assert.equal(originalEntry.queuedAt, originalQueuedAt);
  assert.equal(originalEntry.fallbackAt, originalFallbackAt);
  assert.equal(firstSocket.connected, true);
  assert.equal(firstSocket.disconnectCalls, 0);
  assert.equal(firstSocket.events.at(-1).event, "queue:superseded");
  assert.equal(firstSocket.data.supersededQueuePlayerIds.has(validQueuePayload.playerId), true);

  service.addToQueue(firstSocket, validQueuePayload);
  service.removeFromQueue(firstSocket.id);
  firstSocket.connected = false;

  assert.equal(waitingQueue.get(replacementSocket.id), originalEntry);
  assert.equal(waitingQueue.has(firstSocket.id), false);
  assert.equal(service.markDisconnected(firstSocket.id), false);
  assert.equal(waitingQueue.get(replacementSocket.id), originalEntry);

  service.removeFromQueue(replacementSocket.id);
});

test("a superseded queue socket cannot replace the current queue with an AI game", () => {
  const firstSocket = createSocket("socket-stale");
  const replacementSocket = createSocket("socket-current");
  const { calls, service, waitingQueue } = createService();

  service.addToQueue(firstSocket, validQueuePayload);
  service.addToQueue(replacementSocket, validQueuePayload);
  const currentEntry = waitingQueue.get(replacementSocket.id);

  service.createRequestedAiSession(firstSocket, {
    ...validQueuePayload,
    modelFamily: "Claude",
  });

  assert.equal(calls.createAi.length, 0);
  assert.equal(waitingQueue.get(replacementSocket.id), currentEntry);
  assert.equal(waitingQueue.has(firstSocket.id), false);

  service.removeFromQueue(replacementSocket.id);

  service.addToQueue(firstSocket, validQueuePayload);
  assert.equal(waitingQueue.has(firstSocket.id), true);
  assert.equal(firstSocket.data.supersededQueuePlayerIds.has(validQueuePayload.playerId), false);
  service.removeFromQueue(firstSocket.id);
});

test("a disconnected queue entry is removed after the reconnect grace", async () => {
  const socket = createSocket();
  const { service, waitingQueue } = createService({ reconnectGraceMs: 5 });

  service.addToQueue(socket, validQueuePayload);
  socket.connected = false;
  service.markDisconnected(socket.id);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(waitingQueue.size, 0);
});

test("legacy chat messages receive a generated effective id", () => {
  const resolved = resolveClientMessageId(undefined, () => "generated-message-id");

  assert.deepEqual(resolved, {
    clientMessageId: "generated-message-id",
    providedByClient: false,
  });
});

test("client-provided chat ids remain stable for retry deduplication", () => {
  const resolved = resolveClientMessageId("  client-message-id  ", () => "unused");

  assert.deepEqual(resolved, {
    clientMessageId: "client-message-id",
    providedByClient: true,
  });
});
