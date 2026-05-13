const MODEL_FAMILIES = ["GPT", "Claude", "Gemini", "Llama", "Mistral", "Other"];

const AI_PERSONAS = {
  GPT: [
    "yeah, that tracks",
    "i would probably start with the obvious clue",
    "hmm, depends how you read it",
  ],
  Claude: [
    "fair question, i need a second",
    "i think the vibe is pretty clear",
    "maybe, but i would not overfit on that",
  ],
  Gemini: [
    "could be, but there is another angle",
    "i am leaning yes on that",
    "that sounds familiar somehow",
  ],
  Llama: [
    "lol maybe",
    "i would guess from the wording",
    "not totally sure, but close",
  ],
  Mistral: [
    "short answer: probably",
    "that feels like the right neighborhood",
    "i would keep it simple",
  ],
  Other: [
    "hard to say from just that",
    "i have seen people talk like this",
    "maybe ask one more thing",
  ],
};

function createMockAiProvider(modelFamily) {
  const lines = AI_PERSONAS[modelFamily] || AI_PERSONAS.Other;

  return {
    modelFamily,
    generateReply(messages) {
      const lastMessage = messages[messages.length - 1]?.text || "";
      const normalized = lastMessage.toLowerCase();

      if (normalized.includes("where") || normalized.includes("from")) {
        return "somewhere people drink too much coffee";
      }

      if (normalized.includes("?")) {
        return pick(lines);
      }

      return pick([
        ...lines,
        "same",
        "that is a pretty specific take",
        "i get what you mean",
      ]);
    },
  };
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

module.exports = {
  MODEL_FAMILIES,
  createMockAiProvider,
};
