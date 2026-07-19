const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function createLeaderboardHandler({ redis, logger = console }) {
  return async function leaderboardHandler(req, res) {
    const pagination = parsePagination(req.query);

    if (!redis.isRedisEnabled()) {
      res.json(disabledResponse(pagination));
      return;
    }

    try {
      let result = await redis.getPlayersPage({
        offset: pagination.offset,
        count: pagination.pageSize,
      });

      if (result === null) {
        res.json(disabledResponse(pagination));
        return;
      }

      let total = Math.max(0, Number(result.total) || 0);
      let totalPages = total === 0 ? 0 : Math.ceil(total / pagination.pageSize);
      const page = totalPages === 0 ? 1 : Math.min(pagination.page, totalPages);
      const offset = (page - 1) * pagination.pageSize;

      if (offset !== pagination.offset) {
        result = await redis.getPlayersPage({
          offset,
          count: pagination.pageSize,
        });

        if (result === null) {
          res.json(disabledResponse({ page, pageSize: pagination.pageSize }));
          return;
        }

        total = Math.max(0, Number(result?.total) || 0);
        totalPages = total === 0 ? 0 : Math.ceil(total / pagination.pageSize);
      }

      const players = result.players.map((row, index) => ({
        rank: offset + index + 1,
        name: row.name || autoPlayerName(row.playerId),
        games: row.games,
        readAccuracy: row.games > 0 ? row.readSum / row.games : 0,
      }));

      res.json({
        enabled: true,
        total,
        page,
        pageSize: pagination.pageSize,
        totalPages,
        players,
      });
    } catch (error) {
      logger.error("Leaderboard query failed:", error.message);
      res.status(500).json({ error: "leaderboard_unavailable" });
    }
  };
}

function parsePagination(query = {}) {
  const page = clampInt(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(query.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function autoPlayerName(playerId) {
  return `Player-${String(playerId).slice(0, 4)}`;
}

function disabledResponse({ page, pageSize }) {
  return {
    enabled: false,
    total: 0,
    page,
    pageSize,
    totalPages: 0,
    players: [],
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  createLeaderboardHandler,
  parsePagination,
};
