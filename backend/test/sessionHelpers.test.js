const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSessionResumePayload,
  isGuessReady,
} = require("../sessionHelpers");

function createHumanSession(messages) {
  return {
    id: "session-1",
    mode: "human",
    players: {
      "socket-a": { submitted: false },
      "socket-b": { submitted: false },
    },
    messages,
    chatStartsAt: 100,
    chatEndsAt: 1000,
    chatLocked: false,
    finalGuessEndsAt: null,
    turnOwner: "socket-b",
    turnEndsAt: 500,
  };
}

test("guess readiness requires at least two messages from each side", () => {
  const session = createHumanSession([
    { author: "socket-a" },
    { author: "socket-a" },
    { author: "socket-b" },
  ]);

  assert.equal(isGuessReady(session), false);
  session.messages.push({ author: "socket-b" });
  assert.equal(isGuessReady(session), true);
});

test("resume payload restores turn ownership, deadline, counts, and transcript atomically", () => {
  const session = createHumanSession([
    { id: "a1", author: "socket-a", text: "one", sentAt: 1 },
    { id: "b1", author: "socket-b", text: "two", sentAt: 2 },
    { id: "a2", author: "socket-a", text: "three", sentAt: 3 },
    { id: "b2", author: "socket-b", text: "four", sentAt: 4 },
  ]);

  const payload = buildSessionResumePayload(session, "socket-a");

  assert.deepEqual(payload.turnState, {
    sessionId: session.id,
    serverNow: payload.serverNow,
    currentTurn: "partner",
    turnEndsAt: session.turnEndsAt,
    canGuessEarly: false,
    canAbort: false,
    counts: { player: 2, partner: 2 },
    required: 2,
  });
  assert.deepEqual(payload.messages.map(({ author, text }) => ({ author, text })), [
    { author: "player", text: "one" },
    { author: "partner", text: "two" },
    { author: "player", text: "three" },
    { author: "partner", text: "four" },
  ]);
});
