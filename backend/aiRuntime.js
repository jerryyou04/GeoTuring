const {
  AI_SEND_DEADLINE_BUFFER_MS,
  AI_TYPING_MAX_RATIO,
  AI_TYPING_MIN_RATIO,
  AI_TYPING_WPM,
  AI_TYPING_WPM_STDDEV,
  TURN_MS,
} = require("./config");
const { clamp, randomInt } = require("./utils");

// WPM is measured against the standard of 5 characters per word (incl. spaces).
const CHARS_PER_WORD = 5;

function getAiTypingDelay(reply) {
  const text = String(reply || "");
  const chars = text.length;

  // Sample a per-message typing speed centered on the target WPM, so the same
  // bot is a bit faster or slower from message to message like a real person.
  const wpm = clamp(randomGaussian(AI_TYPING_WPM, AI_TYPING_WPM_STDDEV), 32, 95);
  const msPerChar = 60000 / (wpm * CHARS_PER_WORD);

  // Time spent reading the last message and thinking before typing starts...
  let leadInMs = randomInt(500, 1700);

  // ...and occasionally they get distracted or take a beat longer to reply.
  if (Math.random() < 0.18) {
    leadInMs += randomInt(1200, 3500);
  }

  const estimatedMs = leadInMs + chars * msPerChar;
  const minMs = TURN_MS * AI_TYPING_MIN_RATIO;
  const maxMs = TURN_MS * AI_TYPING_MAX_RATIO;

  return Math.round(clamp(estimatedMs, minMs, maxMs));
}

function randomGaussian(mean, stdDev) {
  let u = 0;
  let v = 0;

  while (u === 0) {
    u = Math.random();
  }

  while (v === 0) {
    v = Math.random();
  }

  const standardNormal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);

  return mean + standardNormal * stdDev;
}

function getAiSendDelay({ replyText, turnStartedAt, turnEndsAt, now = Date.now() }) {
  const targetTypingMs = getAiTypingDelay(replyText);
  const elapsedMs = now - turnStartedAt;
  const remainingMs = Math.max(0, turnEndsAt - now - AI_SEND_DEADLINE_BUFFER_MS);
  const delayMs = Math.min(Math.max(0, targetTypingMs - elapsedMs), remainingMs);

  return {
    delayMs,
    targetTypingMs,
  };
}

function normalizeAiReplyResult(value) {
  if (typeof value === "string") {
    return {
      text: value,
      source: "unknown",
      failed: false,
      error: null,
      model: null,
    };
  }

  if (typeof value === "object" && value !== null) {
    return {
      text: String(value.text || ""),
      source: String(value.source || "unknown"),
      failed: Boolean(value.failed),
      error: value.error ? String(value.error).slice(0, 240) : null,
      model: value.model ? String(value.model).slice(0, 120) : null,
    };
  }

  return {
    text: "",
    source: "unknown",
    failed: true,
    error: "AI provider returned no response.",
    model: null,
  };
}

function createAiResponseStatus(state, overrides = {}) {
  return {
    state,
    responseText: null,
    source: null,
    failed: false,
    error: null,
    model: null,
    delayMs: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function markAiResponseStatus(session, updates) {
  if (session.mode !== "ai") {
    return;
  }

  session.aiResponseStatus = {
    ...createAiResponseStatus(session.aiResponseStatus?.state || "idle"),
    ...session.aiResponseStatus,
    ...updates,
    updatedAt: Date.now(),
  };
}

module.exports = {
  createAiResponseStatus,
  getAiSendDelay,
  markAiResponseStatus,
  normalizeAiReplyResult,
};
