const {
  AI_LOCK_BASE_PROB,
  AI_LOCK_PROB_GROWTH,
  AI_LOCK_PROB_MAX,
  AI_LOCK_TIME_LEFT_BUMP,
  AI_LOCK_TIME_LEFT_BUMP_MS,
  AI_LOCK_HOSTILE_PROB,
  AI_LOCK_HOSTILE_SILENT_PROB,
  AI_LOCK_INSTEAD_PROB,
  AI_LOCK_PARTING_PROB,
  AI_LOCK_DELAY_AFTER_REPLY_MS,
  AI_LOCK_DELAY_AFTER_REPLY_STDDEV_MS,
  AI_LOCK_DELAY_HOSTILE_MS,
  AI_LOCK_DELAY_HOSTILE_STDDEV_MS,
  AI_LOCK_DELAY_INSTEAD_MS,
  AI_LOCK_DELAY_INSTEAD_STDDEV_MS,
  AI_LOCK_DELAY_MIN_MS,
  AI_LOCK_DELAY_MAX_MS,
  AI_SEND_DEADLINE_BUFFER_MS,
  AI_TYPING_MAX_RATIO,
  AI_TYPING_MIN_RATIO,
  AI_TYPING_WPM,
  AI_TYPING_WPM_STDDEV,
  TURN_MS,
} = require("./config");
const { clamp, pick, randomInt } = require("./utils");

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

// Provider-agnostic hostility detection used to bias the lock decision (#4).
// Mirrors the mock provider's clapback triggers but lives here so it applies to
// every adapter, not just the mock one.
const HOSTILE_TRIGGERS = [
  "stupid", "idiot", "loser", "ugly", "shut up", "fuck you", "f you", "hate you",
  "kill", "creep", "young girl", "retard", "dumbass", "threat", "dox",
];

const LOCK_SIGNOFF_LINES = [
  "ok i've got a read, calling it",
  "alright i'm gonna guess",
  "yeah i'm good, locking it in",
  "ok that's enough for me",
  "i'll just guess from here",
  "cool, i'm ready to guess",
];

function isMessageHostile(text) {
  const normalized = String(text || "").toLowerCase();
  return HOSTILE_TRIGGERS.some((trigger) => normalized.includes(trigger));
}

// Varied delay before the lock fires. Spans into the human's turn, so it is not
// clamped to the AI turn budget — only to a sane min/max kept under TURN_MS.
function getAiLockDelay({ mode, hostile }) {
  let mean = AI_LOCK_DELAY_AFTER_REPLY_MS;
  let stdDev = AI_LOCK_DELAY_AFTER_REPLY_STDDEV_MS;

  if (hostile) {
    mean = AI_LOCK_DELAY_HOSTILE_MS;
    stdDev = AI_LOCK_DELAY_HOSTILE_STDDEV_MS;
  } else if (mode === "instead-of-reply") {
    mean = AI_LOCK_DELAY_INSTEAD_MS;
    stdDev = AI_LOCK_DELAY_INSTEAD_STDDEV_MS;
  }

  return Math.round(clamp(randomGaussian(mean, stdDev), AI_LOCK_DELAY_MIN_MS, AI_LOCK_DELAY_MAX_MS));
}

// Decides, once per eligible AI turn, whether the AI ends the chat early and how.
// Returns { lock: false } or a plan { lock, mode, viaHostile, delayMs, parting }.
//   mode "after-reply"      -> send this turn's message, then lock (#2, #4)
//   mode "instead-of-reply" -> skip the reply, optionally post a sign-off, lock (#3)
// The caller must only invoke this when the round is already guess-ready, which
// is what guarantees the AI never trips the early-abort path (#1).
function decideAiLock({ turnsSinceEligible, hostile, msLeftInChat, lockIntent = false }) {
  let prob = AI_LOCK_BASE_PROB + AI_LOCK_PROB_GROWTH * Math.max(0, turnsSinceEligible - 1);

  if (msLeftInChat <= AI_LOCK_TIME_LEFT_BUMP_MS) {
    prob += AI_LOCK_TIME_LEFT_BUMP;
  }

  prob = clamp(prob, 0, AI_LOCK_PROB_MAX);

  let lock = lockIntent || Math.random() < prob;
  let viaHostile = false;

  // A hostile message strongly biases toward an immediate drive-by lock (#4).
  if (hostile && Math.random() < AI_LOCK_HOSTILE_PROB) {
    lock = true;
    viaHostile = true;
  }

  if (!lock) {
    return { lock: false };
  }

  let mode = "after-reply";
  let parting = null;

  if (viaHostile) {
    // Not every hostile lock gets a clapback first. Sometimes the AI fires the
    // clapback (the turn's own reply) then snaps shut; sometimes it just silently
    // guesses and drops it, without dignifying the message with a reply.
    if (Math.random() < AI_LOCK_HOSTILE_SILENT_PROB) {
      mode = "instead-of-reply"; // silent — no clapback, no sign-off
    }
  } else if (Math.random() < AI_LOCK_INSTEAD_PROB) {
    // Bored / done talking: skip the reply, sometimes with a short casual sign-off.
    mode = "instead-of-reply";

    if (Math.random() < AI_LOCK_PARTING_PROB) {
      parting = pick(LOCK_SIGNOFF_LINES);
    }
  }

  return {
    lock: true,
    mode,
    viaHostile,
    delayMs: getAiLockDelay({ mode, hostile: viaHostile }),
    parting,
  };
}

module.exports = {
  createAiResponseStatus,
  decideAiLock,
  getAiLockDelay,
  getAiSendDelay,
  isMessageHostile,
  markAiResponseStatus,
  normalizeAiReplyResult,
};
