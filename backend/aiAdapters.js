const { MODEL_FAMILIES, createConversationPersona } = require("./ai/common");
const { createOpenRouterAiProvider } = require("./ai/openRouterProvider");

function createAiProvider(modelFamily) {
  const persona = createConversationPersona();

  return createOpenRouterAiProvider(modelFamily, persona);
}

module.exports = {
  MODEL_FAMILIES,
  createAiProvider,
};
