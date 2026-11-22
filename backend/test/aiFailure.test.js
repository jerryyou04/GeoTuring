const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Run the real turn/session code with only transport, storage, and timers stubbed.
// No network listener, credentials, or external services are needed.
function harness(generateReply) {
  const filename = path.join(__dirname, "../server.js");
  const actualRequire = createRequire(filename);
  const events = [];
  const cleared = [];
  const module = { exports: {} };
  const source = fs.readFileSync(filename, "utf8") +
    "\nmodule.exports = { sendAiTurnMessage, sessions, socketSessions };";
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: path.dirname(filename),
    console, process: { env: {} },
    setTimeout: () => ({}), clearTimeout: timer => cleared.push(timer),
    require(name) {
      if (name === "dotenv") return { config() {} };
      if (name === "http") return { createServer: () => ({ listen() {} }) };
      if (name === "socket.io") return { Server: class {
        on() {}
        to(socketId) { return { emit: (event, payload) => events.push({ socketId, event, payload }) }; }
      } };
      if (name === "./db" || name === "./redis") return {};
      if (name === "./utils") return { ...actualRequire(name), sleep: async () => {} };
      if (name === "./admin") return { registerAdminRoutes() {} };
      return actualRequire(name);
    },
  }, { filename });
  const session = {
    id: "failed-session", mode: "ai", playerSocketId: "player-socket",
    messages: [], participant: { adapter: { generateReply } },
    turnOwner: "partner", turnEndsAt: Date.now() + 25000,
    chatEndsAt: Date.now() + 135000, ended: false, chatLocked: false,
    turnTimer: {}, chatTimer: {}, expireTimer: {}, startTurnTimer: {},
    finalGuessTimer: {}, aiLockTimer: {},
  };
  const timers = [session.turnTimer, session.chatTimer, session.expireTimer,
    session.startTurnTimer, session.finalGuessTimer, session.aiLockTimer];
  const api = module.exports;
  api.sessions.set(session.id, session);
  api.socketSessions.set(session.playerSocketId, session.id);
  return { ...api, events, cleared, session, timers };
}

for (const [name, reply] of [
  ["provider throws", () => { throw new Error("private provider details"); }],
  ["failed reply contains text", () => ({ text: "must never be delivered", failed: true, error: "private details" })],
  ["empty reply", () => ({ text: "", failed: false })],
  ["whitespace reply", () => "   "],
]) {
  test(`${name} ends the round immediately without a reply or score`, async () => {
    const h = harness(reply);
    await h.sendAiTurnMessage(h.session.id);
    assert.equal(h.session.ended, true);
    assert.equal(h.session.aiResponseStatus.state, "failed");
    assert.equal(h.session.messages.length, 0);
    assert.equal(h.sessions.has(h.session.id), false);
    assert.equal(h.socketSessions.has(h.session.playerSocketId), false);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].event, "session:ended");
    assert.equal(h.events[0].socketId, h.session.playerSocketId);
    assert.match(h.events[0].payload.message, /AI service is temporarily unavailable/i);
    assert.match(h.events[0].payload.message, /not scored/);
    assert.doesNotMatch(h.events[0].payload.message, /private|must never/);
    for (const timer of h.timers) assert.ok(h.cleared.includes(timer));
  });
}

for (const outcome of ["reject", "resolve"]) {
  for (const change of ["locked", "ended", "removed", "replaced", "turn changed"]) {
    test(`late ${outcome} after session ${change} does not end another phase`, async () => {
      let finish;
      const h = harness(() => new Promise((resolve, reject) => {
        finish = outcome === "reject" ? () => reject(new Error("late error"))
          : () => resolve({ text: "", failed: true });
      }));
      const pending = h.sendAiTurnMessage(h.session.id);
      if (change === "locked") h.session.chatLocked = true;
      if (change === "ended") h.session.ended = true;
      if (change === "removed") h.sessions.delete(h.session.id);
      if (change === "replaced") h.sessions.set(h.session.id, { id: h.session.id });
      if (change === "turn changed") h.session.turnOwner = h.session.playerSocketId;
      finish();
      await pending;
      assert.equal(h.events.length, 0);
      assert.equal(h.cleared.length, 0);
    });
  }
}

test("a healthy provider reply is delivered normally and returns the turn to the player", async () => {
  const h = harness(() => ({ text: "a real provider reply", source: "openrouter", failed: false }));
  await h.sendAiTurnMessage(h.session.id);
  assert.equal(h.session.ended, false);
  assert.equal(h.sessions.has(h.session.id), true);
  assert.equal(h.session.messages.length, 1);
  assert.equal(h.session.messages[0].text, "a real provider reply");
  assert.equal(h.events[0].event, "partner:message");
  assert.equal(h.events[0].payload.message.text, "a real provider reply");
  assert.equal(h.session.turnOwner, h.session.playerSocketId);
  assert.equal(h.events.some(item => item.event === "session:ended"), false);
});

test("provider failure after guessing becomes available still ends the round without scoring", async (t) => {
  t.mock.method(Math, "random", () => 0.99);
  const h = harness(() => ({ text: "", failed: true, source: "openrouter", error: "Provider unavailable" }));
  h.session.messages = [
    { author: h.session.playerSocketId, text: "first question" },
    { author: "partner", text: "first answer" },
    { author: h.session.playerSocketId, text: "second question" },
    { author: "partner", text: "second answer" },
  ];
  h.session.aiLockEligibleTurns = 0;

  await h.sendAiTurnMessage(h.session.id);

  assert.equal(h.session.ended, true);
  assert.equal(h.session.messages.length, 4);
  assert.equal(h.sessions.has(h.session.id), false);
  assert.deepEqual(h.events.map(item => item.event), ["session:ended"]);
  assert.match(h.events[0].payload.message, /not scored/);
});

test("the provider factory reports missing credentials without generating a canned reply", async (t) => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  });
  const fetchMock = t.mock.method(global, "fetch", async () => assert.fail("No API request is expected"));
  const { createAiProvider } = require("../aiAdapters");

  const result = await createAiProvider("ChatGPT").generateReply([]);

  assert.equal(result.failed, true);
  assert.equal(result.source, "openrouter");
  assert.equal(result.text, "");
  assert.equal(result.error, "OPENROUTER_API_KEY is not configured.");
  assert.equal(fetchMock.mock.calls.length, 0);
});
