const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  createLeaderboardHandler,
  parsePagination,
} = require("../leaderboard");
const { queryPlayersPage } = require("../redis");

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test("leaderboard pagination defaults and clamps query values", () => {
  assert.deepEqual(parsePagination({}), {
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    offset: 0,
  });
  assert.deepEqual(parsePagination({ page: "3", pageSize: "500" }), {
    page: 3,
    pageSize: MAX_PAGE_SIZE,
    offset: 200,
  });
  assert.deepEqual(parsePagination({ page: "-2", pageSize: "0" }), {
    page: 1,
    pageSize: 1,
    offset: 0,
  });
});

test("leaderboard handler requests the selected Redis slice and returns global ranks", async () => {
  const calls = [];
  const redis = {
    isRedisEnabled: () => true,
    async getPlayersPage(options) {
      calls.push(options);
      return {
        total: 5,
        players: [
          { playerId: "player-c", games: 8, readSum: 6, name: "Casey" },
          { playerId: "player-d", games: 4, readSum: 1, name: null },
        ],
      };
    },
  };
  const response = createResponse();
  const handler = createLeaderboardHandler({ redis });

  await handler({ query: { page: "2", pageSize: "2" } }, response);

  assert.deepEqual(calls, [{ offset: 2, count: 2 }]);
  assert.deepEqual(response.payload, {
    enabled: true,
    total: 5,
    page: 2,
    pageSize: 2,
    totalPages: 3,
    players: [
      { rank: 3, name: "Casey", games: 8, readAccuracy: 0.75 },
      { rank: 4, name: "Player-play", games: 4, readAccuracy: 0.25 },
    ],
  });
});

test("leaderboard handler returns pagination metadata when Redis is disabled", async () => {
  const redis = {
    isRedisEnabled: () => false,
    getPlayersPage: () => assert.fail("disabled leaderboard must not query Redis"),
  };
  const response = createResponse();
  const handler = createLeaderboardHandler({ redis });

  await handler({ query: { page: "4", pageSize: "40" } }, response);

  assert.deepEqual(response.payload, {
    enabled: false,
    total: 0,
    page: 4,
    pageSize: 40,
    totalPages: 0,
    players: [],
  });
});

test("leaderboard handler redirects an out-of-range page to the final populated page", async () => {
  const calls = [];
  const redis = {
    isRedisEnabled: () => true,
    async getPlayersPage(options) {
      calls.push(options);

      if (options.offset === 8) {
        return { total: 5, players: [] };
      }

      return {
        total: 5,
        players: [{ playerId: "player-e", games: 1, readSum: 1, name: "E" }],
      };
    },
  };
  const response = createResponse();
  const handler = createLeaderboardHandler({ redis });

  await handler({ query: { page: "5", pageSize: "2" } }, response);

  assert.deepEqual(calls, [
    { offset: 8, count: 2 },
    { offset: 4, count: 2 },
  ]);
  assert.equal(response.payload.page, 3);
  assert.equal(response.payload.totalPages, 3);
  assert.deepEqual(response.payload.players, [
    { rank: 5, name: "E", games: 1, readAccuracy: 1 },
  ]);
});

test("leaderboard pagination exposes every player across full and partial pages", async () => {
  const allPlayers = Array.from({ length: 51 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    games: 100 - index,
    readSum: 50,
    name: `Player ${index + 1}`,
  }));
  const redis = {
    isRedisEnabled: () => true,
    async getPlayersPage({ offset, count }) {
      return {
        total: allPlayers.length,
        players: allPlayers.slice(offset, offset + count),
      };
    },
  };
  const handler = createLeaderboardHandler({ redis });
  const pages = [];

  for (let page = 1; page <= 3; page += 1) {
    const response = createResponse();
    await handler({ query: { page: String(page), pageSize: "25" } }, response);
    pages.push(response.payload);
  }

  assert.deepEqual(pages.map((page) => page.players.length), [25, 25, 1]);
  assert.deepEqual(
    pages.flatMap((page) => page.players.map((player) => player.rank)),
    Array.from({ length: 51 }, (_, index) => index + 1),
  );
  assert.equal(pages.every((page) => page.total === 51 && page.totalPages === 3), true);
});

test("Redis leaderboard query uses offset and count while returning the full total", async () => {
  const calls = [];
  const redisClient = {
    zcard(key) {
      calls.push(["zcard", key]);
      return Promise.resolve("73");
    },
    zrevrange(key, start, stop, withScores) {
      calls.push(["zrevrange", key, start, stop, withScores]);
      return Promise.resolve(["player-z", "11", "player-y", "9"]);
    },
    hmget(key, ...ids) {
      calls.push(["hmget", key, ...ids]);
      if (key === "lb:read") {
        return Promise.resolve(["8", "3"]);
      }
      return Promise.resolve(["Zed", null]);
    },
  };

  const result = await queryPlayersPage(redisClient, { offset: 25, count: 25 });

  assert.deepEqual(calls, [
    ["zcard", "lb:games"],
    ["zrevrange", "lb:games", 25, 49, "WITHSCORES"],
    ["hmget", "lb:read", "player-z", "player-y"],
    ["hmget", "lb:names", "player-z", "player-y"],
  ]);
  assert.deepEqual(result, {
    total: 73,
    players: [
      { playerId: "player-z", games: 11, readSum: 8, name: "Zed" },
      { playerId: "player-y", games: 9, readSum: 3, name: null },
    ],
  });
});
