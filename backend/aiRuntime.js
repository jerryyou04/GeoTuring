const {
  AI_SEND_DEADLINE_BUFFER_MS,
  AI_TYPING_MAX_RATIO,
  AI_TYPING_MIN_RATIO,
  TURN_MS,
} = require("./config");
const { clamp, randomInt } = require("./utils");

function getAiTypingDelay(reply) {
  const text = String(reply || "");
  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const estimatedTypingMs = 850 + chars * 38 + words * 95;
  const randomMultiplier = 0.72 + Math.random() * 0.58;
  const randomJitterMs = randomInt(-220, 420);
  const minMs = TURN_MS * AI_TYPING_MIN_RATIO;
  const maxMs = TURN_MS * AI_TYPING_MAX_RATIO;

  return Math.round(clamp(estimatedTypingMs * randomMultiplier + randomJitterMs, minMs, maxMs));
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
