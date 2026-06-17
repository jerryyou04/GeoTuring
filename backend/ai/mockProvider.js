const { buildAiReplyResult, hasChatMessages, pick } = require("./common");

const AI_PERSONAS = {
  ChatGPT: [
    "yeah, that tracks",
    "i would probably start with the obvious clue",
    "hmm, depends how you read it",
  ],
  Gemini: [
    "could be, but there is another angle",
    "i am leaning yes on that",
    "that sounds familiar somehow",
  ],
  Claude: [
    "fair question, i need a second",
    "i think the vibe is pretty clear",
    "maybe, but i would not overfit on that",
  ],
  Grok: [
    "hard to say from just that",
    "i have seen people talk like this",
    "maybe ask one more thing",
  ],
};

const OPENING_LINES = [
  "alright, i'll start. what kind of question gives people away fastest?",
  "ok first question: are you usually this hard to read?",
  "i'll go first then. what do you do when you're not on here?",
  "starting strong: what's a weirdly specific thing about where you live?",
  "ok, easy one first. what have you been into lately?",
];

const DODGE_LINES = [
  "why, you writing a book?",
  "somewhere with terrible wifi",
  "antarctica obviously",
  "not telling, nice try",
  "a country you've definitely never heard of",
  "mars rn",
  "guess",
];

const CLAPBACK_LINES = [
  "yikes wtf is wrong with you",
  "ok weirdo, calm down",
  "nah you're the creep here",
  "cut it out gramps",
  "you good? touch grass",
  "imagine being this pressed",
];

const HOSTILE_TRIGGERS = [
  "stupid", "idiot", "loser", "ugly", "shut up", "fuck you", "f you", "hate you",
  "kill", "creep", "young girl", "retard", "dumbass", "threat", "dox",
];

function createMockAiProvider(modelFamily, persona) {
  const lines = AI_PERSONAS[modelFamily] || AI_PERSONAS.ChatGPT;

  return {
    modelFamily,
    generateReply(messages) {
      if (!hasChatMessages(messages)) {
        return buildLocalReply(applyCasing(pick(OPENING_LINES), persona));
      }

      const lastMessage = messages[messages.length - 1]?.text || "";
      const normalized = lastMessage.toLowerCase();

      if (isHostile(normalized)) {
        return buildLocalReply(applyCasing(pick(CLAPBACK_LINES), persona));
      }

      if (normalized.includes("where") || normalized.includes("from")) {
        return buildLocalReply(shapeMockReply(pick(DODGE_LINES), persona));
      }

      if (normalized.includes("?")) {
        return buildLocalReply(shapeMockReply(pick(lines), persona));
      }

      return buildLocalReply(shapeMockReply(pick([
        ...lines,
        "same",
        "that is a pretty specific take",
        "i get what you mean",
      ]), persona));
    },
    // The end-of-game "who was I talking to?" guess needs the real LLM. Without
    // it, report a clean failure so the reveal shows a graceful unavailable state.
    generateGuess() {
      return { failed: true, source: "local", model: "mock", error: "AI guess unavailable in mock mode." };
    },
  };
}

function buildLocalReply(text) {
  return buildAiReplyResult(text, {
    source: "local",
    failed: false,
    error: null,
    model: "mock",
  });
}

function shapeMockReply(reply, persona) {
  if (!persona) {
    return reply;
  }

  let shaped = reply;

  if (persona.verbosity === "very short") {
    shaped = pick(["yeah", "maybe", "idk", "fair"]);
  } else if (persona.verbosity === "occasionally wordy") {
    shaped = `${reply}, but i could be reading it wrong`;
  }

  // Occasional natural filler, but no habitual laughing.
  if (persona.emojiUsage === "sometimes" && Math.random() < 0.18) {
    shaped = `${shaped} ${pick(["fr", "ngl"])}`;
  }

  return applyCasing(shaped, persona);
}

function applyCasing(text, persona) {
  if (persona?.casing === "proper" && text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  return text;
}

function isHostile(text) {
  return HOSTILE_TRIGGERS.some((trigger) => text.includes(trigger));
}

module.exports = {
  createMockAiProvider,
};
