const fs = require("node:fs");
const path = require("node:path");
const { createDemoHistory, createDemoLeaderboard } = require("./fixtures");

function createLocalStore({ filePath = "", now = Date.now, demo = true } = {}) {
  const saved = filePath && fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : null;
  if (saved && (saved.version !== 1 || !Array.isArray(saved.history) || !Array.isArray(saved.players))) {
    throw new Error("Unsupported local mock data format.");
  }
  const history = (saved?.history || []).map(normalizeRecord);
  const players = new Map((saved?.players || (demo ? createDemoLeaderboard() : []))
    .map((player) => [player.playerId, player]));

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, history, players: [...players.values()] }, null, 2));
    fs.renameSync(temporaryPath, filePath);
  }

  function ensurePlayer(playerId) {
    if (!players.has(playerId)) {
      const samples = demo ? createDemoHistory(playerId, now()).map(normalizeRecord) : [];
      history.push(...samples);
      players.set(playerId, {
        playerId,
        name: null,
        games: samples.length,
        readSum: samples.reduce((sum, game) => sum + game.readEarned, 0),
      });
      persist();
    }
    return players.get(playerId);
  }

  function entries(records, includePlayerId = false) {
    return records.map((record) => {
      const { playerId, ...entry } = record;
      return structuredClone(includePlayerId ? { playerId, ...entry } : entry);
    });
  }

  function newestFirst(records) {
    return records.slice().sort((a, b) => b.playedAt.localeCompare(a.playedAt));
  }

  const db = {
    isDbEnabled: () => true,
    async initDb() { persist(); },
    async saveGameHistory(record) {
      ensurePlayer(record.playerId);
      if (history.some(game => game.playerId === record.playerId && game.sessionId === record.sessionId)) return;
      history.push(normalizeRecord({ ...record, playedAt: new Date(now()).toISOString() }));
      persist();
    },
    async getPlayerHistory(playerId, limit = 100) {
      ensurePlayer(playerId);
      return entries(newestFirst(history.filter(game => game.playerId === playerId)).slice(0, clamp(limit, 1, 200)));
    },
    async getAllHistory({ limit = 25, offset = 0, playerId = "" } = {}) {
      const filter = String(playerId).trim().toLowerCase();
      const matching = newestFirst(history.filter(game => !filter || game.playerId.toLowerCase().includes(filter)));
      const start = clamp(offset, 0);
      return { total: matching.length, games: entries(matching.slice(start, start + clamp(limit, 1, 100)), true) };
    },
    async getLeaderboardSeed() {
      const totals = new Map();
      for (const game of history) {
        const row = totals.get(game.playerId) || { playerId: game.playerId, games: 0, readSum: 0 };
        row.games++;
        row.readSum += game.readEarned;
        totals.set(game.playerId, row);
      }
      return [...totals.values()];
    },
  };

  const redis = {
    isRedisEnabled: () => true,
    async bumpPlayer(playerId, readEarned) {
      if (!playerId) return;
      const player = ensurePlayer(playerId);
      player.games++;
      player.readSum += Number.isFinite(readEarned) ? Math.round(readEarned) : 0;
      persist();
    },
    async setName(playerId, name) {
      if (!playerId) return false;
      ensurePlayer(playerId).name = name;
      persist();
      return true;
    },
    async getPlayersPage({ offset = 0, count = 25 } = {}) {
      // Redis uses reverse lexicographic member order to break score ties.
      const ranked = [...players.values()].sort((a, b) => b.games - a.games || (a.playerId < b.playerId ? 1 : a.playerId > b.playerId ? -1 : 0));
      const start = clamp(offset, 0);
      return { total: ranked.length, players: structuredClone(ranked.slice(start, start + clamp(count, 1))) };
    },
    async getTopPlayers(limit = 25) {
      return (await redis.getPlayersPage({ count: limit })).players;
    },
    async seed(rows) {
      for (const row of rows) {
        const existing = players.get(row.playerId);
        players.set(row.playerId, { ...row, name: existing?.name || null });
      }
      persist();
    },
  };

  return { db, redis };
}

function normalizeRecord(record) {
  const transcript = Array.isArray(record.transcript) ? structuredClone(record.transcript) : [];
  return {
    playerId: record.playerId,
    sessionId: record.sessionId,
    playedAt: new Date(record.playedAt).toISOString(),
    opponentType: record.opponentType,
    identityGuess: record.identityGuess ?? null,
    correctIdentity: Boolean(record.correctIdentity),
    readEarned: Number(record.readEarned ?? 0),
    readPossible: Number(record.readPossible ?? 1),
    roundType: record.roundType,
    roundEarned: Number(record.roundEarned ?? 0),
    roundPossible: Number(record.roundPossible ?? 1),
    distanceKm: record.distanceKm ?? null,
    modelFamily: record.modelFamily ?? null,
    modelFamilyGuess: record.modelFamilyGuess ?? null,
    actualRegion: record.actualRegion ?? null,
    actualCountry: record.actualCountry ?? null,
    actualLocation: record.actualLocation ?? null,
    opponentActualLocation: record.opponentActualLocation ?? null,
    guessLocation: record.guessLocation ?? null,
    guessPlace: record.guessPlace ?? null,
    opponentIdentityGuess: record.opponentIdentityGuess ?? null,
    opponentCorrectIdentity: record.opponentCorrectIdentity ?? null,
    opponentDistanceKm: record.opponentDistanceKm ?? null,
    opponentModelFamilyGuess: record.opponentModelFamilyGuess ?? null,
    opponentExplanation: record.opponentExplanation ?? null,
    opponentGuessLocation: record.opponentGuessLocation ?? null,
    opponentGuessPlace: record.opponentGuessPlace ?? null,
    transcript,
    messageCount: transcript.length,
  };
}

function clamp(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? Math.trunc(parsed) : minimum));
}

module.exports = { createLocalStore };
