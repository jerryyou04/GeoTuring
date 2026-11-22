const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpenRouterAiProvider } = require("../ai/openRouterProvider");

const UTC_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

test("OpenRouter chat prompts include an internally consistent authoritative UTC clock", async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  setPrompt(t, "OPENROUTER_CHAT_PROMPT", "Private chat instructions. {{CLOCK_CONTEXT}} {{PERSONA_INSTRUCTIONS}} {{#OPENING}}Start the conversation.{{/OPENING}}{{#REPLY}}Reply to the conversation.{{/REPLY}}");
  let requestBody = null;

  t.after(() => {
    global.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  });

  process.env.OPENROUTER_API_KEY = "test-key";
  global.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "clock received",
              },
            },
          ],
        };
      },
    };
  };

  const persona = {
    age: 24,
    humor: "dry",
    verbosity: "short",
    emojiUsage: "never",
    casing: "lowercase",
    punctuation: "casual",
    confidence: "medium",
    curiosity: "medium",
    suspicion: "medium",
    location: {
      poolId: "canada",
      worldRegion: "north-america",
      city: "Toronto",
      country: "Canada",
      timeZone: "America/Toronto",
    },
    locationDisclosure: "direct",
  };
  const provider = createOpenRouterAiProvider("ChatGPT", persona);
  const beforeRequest = Date.now();
  const result = await provider.generateReply([
    {
      author: "player",
      text: "what time is it?",
    },
  ]);
  const afterRequest = Date.now();

  assert.equal(result.source, "openrouter");
  assert.equal(requestBody.model, "openai/gpt-5.4-mini");

  const systemPrompt = requestBody.messages[0].content;
  const isoMatch = systemPrompt.match(
    /ISO 8601=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/,
  );

  assert.ok(isoMatch, "system prompt should contain a full UTC ISO timestamp");

  const isoTimestamp = isoMatch[1];
  const timestamp = new Date(isoTimestamp);
  const torontoClock = zonedClockParts(timestamp, "America/Toronto");

  assert.ok(timestamp.getTime() >= beforeRequest);
  assert.ok(timestamp.getTime() <= afterRequest);
  assert.match(systemPrompt, new RegExp(`day of week=${UTC_WEEKDAYS[timestamp.getUTCDay()]};`));
  assert.match(systemPrompt, new RegExp(`date=${isoTimestamp.slice(0, 10)};`));
  assert.match(systemPrompt, new RegExp(`time=${isoTimestamp.slice(11, 19)} UTC;`));
  assert.match(systemPrompt, /You are from and currently chatting from Toronto, Canada\./);
  assert.match(systemPrompt, /IANA time zone: America\/Toronto\./);
  assert.match(
    systemPrompt,
    /Assigned-location clock context for Toronto, Canada \(America\/Toronto\):/,
  );
  assert.match(systemPrompt, new RegExp(`day of week=${torontoClock.weekday};`));
  assert.match(
    systemPrompt,
    new RegExp(`date=${torontoClock.year}-${torontoClock.month}-${torontoClock.day};`),
  );
  assert.match(
    systemPrompt,
    new RegExp(`time=${torontoClock.hour}:${torontoClock.minute}:${torontoClock.second}\\.`),
  );
  assert.match(systemPrompt, /^Private chat instructions\./);
  assert.match(systemPrompt, /Reply to the conversation\./);
  assert.doesNotMatch(systemPrompt, /Start the conversation\.|\{\{/);
});

test("OpenRouter uses the configured final-guess prompt verbatim and supplies the transcript", async (t) => {
  const configuredPrompt = "Private final-guess instructions.\nReturn a JSON verdict with a reason.";
  setPrompt(t, "OPENROUTER_GUESS_PROMPT", configuredPrompt);
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  let requestBody = null;

  t.after(() => {
    global.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  });

  process.env.OPENROUTER_API_KEY = "test-key";
  global.fetch = async (url, options) => {
    requestBody = JSON.parse(options.body);

    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "human",
                  latitude: 43.6532,
                  longitude: -79.3832,
                  model: null,
                  reason: "The brief casual replies do not provide a reliable geographic clue.",
                }),
              },
            },
          ],
        };
      },
    };
  };

  const provider = createOpenRouterAiProvider("ChatGPT", null);
  const result = await provider.generateGuess([
    { author: "player", text: "hey, not much honestly" },
    { author: "partner", text: "same here" },
    { author: "player", text: "just chilling rn" },
  ]);

  assert.equal(result.failed, false);
  assert.equal(result.verdict, "human");

  const systemPrompt = requestBody.messages[0].content;

  assert.equal(systemPrompt, configuredPrompt);
  assert.match(requestBody.messages[1].content, /THEM: hey, not much honestly/);
  assert.match(requestBody.messages[1].content, /YOU: same here/);
  assert.equal(result.reason, "The brief casual replies do not provide a reliable geographic clue.");
});

test("configured chat prompts control opening and reply instructions", async (t) => {
  setPrompt(t, "OPENROUTER_CHAT_PROMPT", "Custom text.\n{{#OPENING}}Opening only.{{/OPENING}}{{#REPLY}}Reply only.{{/REPLY}}");
  const requests = [];
  t.mock.method(global, "fetch", async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, async json() { return { choices: [{ message: { content: "hello" } }] }; } };
  });
  const provider = createOpenRouterAiProvider("ChatGPT", null);

  await provider.generateReply([{ author: "system", text: "Match found" }]);
  await provider.generateReply([
    { author: "player", text: "hi" },
    { author: "partner", text: "hello" },
    { author: "player", text: "how are you?" },
  ]);

  assert.equal(requests[0].messages[0].content, "Custom text.\nOpening only.");
  assert.equal(requests[1].messages[0].content, "Custom text.\nReply only.");
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "how are you?" },
  ]);
});

test("chat prompt values pass through verbatim without template markers", async (t) => {
  const prompt = 'Private instructions.\nPreserve $& and "quoted text" exactly.';
  setPrompt(t, "OPENROUTER_CHAT_PROMPT", prompt);
  let requestBody;
  t.mock.method(global, "fetch", async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, async json() { return { choices: [{ message: { content: "hello" } }] }; } };
  });

  await createOpenRouterAiProvider("ChatGPT", null).generateReply([]);

  assert.equal(requestBody.messages[0].content, prompt);
});

for (const prompt of [undefined, "", " \n ", "Unrecognized {{UNKNOWN_CONTEXT}}", "{{#OPENING}}Unclosed block"]) {
  test(`missing, blank, or invalid chat configuration uses fallback (${JSON.stringify(prompt)})`, async (t) => {
    setPrompt(t, "OPENROUTER_CHAT_PROMPT", prompt);
    const fetchMock = t.mock.method(global, "fetch", async () => {
      throw new Error("OpenRouter must not be called with an invalid prompt");
    });

    const result = await createOpenRouterAiProvider("ChatGPT", null).generateReply([]);

    assert.ok(result.text);
    assert.match(result.error, /OPENROUTER_CHAT_PROMPT/);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
}

test("missing final-guess configuration makes the guess unavailable without an API call", async (t) => {
  setPrompt(t, "OPENROUTER_GUESS_PROMPT", undefined);
  const fetchMock = t.mock.method(global, "fetch", async () => {
    throw new Error("OpenRouter must not be called without a guess prompt");
  });

  const result = await createOpenRouterAiProvider("ChatGPT", null).generateGuess([]);

  assert.equal(result.failed, true);
  assert.equal(result.error, "OPENROUTER_GUESS_PROMPT is not configured.");
  assert.equal(fetchMock.mock.calls.length, 0);
});

function setPrompt(t, name, value) {
  const original = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  t.after(() => {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  });
}

function zonedClockParts(date, timeZone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}
