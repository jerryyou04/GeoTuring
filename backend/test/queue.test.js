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
    find: [],
    resume: [],
  };
  const service = createQueueService({
    waitingQueue,
    socketSessions: new Map(),
    createAiSession() {},
    createHumanSession() {},
    findSessionByPlayerId(playerId, sessionId) {
      calls.find.push({ playerId, sessionId });
      return overrides.resumableSession || null;
    },
    resumeSession(socket, payload) {
      calls.resume.push({ socket, payload });
    },
    abandonSession(session, playerId) {
      calls.abandon.push({ session, playerId });
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
