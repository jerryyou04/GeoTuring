const path = require("node:path");
const Module = require("node:module");
require("dotenv").config();

if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_SERVICE_ID) {
  throw new Error("dev:mock is only available for local development. Use npm start in production.");
}

// This entry point replaces storage only in this process. npm start and npm run
// dev continue to load the unchanged Postgres and Redis implementations.
const { createLocalStore } = require("./store");
const filePath = path.join(__dirname, "../.local/mock-data.json");
const local = createLocalStore({ filePath });
for (const [name, implementation] of Object.entries({ db: local.db, redis: local.redis })) {
  const filename = require.resolve(`../${name}`);
  const replacement = new Module(filename, module);
  replacement.filename = filename;
  replacement.loaded = true;
  replacement.exports = implementation;
  require.cache[filename] = replacement;
}
process.env.OPENROUTER_API_KEY = "";
console.log("LOCAL MOCK DATA: synthetic History and Leaderboard are enabled.");
console.log(`Local data file: ${filePath}`);
require("../server");
