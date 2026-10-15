const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { createLocalStore } = require("../dev/store");
const { createLeaderboardHandler } = require("../leaderboard");
const now = () => Date.UTC(2026, 9, 14, 16);

test("local sample history covers human and AI outcomes and stays private to each player", async () => {
  const { db } = createLocalStore({ now });
  const games = await db.getPlayerHistory("local-player-one");
  assert.equal(games.length, 6);
  assert.deepEqual(new Set(games.map(game => game.opponentType)), new Set(["Human", "AI"]));
  assert.ok(games.some(game => !game.correctIdentity));
  assert.ok(games.some(game => game.roundEarned > 0 && game.roundEarned < 1));
  assert.ok(games.every(game => game.messageCount === 4 && !Object.hasOwn(game, "playerId")));
  assert.ok(games[0].playedAt > games[1].playedAt);
  assert.deepEqual(games[0].actualLocation, { lat: 44.2377, lng: -79.3832 });
  assert.deepEqual(games[0].opponentActualLocation, { lat: 45.4215, lng: -75.6972 });
  const other = await db.getPlayerHistory("local-player-two");
  assert.notEqual(other[0].sessionId, games[0].sessionId);
  assert.equal((await db.getAllHistory({playerId:"PLAYER-ONE",limit:2,offset:1})).total, 6);
  assert.equal((await db.getAllHistory({playerId:"PLAYER-ONE",limit:2,offset:1})).games.length, 2);
});

test("local completed rounds are deduplicated and preserve scores, places, and transcript", async () => {
  const { db, redis } = createLocalStore({ now, demo: false });
  const record = {playerId:"local-player",sessionId:"new-round",opponentType:"Human",identityGuess:"Human",correctIdentity:true,readEarned:1,readPossible:1,roundType:"location",roundEarned:0.83,roundPossible:1,guessLocation:{lat:43.7,lng:-79.4},guessPlace:{label:"Toronto, Canada"},transcript:[{author:"player",text:"Test message",sentAt:now()}]};
  record.actualLocation = { lat: 44.2, lng: -79.4 };
  record.opponentActualLocation = { lat: 45.4, lng: -75.7 };
  await db.saveGameHistory(record);
  await db.saveGameHistory(record);
  await redis.bumpPlayer(record.playerId, record.readEarned);
  const games = await db.getPlayerHistory(record.playerId);
  assert.equal(games.length, 1);
  assert.equal(games[0].roundEarned, 0.83);
  assert.deepEqual(games[0].guessPlace, record.guessPlace);
  assert.deepEqual(games[0].guessLocation, record.guessLocation);
  assert.deepEqual(games[0].actualLocation, record.actualLocation);
  assert.deepEqual(games[0].opponentActualLocation, record.opponentActualLocation);
  assert.equal(games[0].messageCount, 1);
  games[0].transcript[0].text = "Changed copy";
  assert.equal((await db.getPlayerHistory(record.playerId))[0].transcript[0].text, "Test message");
  assert.deepEqual(await db.getLeaderboardSeed(), [{playerId:"local-player",games:1,readSum:1}]);
  assert.equal((await redis.getTopPlayers())[0].readSum, 1);
});

test("mock leaderboard works with the existing paginated API handler", async () => {
  const { redis } = createLocalStore({ now });
  const handler = createLeaderboardHandler({ redis });
  const pages = [];
  for (const page of [1, 2]) {
    const res = {json(payload) {pages.push(payload);}};
    await handler({query:{page:String(page)}}, res);
  }
  assert.deepEqual(pages.map(page => page.players.length), [25, 7]);
  assert.equal(pages[1].players[0].rank, 26);
  assert.equal(pages[0].totalPages, 2);
  assert.ok(pages.every(page => page.enabled));
});

test("local data survives restarts and absolute leaderboard seeding preserves display names", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geoturing-mock-test-"));
  const filePath = path.join(directory, "data.json");
  t.after(() => {if (fs.existsSync(filePath)) fs.unlinkSync(filePath);fs.rmdirSync(directory);});
  const first = createLocalStore({ filePath, now });
  await first.db.getPlayerHistory("persistent-player");
  await first.redis.setName("persistent-player", "Local Tester");
  await first.redis.seed(await first.db.getLeaderboardSeed());
  await first.redis.seed(await first.db.getLeaderboardSeed());
  const second = createLocalStore({ filePath, now });
  assert.equal((await second.db.getPlayerHistory("persistent-player")).length, 6);
  assert.deepEqual((await second.db.getPlayerHistory("persistent-player"))[0].actualLocation, { lat: 44.2377, lng: -79.3832 });
  const player = (await second.redis.getTopPlayers(100)).find(player => player.playerId === "persistent-player");
  assert.equal(player.name, "Local Tester");
  assert.equal(player.games, 6);
  assert.equal(player.readSum, 4);
});

test("mock startup refuses production and Railway environments", () => {
  for (const overrides of [{NODE_ENV:"production"}, {NODE_ENV:"development", RAILWAY_SERVICE_ID:"test-service"}]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "../dev/server.js")], {
      env: {...process.env,...overrides},encoding:"utf8",timeout:5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only available for local development/);
  }
});
