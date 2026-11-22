const test = require("node:test");
const assert = require("node:assert/strict");

const modulePaths = ["../ai/hostility", "../aiRuntime", "../ai/mockProvider"];

function configuredDetection(t, value) {
  const original = process.env.AI_HOSTILE_TRIGGERS;
  for (const path of modulePaths) delete require.cache[require.resolve(path)];
  if (value === undefined) delete process.env.AI_HOSTILE_TRIGGERS;
  else process.env.AI_HOSTILE_TRIGGERS = value;
  t.after(() => {
    for (const path of modulePaths) delete require.cache[require.resolve(path)];
  });

  try {
    return {
      ...require("../ai/hostility"),
      ...require("../aiRuntime"),
      ...require("../ai/mockProvider"),
    };
  } finally {
    if (original === undefined) delete process.env.AI_HOSTILE_TRIGGERS;
    else process.env.AI_HOSTILE_TRIGGERS = original;
  }
}

test("configured keywords match case-insensitively and preserve substring matching", (t) => {
  const { isMessageHostile } = configuredDetection(t, '[" Signal Phrase ", "TOKEN"]');

  assert.equal(isMessageHostile("a SIGNAL PHRASE appears here"), true);
  assert.equal(isMessageHostile("embeddedtokensuffix"), true);
  assert.equal(isMessageHostile("ordinary conversation"), false);
  assert.equal(isMessageHostile(null), false);
  assert.equal(isMessageHostile(undefined), false);
  assert.equal(isMessageHostile(""), false);
});

for (const value of [undefined, "", " \n ", "[]"]) {
  test(`absent or empty trigger lists disable keyword detection (${JSON.stringify(value)})`, (t) => {
    const { isMessageHostile } = configuredDetection(t, value);

    assert.equal(isMessageHostile("a signal phrase or any other text"), false);
    assert.equal(isMessageHostile(""), false);
  });
}

test("invalid trigger configuration is rejected without including its value in the error", (t) => {
  for (const value of ["invalid-json", "{}", "null", '"text"', '["valid", 1]', '[null]', '[""]', '[" "]']) {
    assert.throws(() => configuredDetection(t, value), {
      message: "AI_HOSTILE_TRIGGERS must be a JSON array of nonempty strings.",
    });
  }
});

test("configured detection still drives hostile early-lock behavior", (t) => {
  const { isMessageHostile, decideAiLock } = configuredDetection(t, '["signal phrase"]');
  const rolls = [0.9, 0.1, 0.9];
  t.mock.method(Math, "random", () => rolls.shift() ?? 0.5);

  const plan = decideAiLock({
    turnsSinceEligible: 1,
    hostile: isMessageHostile("a SIGNAL PHRASE"),
    msLeftInChat: 60000,
  });

  assert.equal(plan.lock, true);
  assert.equal(plan.viaHostile, true);
  assert.equal(plan.mode, "after-reply");
  assert.equal(plan.parting, null);
});

test("disabled keyword detection leaves ordinary early-lock probability active", (t) => {
  const { isMessageHostile, decideAiLock } = configuredDetection(t, "[]");
  const rolls = [0.05, 0.9, 0.9];
  t.mock.method(Math, "random", () => rolls.shift() ?? 0.5);

  const plan = decideAiLock({
    turnsSinceEligible: 1,
    hostile: isMessageHostile("signal phrase"),
    msLeftInChat: 60000,
  });

  assert.equal(plan.lock, true);
  assert.equal(plan.viaHostile, false);
});

test("the mock provider uses the same configured keywords for its reply selection", (t) => {
  const { createMockAiProvider } = configuredDetection(t, '["signal phrase"]');
  const provider = createMockAiProvider("ChatGPT", {
    location: { city: "Dublin", country: "Ireland" },
    locationDisclosure: "direct",
  });

  const normal = provider.generateReply([{ author: "player", text: "where are you from?" }]);
  const triggered = provider.generateReply([{ author: "player", text: "where are you from? SIGNAL PHRASE" }]);

  assert.match(normal.text, /Dublin/i);
  assert.doesNotMatch(triggered.text, /Dublin/i);
  assert.ok(triggered.text);
  assert.equal(triggered.source, "local");
});
