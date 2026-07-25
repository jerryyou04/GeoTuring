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
  assert.match(systemPrompt, /background context for the current date and time/);
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
  assert.match(systemPrompt, /assigned-location clock above already includes daylight-saving rules/);
  assert.doesNotMatch(systemPrompt, /Sometimes just give a specific believable place/);
  assert.doesNotMatch(systemPrompt, /leaning casual gen z internet style/);
  assert.doesNotMatch(systemPrompt, /When asked for the current date or time/);
});

test("OpenRouter guess prompts do not treat casual English as North American evidence", async (t) => {
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

  assert.match(systemPrompt, /Treat casual English as geographically neutral\./);
  assert.match(systemPrompt, /do not by themselves point to Canada or the United States/);
  assert.match(systemPrompt, /Europe, Asia, Africa, Latin America, Oceania/);
  assert.match(systemPrompt, /Give even modest credible evidence outside Canada or the United States real weight\./);
  assert.match(systemPrompt, /follow that evidence instead of pulling the guess back toward North America/);
  assert.match(systemPrompt, /only when the transcript contains no meaningful geographic signal at all/);
  assert.match(systemPrompt, /Toronto, Vancouver, California, New York, Texas, Florida/);
  assert.doesNotMatch(systemPrompt, /randomly selected|fallback anchor|tie-break/i);
});

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
