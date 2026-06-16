const MODEL_FAMILIES = ["ChatGPT", "Gemini", "Claude", "Grok"];

const PERSONA_OPTIONS = {
  humor: ["none", "dry", "sarcastic", "goofy", "warm", "deadpan"],
  verbosity: ["very short", "short", "medium", "occasionally wordy"],
  emojiUsage: ["never", "rare", "sometimes", "often"],
  confidence: ["low", "medium", "high"],
  curiosity: ["low", "medium", "high"],
  suspicion: ["low", "medium", "high"],
  regionFamiliarity: [
    "North America",
    "South America",
    "Western Europe",
    "Eastern Europe",
    "Middle East",
    "South Asia",
    "East Asia",
    "Oceania",
  ],
};

function createConversationPersona() {
  return {
    age: randomInt(18, 65),
    humor: pick(PERSONA_OPTIONS.humor),
    verbosity: pick(PERSONA_OPTIONS.verbosity),
    emojiUsage: pick(PERSONA_OPTIONS.emojiUsage),
    confidence: pick(PERSONA_OPTIONS.confidence),
    curiosity: pick(PERSONA_OPTIONS.curiosity),
    suspicion: pick(PERSONA_OPTIONS.suspicion),
    regionFamiliarity: pick(PERSONA_OPTIONS.regionFamiliarity),
  };
}

function buildPersonaInstructions(persona) {
  if (!persona) {
    return "";
  }

  return [
    "Personality for this match:",
    `Age range cue: ${persona.age}.`,
    `Humor: ${persona.humor}.`,
    `Verbosity: ${persona.verbosity}.`,
    `Emoji usage: ${persona.emojiUsage}.`,
    `Confidence: ${persona.confidence}.`,
    `Curiosity: ${persona.curiosity}.`,
    `Suspicion: ${persona.suspicion}.`,
    `Region familiarity: ${persona.regionFamiliarity}.`,
    "Behave consistently with these traits, but do not announce them.",
    "Region familiarity means cultural references you may recognize, not your exact location.",
  ].join(" ");
}

function buildAiReplyResult(value, metadata = {}) {
  if (typeof value === "object" && value !== null && typeof value.text === "string") {
    return {
      text: value.text,
      source: value.source || metadata.source || "unknown",
      failed: Boolean(value.failed ?? metadata.failed),
      error: value.error || metadata.error || null,
      model: value.model || metadata.model || null,
    };
  }

  return {
    text: String(value || ""),
    source: metadata.source || "unknown",
    failed: Boolean(metadata.failed),
    error: metadata.error || null,
    model: metadata.model || null,
  };
}

function hasChatMessages(messages) {
  return messages.some((message) => message?.author !== "system" && message?.text);
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  MODEL_FAMILIES,
  buildAiReplyResult,
  buildPersonaInstructions,
  createConversationPersona,
  hasChatMessages,
  pick,
};
