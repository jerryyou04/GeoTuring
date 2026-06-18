const CHAT_SECONDS = 135;
const TURN_SECONDS = 25;
const FINAL_GUESS_SECONDS = 25;

module.exports = {
  PORT: process.env.PORT || 3000,
  FRONTEND_URL: process.env.FRONTEND_URL || "*",
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
  ADMIN_API_PATH: "/admin/host-monitor",
  ADMIN_TOKEN_TTL_MS: 12 * 60 * 60 * 1000,
  // The AI "connects" after a random wait in this range, so a match feels real
  // and variable instead of a fixed beat.
  AI_CONNECT_MIN_MS: 2000,
  AI_CONNECT_MAX_MS: 40000,
  AI_SEND_DEADLINE_BUFFER_MS: 750,
  // After the chat, the AI makes its own guess about whether the human was human
  // or AI (+ location/model + a reason). Set to "false" to disable.
  AI_OPPONENT_GUESS_ENABLED: process.env.AI_OPPONENT_GUESS_ENABLED !== "false",
  // The AI can proactively "click guess" to end the chat, like a human can.
  // Probability is evaluated once per AI turn, but only once the round is
  // guess-ready (>= MIN_MESSAGES_PER_SIDE each), so the AI can never trigger
  // the early-abort path.
  AI_LOCK_BASE_PROB: 0.1, // baseline chance on the first eligible turn
  AI_LOCK_PROB_GROWTH: 0.09, // added per subsequent eligible AI turn
  AI_LOCK_PROB_MAX: 0.72, // ceiling on the per-turn chance
  AI_LOCK_TIME_LEFT_BUMP: 0.2, // extra chance when little chat time remains
  AI_LOCK_TIME_LEFT_BUMP_MS: 22000, // "little time remaining" threshold
  AI_LOCK_HOSTILE_PROB: 0.55, // chance to lock on a hostile message vs. keep fighting (#4)
  AI_LOCK_HOSTILE_SILENT_PROB: 0.4, // of those locks, share that skip the clapback and just guess
  AI_LOCK_INSTEAD_PROB: 0.3, // of non-hostile locks, share that skip a reply (#3)
  AI_LOCK_PARTING_PROB: 0.2, // chance an instead-of-reply lock posts a short sign-off (rare)
  // Lock delay has its own varied model. It spans into the human's turn, so it
  // is deliberately NOT bounded by the AI's turn budget. Kept under TURN_MS so
  // an idle human's turn-timeout can't fire the auto-abort before the lock.
  AI_LOCK_DELAY_AFTER_REPLY_MS: 2200, // beat after the final message (#2)
  AI_LOCK_DELAY_AFTER_REPLY_STDDEV_MS: 900,
  AI_LOCK_DELAY_HOSTILE_MS: 1100, // snappier angry lock (#4)
  AI_LOCK_DELAY_HOSTILE_STDDEV_MS: 450,
  AI_LOCK_DELAY_INSTEAD_MS: 3500, // "thinking... nah, i'll just guess" (#3)
  AI_LOCK_DELAY_INSTEAD_STDDEV_MS: 1400,
  AI_LOCK_DELAY_MIN_MS: 500,
  AI_LOCK_DELAY_MAX_MS: 9000,
  // Heavy bias to actively "clicking guess"; this small share instead lets the AI
  // go silent and run its 25s turn timer out, like a distracted/slow human, which
  // auto-locks. Never applied to hostile locks.
  AI_LOCK_TIMEOUT_SHARE: 0.12,
  // Endgame: when an eligible AI turn starts with less than this much chat time
  // left, it behaves like a person short on time (pure chance, no LLM): click
  // guess now, let the clock run out, or fire one quick last message.
  AI_ENDGAME_MS: 13000,
  AI_ENDGAME_LOCK_PROB: 0.4, // click guess early
  AI_ENDGAME_QUIET_PROB: 0.35, // let the clock run out (remainder = quick message)
  AI_ENDGAME_MSG_BUFFER_MS: 1500, // land the quick final message this far before the buzzer
  AI_TYPING_MAX_RATIO: 0.82,
  AI_TYPING_MIN_RATIO: 0.05,
  AI_TYPING_WPM: Number(process.env.AI_TYPING_WPM) || 60,
  AI_TYPING_WPM_STDDEV: Number(process.env.AI_TYPING_WPM_STDDEV) || 14,
  CHAT_SECONDS,
  CHAT_MS: CHAT_SECONDS * 1000,
  FINAL_GUESS_SECONDS,
  FINAL_GUESS_MS: FINAL_GUESS_SECONDS * 1000,
  GUESS_GRACE_SECONDS: 300,
  MIN_MESSAGES_PER_SIDE: 2,
  TURN_SECONDS,
  TURN_MS: TURN_SECONDS * 1000,
};
