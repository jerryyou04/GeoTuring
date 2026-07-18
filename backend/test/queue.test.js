const test = require("node:test");
const assert = require("node:assert/strict");
const { createQueueService } = require("../queue");

function createSocket(id = "socket-1") {
  return {
    id,
    connected: true,
    data: {},
    events: [],
    emit(event, payload) {
      this.events.push({ event, payload });
    },
  };
}

function createService(overrides = {}) {
  const waitingQueue = new Map();
  const calls = {
    abandon: [],
    createAi: [],
    find: [],
    resume: [],
  };
  const service = createQueueService({
    waitingQueue,
    socketSessions: new Map(),
    createAiSession(...args) {
      calls.createAi.push(args);
    },
    createHumanSession() {},
    findSessionByPlayerId(playerId, sessionId) {
      calls.find.push({ playerId, sessionId });
      return overrides.resumableSession || null;
    },
    resumeSession(socket, payload) {
      calls.resume.push({ socket, payload });
    },
    abandonSessionForQueue(session, playerId, replacementSocketId) {
      calls.abandon.push({ session, playerId, replacementSocketId });
    },
  });

  return { calls, service, waitingQueue };
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

test("queue service fails fast when fresh-session cleanup is not wired", () => {
  assert.throws(
    () => createQueueService({}),
    /requires abandonSessionForQueue/,
  );
});

test("a fresh queue request abandons the old session instead of resuming it", () => {
  const socket = createSocket();
  const { calls, service, waitingQueue } = createService({
    resumableSession: { id: "old-session" },
  });

  service.addToQueue(socket, validQueuePayload);

  assert.deepEqual(calls.find, [
    {
      playerId: validQueuePayload.playerId,
      sessionId: "",
    },
  ]);
  assert.equal(calls.resume.length, 0);
  assert.deepEqual(calls.abandon, [
    {
      session: { id: "old-session" },
      playerId: validQueuePayload.playerId,
      replacementSocketId: socket.id,
    },
  ]);
  assert.equal(waitingQueue.has(socket.id), true);
  assert.equal(socket.events.at(-1).event, "queue:status");
  assert.equal(socket.events.at(-1).payload.status, "searching");

  service.removeFromQueue(socket.id);
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
      sessionId: resumableSession.id,
    },
  ]);
  assert.equal(calls.resume.length, 1);
  assert.equal(calls.abandon.length, 0);
  assert.equal(calls.resume[0].socket, socket);
  assert.deepEqual(calls.resume[0].payload, {
    playerId: validQueuePayload.playerId,
    sessionId: resumableSession.id,
  });
  assert.equal(waitingQueue.size, 0);
});

test("an explicit session id never resumes a different session", () => {
  const socket = createSocket();
  const { calls, service, waitingQueue } = createService({
    resumableSession: { id: "different-session" },
  });

  service.addToQueue(socket, {
    ...validQueuePayload,
    sessionId: "requested-session",
  });

  assert.equal(calls.resume.length, 0);
  assert.equal(calls.abandon.length, 0);
  assert.equal(waitingQueue.size, 0);
  assert.deepEqual(socket.events.at(-1), {
    event: "session:resume_failed",
    payload: { reason: "not_found" },
  });
});

test("a requested AI game also abandons an older session first", () => {
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
  assert.deepEqual(calls.abandon, [
    {
      session: oldSession,
      playerId: validQueuePayload.playerId,
      replacementSocketId: socket.id,
    },
  ]);
  assert.equal(calls.createAi.length, 1);
  assert.equal(calls.createAi[0][0], socket);
  assert.equal(calls.createAi[0][2], "ChatGPT");
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
