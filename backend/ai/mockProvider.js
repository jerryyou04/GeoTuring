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

function createMockAiProvider(modelFamily, persona) {
  const lines = AI_PERSONAS[modelFamily] || AI_PERSONAS.ChatGPT;

  return {
    modelFamily,
    generateReply(messages) {
      if (!hasChatMessages(messages)) {
        return buildLocalReply(pick(OPENING_LINES));
      }

      const lastMessage = messages[messages.length - 1]?.text || "";
      const normalized = lastMessage.toLowerCase();

      if (normalized.includes("where") || normalized.includes("from")) {
        return buildLocalReply(
          persona?.regionFamiliarity
            ? `i know ${persona.regionFamiliarity} better than most places`
            : "somewhere people drink too much coffee",
        );
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

  if (persona.emojiUsage === "often") {
    return `${shaped} ${pick(["lol", "😭", "🤔"])}`;
  }

  if (persona.emojiUsage === "sometimes" && Math.random() < 0.35) {
    return `${shaped} ${pick(["lol", "🤔"])}`;
  }

  return shaped;
}

module.exports = {
  createMockAiProvider,
};
