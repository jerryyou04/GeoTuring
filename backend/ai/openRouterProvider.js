const {
  buildAiReplyResult,
  buildPersonaInstructions,
  hasChatMessages,
} = require("./common");
const { createMockAiProvider } = require("./mockProvider");

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 9000);
const OPENROUTER_MAX_CONTEXT_MESSAGES = Number(process.env.OPENROUTER_MAX_CONTEXT_MESSAGES || 10);
const OPENROUTER_MAX_TOKENS = Number(process.env.OPENROUTER_MAX_TOKENS || 256);
const OPENROUTER_GUESS_MAX_TOKENS = Number(process.env.OPENROUTER_GUESS_MAX_TOKENS || 1100);
// The end-of-game guess runs during the 25s final-guess window, so it gets a
// longer ceiling than the snappy chat reply.
const OPENROUTER_GUESS_TIMEOUT_MS = Number(process.env.OPENROUTER_GUESS_TIMEOUT_MS || 15000);
const UTC_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DEFAULT_OPENROUTER_MODELS = {
  ChatGPT: "openai/gpt-5.4-mini",
  Gemini: "google/gemini-3.1-flash-lite",
  Claude: "anthropic/claude-haiku-4.5",
  Grok: "x-ai/grok-4.3",
};

function createOpenRouterAiProvider(modelFamily, persona) {
  const model = getModelSlug(modelFamily);
  const fallback = createMockAiProvider(modelFamily, persona);

  return {
    modelFamily,
    model,
    async generateReply(messages, options = {}) {
      try {
        const requestMessages = buildOpenRouterMessages(messages, persona);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
        const response = await fetch(OPENROUTER_CHAT_URL, {
          method: "POST",
          signal: controller.signal,
          headers: buildOpenRouterHeaders(),
          body: JSON.stringify({
            model,
            messages: requestMessages,
            max_tokens: OPENROUTER_MAX_TOKENS,
            ...buildReasoningConfig(),
            temperature: 0.86,
            top_p: 0.92,
            frequency_penalty: 0.35,
            presence_penalty: 0.15,
            session_id: options.sessionId || undefined,
          }),
        });
        clearTimeout(timeout);

        if (!response.ok) {
          const details = await response.text();
          throw new Error(`OpenRouter ${response.status}: ${details.slice(0, 240)}`);
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        const text = normalizeAiReply(content);

        if (!text) {
          console.warn(`OpenRouter returned an unusable reply for ${modelFamily} (${model}); using local fallback.`);
          return buildFallbackReply(await fallback.generateReply(messages), model, "OpenRouter returned an unusable reply.");
        }

        return buildAiReplyResult(text, {
          source: "openrouter",
          failed: false,
          error: null,
          model,
        });
      } catch (error) {
        console.warn(`OpenRouter reply failed for ${modelFamily}: ${error.message}`);
        return buildFallbackReply(await fallback.generateReply(messages), model, error.message);
      }
    },
    // A separate, out-of-character analytical call: after the chat, the AI judges
    // whether the OTHER participant was human or AI. Returns raw structured fields
    // (the server sanitizes them). Fails gracefully — no mock fallback. Mirrors the
    // reliable chat call: no response_format, reasoning off by default. Retries once
    // since it runs during the generous final-guess window.
    async generateGuess(messages) {
      const first = await attemptGuess(modelFamily, model, messages);

      if (!first.failed) {
        return first;
      }

      const second = await attemptGuess(modelFamily, model, messages);
      return second.failed ? first : second;
    },
  };
}

async function attemptGuess(modelFamily, model, messages) {
  try {
    const requestMessages = buildGuessMessages(messages);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENROUTER_GUESS_TIMEOUT_MS);
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: buildOpenRouterHeaders(),
      body: JSON.stringify({
        model,
        messages: requestMessages,
        max_tokens: OPENROUTER_GUESS_MAX_TOKENS,
        ...buildGuessReasoningConfig(),
        temperature: 0.4,
        top_p: 0.9,
      }),
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`OpenRouter ${response.status}: ${details.slice(0, 240)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseGuessJson(content);

    if (!parsed || (parsed.verdict !== "human" && parsed.verdict !== "ai")) {
      console.warn(
        `OpenRouter guess unparseable for ${modelFamily} (${model}): ${String(content || "").slice(0, 200)}`,
      );
      return { failed: true, source: "openrouter", model, error: "Unparseable guess." };
    }

    return {
      failed: false,
      source: "openrouter",
      model,
      verdict: parsed.verdict,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      modelFamily: parsed.model,
      reason: parsed.reason,
    };
  } catch (error) {
    console.warn(`OpenRouter guess failed for ${modelFamily} (${model}): ${error.message}`);
    return { failed: true, source: "openrouter", model, error: error.message };
  }
}

function buildGuessMessages(messages) {
  // Flatten the chat into labelled lines inside ONE user message, so the model
  // treats it as a transcript to ANALYZE rather than a conversation to continue
  // (role-mapped turns made some models just reply in character).
  const transcript = messages
    .filter((message) => message?.author !== "system" && message?.text)
    .slice(-OPENROUTER_MAX_CONTEXT_MESSAGES)
    .map((message) => `${message.author === "partner" ? "YOU" : "THEM"}: ${String(message.text).slice(0, 500)}`)
    .join("\n");

  return [
    {
      role: "system",
      content: readConfiguredPrompt("OPENROUTER_GUESS_PROMPT"),
    },
    {
      role: "user",
      content: `Transcript:\n${transcript}\n\nReturn only the JSON verdict about THEM.`,
    },
  ];
}

function parseGuessJson(content) {
  if (typeof content !== "string") {
    return null;
  }

  const text = content.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null
      ? { ...parsed, verdict: String(parsed.verdict || "").toLowerCase() }
      : null;
  } catch {
    return null;
  }
}

// By default we OMIT the reasoning field entirely and let each model use its own
// default. Some models (e.g. gemini-3.5-flash) reject reasoning:{enabled:false}
// with "Reasoning is mandatory for this endpoint", so we must not force it off.
// Set OPENROUTER_GUESS_REASONING_EFFORT to a real effort (minimal/low/medium/high)
// to opt in explicitly.
function buildGuessReasoningConfig() {
  const effort = String(process.env.OPENROUTER_GUESS_REASONING_EFFORT || "").toLowerCase();

  if (!effort || ["off", "none", "disabled", "false", "default"].includes(effort)) {
    return {};
  }

  return { reasoning: { effort } };
}

function buildFallbackReply(reply, model, error) {
  return buildAiReplyResult(reply, {
    source: "local_fallback",
    failed: true,
    error,
    model,
  });
}

function buildOpenRouterHeaders() {
  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };

  if (process.env.OPENROUTER_SITE_URL) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  }

  if (process.env.OPENROUTER_APP_NAME) {
    headers["X-Title"] = process.env.OPENROUTER_APP_NAME;
  }

  return headers;
}

function buildOpenRouterMessages(messages, persona) {
  const chat = messages
    .slice(-OPENROUTER_MAX_CONTEXT_MESSAGES)
    .filter((message) => message?.author !== "system" && message?.text)
    .map((message) => ({
      role: message.author === "partner" ? "assistant" : "user",
      content: String(message.text).slice(0, 500),
    }));
  const isOpeningTurn = !hasChatMessages(messages);

  return [
    {
      role: "system",
      content: renderChatPrompt(readConfiguredPrompt("OPENROUTER_CHAT_PROMPT"), persona, isOpeningTurn),
    },
    ...chat,
  ];
}

function readConfiguredPrompt(name) {
  const prompt = process.env[name];

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error(`${name} is not configured.`);
  }

  return prompt;
}

function renderChatPrompt(template, persona, isOpeningTurn) {
  const conditional = template.replace(
    /\{\{#(OPENING|REPLY)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, phase, text) => (phase === "OPENING") === isOpeningTurn ? text : "",
  );
  const values = {
    CLOCK_CONTEXT: buildUtcClockContext(new Date(), persona?.location),
    PERSONA_INSTRUCTIONS: buildPersonaInstructions(persona),
  };

  return conditional.replace(/\{\{([^{}]*)\}\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error("OPENROUTER_CHAT_PROMPT contains an unsupported placeholder.");
    }

    return values[key];
  });
}

function buildUtcClockContext(now = new Date(), location = null) {
  const isoTimestamp = now.toISOString();
  const weekday = UTC_WEEKDAYS[now.getUTCDay()];
  const date = isoTimestamp.slice(0, 10);
  const time = isoTimestamp.slice(11, 19);
  const localClock = buildLocalClockContext(now, location);

  return [
    "Authoritative server clock context for this request (UTC):",
    `day of week=${weekday};`,
    `date=${date};`,
    `time=${time} UTC;`,
    `ISO 8601=${isoTimestamp}.`,
    localClock,
  ].filter(Boolean).join(" ");
}

function buildLocalClockContext(now, location) {
  if (!location?.city || !location?.country || !location?.timeZone) {
    return "";
  }

  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: location.timeZone,
        weekday: "long",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(now)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );

    return [
      `Assigned-location clock context for ${location.city}, ${location.country} (${location.timeZone}):`,
      `day of week=${parts.weekday};`,
      `date=${parts.year}-${parts.month}-${parts.day};`,
      `time=${parts.hour}:${parts.minute}:${parts.second}.`,
    ].join(" ");
  } catch (error) {
    console.warn(`Unable to format AI location time for ${location.timeZone}: ${error.message}`);
    return "";
  }
}

function normalizeAiReply(value) {
  if (typeof value !== "string") {
    return "";
  }

  const cleaned = value
    .replace(/\s+/g, " ")
    // Em/en dashes are a giveaway texters don't use — turn them into commas.
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/^[\s,]+/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .slice(0, 320);

  if (!cleaned) {
    return "";
  }

  return cleaned;
}

function getModelSlug(modelFamily) {
  const envKey = `OPENROUTER_MODEL_${modelFamily.toUpperCase()}`;
  return process.env[envKey] || DEFAULT_OPENROUTER_MODELS[modelFamily] || DEFAULT_OPENROUTER_MODELS.ChatGPT;
}

// OPENROUTER_REASONING_EFFORT: "minimal" | "low" | "medium" | "high", or
// "off" to disable thinking entirely (best for snappy casual chat). Defaults to "low".
function buildReasoningConfig() {
  const effort = String(process.env.OPENROUTER_REASONING_EFFORT || "off").toLowerCase();

  if (["off", "none", "disabled", "false"].includes(effort)) {
    return { reasoning: { enabled: false } };
  }

  return { reasoning: { effort } };
}

module.exports = {
  createOpenRouterAiProvider,
};
