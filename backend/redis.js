const Redis = require("ioredis");

// Railway injects REDIS_URL. If absent, the leaderboard is simply disabled and
// the game runs normally — every op below no-ops / returns null on any failure,
// so Redis can never block gameplay (mirrors db.js's isDbEnabled gating).
const connectionString = process.env.REDIS_URL || "";
const enabled = Boolean(connectionString);

const GAMES_KEY = "lb:games"; // ZSET playerId -> games played
const READ_KEY = "lb:read"; // HASH playerId -> sum(read_earned)
const NAMES_KEY = "lb:names"; // HASH playerId -> display name

let client = null;
let loggedError = false;

if (enabled) {
  client = new Redis(connectionString, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 300, 3000),
  });

  client.on("error", (error) => {
    if (!loggedError) {
      console.error("Redis error:", error.message);
      loggedError = true;
    }
  });

  client.on("ready", () => {
    loggedError = false;
    console.log("Redis connected — leaderboard enabled.");
  });
} else {
  console.warn("REDIS_URL not set — leaderboard is disabled.");
}

function isRedisEnabled() {
  return enabled;
}

// One game finished for this player: +1 game, += their identity-read score (0/1).
async function bumpPlayer(playerId, readEarned) {
  if (!enabled || !playerId) {
    return;
  }

  try {
    const read = Number.isFinite(readEarned) ? Math.round(readEarned) : 0;
    await client.multi().zincrby(GAMES_KEY, 1, playerId).hincrby(READ_KEY, playerId, read).exec();
  } catch (error) {
    console.warn("Redis bumpPlayer failed:", error.message);
  }
}

async function setName(playerId, name) {
  if (!enabled || !playerId) {
    return false;
  }

  try {
    await client.hset(NAMES_KEY, playerId, name);
    return true;
  } catch (error) {
    console.warn("Redis setName failed:", error.message);
    return false;
  }
}

// One leaderboard page by games played, joined with read sums + chosen names.
// The total covers the full sorted set so callers can expose every player via
// pagination. null on failure.
async function getPlayersPage({ offset = 0, count = 25 } = {}) {
  if (!enabled) {
    return null;
  }

  try {
    return await queryPlayersPage(client, { offset, count });
  } catch (error) {
    console.warn("Redis getPlayersPage failed:", error.message);
    return null;
  }
}

async function queryPlayersPage(redisClient, { offset = 0, count = 25 } = {}) {
  const start = normalizeInt(offset, 0, 0);
  const pageSize = normalizeInt(count, 25, 1);
  const [totalValue, flat] = await Promise.all([
    redisClient.zcard(GAMES_KEY),
    redisClient.zrevrange(GAMES_KEY, start, start + pageSize - 1, "WITHSCORES"),
  ]);

  const ids = [];
  const games = [];
  for (let i = 0; i < flat.length; i += 2) {
    ids.push(flat[i]);
    games.push(Number(flat[i + 1]));
  }

  if (ids.length === 0) {
    return { total: Number(totalValue) || 0, players: [] };
  }

  const reads = await redisClient.hmget(READ_KEY, ...ids);
  const names = await redisClient.hmget(NAMES_KEY, ...ids);

  return {
    total: Number(totalValue) || 0,
    players: ids.map((id, i) => ({
      playerId: id,
      games: games[i],
      readSum: Number(reads[i]) || 0,
      name: names[i] || null,
    })),
  };
}

// Kept for callers that only need the first page.
async function getTopPlayers(limit = 25) {
  const result = await getPlayersPage({ offset: 0, count: limit });
  return result ? result.players : null;
}

function normalizeInt(value, fallback, min) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.trunc(parsed));
}

// Idempotent absolute seed from Postgres (source of truth) — safe to re-run on
// every boot; self-heals if Redis was wiped.
async function seed(rows) {
  if (!enabled || !Array.isArray(rows) || rows.length === 0) {
    return;
  }

  try {
    const pipeline = client.pipeline();
    for (const row of rows) {
      pipeline.zadd(GAMES_KEY, row.games, row.playerId);
      pipeline.hset(READ_KEY, row.playerId, row.readSum);
    }
    await pipeline.exec();
    console.log(`Leaderboard seeded from ${rows.length} players.`);
  } catch (error) {
    console.warn("Redis seed failed:", error.message);
  }
}

module.exports = {
  isRedisEnabled,
  bumpPlayer,
  setName,
  getPlayersPage,
  getTopPlayers,
  queryPlayersPage,
  seed,
};
