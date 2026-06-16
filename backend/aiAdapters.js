const { MODEL_FAMILIES, createConversationPersona } = require("./ai/common");
const { createMockAiProvider } = require("./ai/mockProvider");
const { createOpenRouterAiProvider } = require("./ai/openRouterProvider");

function createAiProvider(modelFamily) {
  const persona = createConversationPersona();

  if (!process.env.OPENROUTER_API_KEY) {
    return createMockAiProvider(modelFamily, persona);
  }

  return createOpenRouterAiProvider(modelFamily, persona);
}

module.exports = {
  MODEL_FAMILIES,
  createAiProvider,
  createMockAiProvider,
};
