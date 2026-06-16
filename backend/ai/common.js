const MODEL_FAMILIES = ["ChatGPT", "Gemini", "Claude", "Grok"];

const PERSONA_OPTIONS = {
  humor: ["none", "dry", "sarcastic", "goofy", "warm", "deadpan"],
  verbosity: ["very short", "short", "medium", "occasionally wordy"],
  confidence: ["low", "medium", "high"],
  curiosity: ["low", "medium", "high"],
  suspicion: ["low", "medium", "high"],
};

// Weighted so real-person defaults dominate: emoji is usually off, casing leans
// toward lowercase texting, and punctuation leans light.
const WEIGHTED_OPTIONS = {
  emojiUsage: [["never", 4], ["rare", 4], ["sometimes", 2]],
  casing: [["lowercase", 3], ["proper", 2]],
  punctuation: [["minimal", 3], ["casual", 3], ["standard", 1]],
};

const CASING_INSTRUCTIONS = {
  lowercase: "type in all lowercase like casual texting and basically never capitalize, not even the first word",
  proper: "use normal sentence capitalization",
};

const PUNCTUATION_INSTRUCTIONS = {
  minimal: "use barely any punctuation, usually no period at the end, and never semicolons or em dashes",
  casual: "use light, casual punctuation and feel free to drop the ending period",
  standard: "use normal punctuation but stay casual, never formal or essay-like",
};

const EMOJI_INSTRUCTIONS = {
  never: "do not use any emoji at all this whole match",
  rare: "almost never use emoji, and only the rare time something genuinely deserves a reaction",
  sometimes: "use an emoji once in a while, only when it truly fits a reaction, and keep most messages emoji-free",
};

function createConversationPersona() {
  return {
    age: youngLeaningAge(),
    humor: pick(PERSONA_OPTIONS.humor),
    verbosity: pick(PERSONA_OPTIONS.verbosity),
    emojiUsage: pickWeighted(WEIGHTED_OPTIONS.emojiUsage),
    casing: pickWeighted(WEIGHTED_OPTIONS.casing),
    punctuation: pickWeighted(WEIGHTED_OPTIONS.punctuation),
    confidence: pick(PERSONA_OPTIONS.confidence),
    curiosity: pick(PERSONA_OPTIONS.curiosity),
    suspicion: pick(PERSONA_OPTIONS.suspicion),
  };
}

function buildPersonaInstructions(persona) {
  if (!persona) {
    return "";
  }

  return [
    "Personality for this match (stay consistent with these, but never announce or describe them):",
    `Rough age: ${persona.age}.`,
    `Humor: ${persona.humor}.`,
    `Verbosity: ${persona.verbosity}, and vary your message length so some replies are just one or two words.`,
    `Capitalization: ${CASING_INSTRUCTIONS[persona.casing]}, and keep that exact style for the entire conversation.`,
    `Punctuation: ${PUNCTUATION_INSTRUCTIONS[persona.punctuation]}.`,
    `Emoji: ${EMOJI_INSTRUCTIONS[persona.emojiUsage]}.`,
    `Confidence: ${persona.confidence}.`,
    `Curiosity: ${persona.curiosity}.`,
    `Suspicion: ${persona.suspicion}.`,
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

function pickWeighted(weightedValues) {
  const total = weightedValues.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;

  for (const [value, weight] of weightedValues) {
    roll -= weight;

    if (roll < 0) {
      return value;
    }
  }

  return weightedValues[weightedValues.length - 1][0];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Skew toward gen z, but keep a tail of older personas so it is not a giveaway.
function youngLeaningAge() {
  return Math.random() < 0.75 ? randomInt(16, 26) : randomInt(27, 45);
}

module.exports = {
  MODEL_FAMILIES,
  buildAiReplyResult,
  buildPersonaInstructions,
  createConversationPersona,
  hasChatMessages,
  pick,
  pickWeighted,
};
