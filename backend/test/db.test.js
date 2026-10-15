const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("history persistence stores and maps guesses, actual locations, and legacy rows", async (t) => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLoad = Module._load;
  const dbPath = require.resolve("../db");
  let fakePool = null;

  class FakePool {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.historyRows = [];
      fakePool = this;
    }

    on() {}

    async query(text, params = []) {
      this.calls.push({ text, params });

      if (/FROM game_history\s+WHERE player_id/.test(text)) {
        return { rows: this.historyRows };
      }

      return { rows: [] };
    }
  }

  process.env.DATABASE_URL = "postgres://test:test@example.invalid/geoturing";
  Module._load = function loadWithFakePg(request, parent, isMain) {
    if (request === "pg") {
      return { Pool: FakePool };
    }

    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[dbPath];

  const db = require("../db");

  Module._load = originalLoad;
  t.after(() => {
    delete require.cache[dbPath];

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  await db.initDb();

  const migrationSql = fakePool.calls.map((call) => call.text).join("\n");

  assert.match(migrationSql, /guess_location_lat DOUBLE PRECISION/);
  assert.match(migrationSql, /guess_location_lng DOUBLE PRECISION/);
  assert.match(migrationSql, /guess_place JSONB/);
  assert.match(migrationSql, /opponent_guess_location_lat DOUBLE PRECISION/);
  assert.match(migrationSql, /opponent_guess_location_lng DOUBLE PRECISION/);
  assert.match(migrationSql, /opponent_guess_place JSONB/);
  assert.match(migrationSql, /actual_location_lat DOUBLE PRECISION/);
  assert.match(migrationSql, /actual_location_lng DOUBLE PRECISION/);
  assert.match(migrationSql, /opponent_actual_location_lat DOUBLE PRECISION/);
  assert.match(migrationSql, /opponent_actual_location_lng DOUBLE PRECISION/);

  await db.saveGameHistory({
    playerId: "player-123",
    sessionId: "session-123",
    opponentType: "Human",
    identityGuess: "Human",
    correctIdentity: true,
    readEarned: 1,
    readPossible: 1,
    roundType: "location",
    roundEarned: 0.9,
    roundPossible: 1,
    distanceKm: 135,
    modelFamily: null,
    modelFamilyGuess: null,
    actualRegion: "Ontario",
    actualCountry: "Canada",
    actualLocation: { lat: "44.2377", lng: -79.3832 },
    opponentActualLocation: { lat: 0, lng: 0 },
    guessLocation: { lat: "43.6532", lng: -79.3832 },
    guessPlace: {
      city: "  Toronto ",
      region: "",
      country: " Canada ",
      countryCode: " ca ",
      label: " Toronto, Canada ",
      ignoredProviderField: "must not persist",
    },
    opponentIdentityGuess: "Human",
    opponentCorrectIdentity: true,
    opponentDistanceKm: 75,
    opponentModelFamilyGuess: null,
    opponentExplanation: null,
    opponentGuessLocation: { lat: 45.5019, lng: "-73.5674" },
    opponentGuessPlace: {
      locality: "Montréal",
      region: "Québec",
      country: "Canada",
      countryCode: "ca",
      label: "Montréal, Québec, Canada",
    },
    transcript: [{ author: "player", text: "hello", sentAt: 1 }],
  });

  const insertCall = fakePool.calls.find((call) => /INSERT INTO game_history/.test(call.text));

  assert.ok(insertCall);
  assert.equal(insertCall.params.length, 32);
  assert.deepEqual(insertCall.params.slice(28), [44.2377, -79.3832, 0, 0]);
  assert.equal(insertCall.params[15], 43.6532);
  assert.equal(insertCall.params[16], -79.3832);
  assert.deepEqual(JSON.parse(insertCall.params[17]), {
    label: "Toronto, Canada",
    city: "Toronto",
    country: "Canada",
    countryCode: "CA",
  });
  assert.equal(insertCall.params[23], 45.5019);
  assert.equal(insertCall.params[24], -73.5674);
  assert.deepEqual(JSON.parse(insertCall.params[25]), {
    label: "Montréal, Québec, Canada",
    city: "Montréal",
    region: "Québec",
    country: "Canada",
    countryCode: "CA",
  });

  await db.saveGameHistory({
    playerId: "invalid-player",
    sessionId: "invalid-session",
    guessLocation: { lat: 91, lng: 20 },
    guessPlace: { city: "Nowhere" },
    opponentGuessLocation: { lat: 20, lng: Number.NaN },
    opponentGuessPlace: [],
    actualLocation: { lat: null, lng: 0 },
    opponentActualLocation: { lat: 45, lng: 181 },
  });

  const invalidInsert = fakePool.calls.filter((call) => /INSERT INTO game_history/.test(call.text)).at(-1);

  assert.deepEqual(invalidInsert.params.slice(15, 18), [null, null, null]);
  assert.deepEqual(invalidInsert.params.slice(23, 26), [null, null, null]);
  assert.deepEqual(invalidInsert.params.slice(28), [null, null, null, null]);

  fakePool.historyRows = [{
    player_id: "player-123",
    session_id: "session-123",
    played_at: new Date("2026-07-25T20:00:00.000Z"),
    opponent_type: "Human",
    identity_guess: "Human",
    correct_identity: true,
    read_earned: "1",
    read_possible: "1",
    round_type: "location",
    round_earned: "0.9",
    round_possible: "1",
    distance_km: 135,
    model_family: null,
    model_family_guess: null,
    actual_region: "Ontario",
    actual_country: "Canada",
    actual_location_lat: "44.2377",
    actual_location_lng: "-79.3832",
    opponent_actual_location_lat: 0,
    opponent_actual_location_lng: 0,
    guess_location_lat: "43.6532",
    guess_location_lng: "-79.3832",
    guess_place: {
      locality: "Toronto",
      region: null,
      country: "Canada",
      label: "Toronto, Canada",
      raw: "discard me",
    },
    opponent_identity_guess: "Human",
    opponent_correct_identity: true,
    opponent_distance_km: 75,
    opponent_model_family_guess: null,
    opponent_explanation: null,
    opponent_guess_location_lat: 45.5019,
    opponent_guess_location_lng: null,
    opponent_guess_place: JSON.stringify({
      city: "Montréal",
      region: "Québec",
      country: "Canada",
      countryCode: "ca",
      label: "Montréal, Québec, Canada",
    }),
    transcript: [],
    message_count: 0,
  }];

  const [entry] = await db.getPlayerHistory("player-123");
  assert.deepEqual(entry.actualLocation, { lat: 44.2377, lng: -79.3832 });
  assert.deepEqual(entry.opponentActualLocation, { lat: 0, lng: 0 });
  const selectCall = fakePool.calls.find(call => /SELECT player_id, session_id/.test(call.text));
  assert.match(selectCall.text, /actual_location_lat, actual_location_lng/);
  assert.match(selectCall.text, /opponent_actual_location_lat, opponent_actual_location_lng/);

  assert.deepEqual(entry.guessLocation, { lat: 43.6532, lng: -79.3832 });
  assert.deepEqual(entry.guessPlace, {
    label: "Toronto, Canada",
    city: "Toronto",
    country: "Canada",
  });
  assert.equal(entry.opponentGuessLocation, null);
  assert.deepEqual(entry.opponentGuessPlace, {
    label: "Montréal, Québec, Canada",
    city: "Montréal",
    region: "Québec",
    country: "Canada",
    countryCode: "CA",
  });

  // Existing rows have no actual coordinates. Never coerce nulls to (0, 0).
  Object.assign(fakePool.historyRows[0], {
    actual_location_lat: null, actual_location_lng: null,
    opponent_actual_location_lat: undefined, opponent_actual_location_lng: undefined,
  });
  const [legacy] = await db.getPlayerHistory("player-123");
  assert.equal(legacy.actualLocation, null);
  assert.equal(legacy.opponentActualLocation, null);
});
