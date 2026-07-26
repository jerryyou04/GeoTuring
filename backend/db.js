const { Pool } = require("pg");

// Railway injects DATABASE_URL into the service environment. We never hardcode
// credentials — if it is absent, history persistence is simply disabled and the
// game keeps running.
const connectionString = process.env.DATABASE_URL || "";
const enabled = Boolean(connectionString);

let pool = null;

if (enabled) {
  pool = new Pool({
    connectionString,
    // Internal Railway networking (*.railway.internal) does not use TLS; the
    // public proxy does and presents a self-signed cert.
    ssl: connectionString.includes("railway.internal") ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
  });

  pool.on("error", (error) => {
    console.error("Postgres pool error:", error.message);
  });
}

function isDbEnabled() {
  return enabled;
}

async function initDb() {
  if (!enabled) {
    console.warn("DATABASE_URL not set — game history persistence is disabled.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_history (
      id BIGSERIAL PRIMARY KEY,
      player_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      played_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      opponent_type TEXT NOT NULL,
      identity_guess TEXT,
      correct_identity BOOLEAN NOT NULL,
      read_earned NUMERIC NOT NULL,
      read_possible NUMERIC NOT NULL,
      round_type TEXT NOT NULL,
      round_earned NUMERIC NOT NULL,
      round_possible NUMERIC NOT NULL,
      distance_km INTEGER,
      model_family TEXT,
      actual_region TEXT,
      actual_country TEXT,
      UNIQUE (player_id, session_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_game_history_player
      ON game_history (player_id, played_at DESC);
  `);

  // The full chat transcript (from the player's own perspective) is stored
  // alongside the scored result. Added after launch, so existing rows keep a
  // null transcript and a 0 count.
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS transcript JSONB`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0`);

  // What this player guessed for the AI's model (the actual one lives in
  // model_family), plus how their human opponent read them back.
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS model_family_guess TEXT`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_identity_guess TEXT`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_correct_identity BOOLEAN`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_distance_km INTEGER`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_model_family_guess TEXT`);
  // The AI opponent (unlike a human) explains its read of you; humans store null.
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_explanation TEXT`);

  // Resolved place metadata for both sides' committed location pins. Coordinates
  // remain separate so the map can be reconstructed while the concise JSON place
  // label can be preferred in history. Existing rows naturally remain null.
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS guess_location_lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS guess_location_lng DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS guess_place JSONB`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_guess_location_lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_guess_location_lng DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE game_history ADD COLUMN IF NOT EXISTS opponent_guess_place JSONB`);

  // Supports the admin's newest-first paginated sweep across every player.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_game_history_played_at
      ON game_history (played_at DESC);
  `);

  console.log("Game history table is ready.");
}

async function saveGameHistory(record) {
  if (!enabled) {
    return;
  }

  const transcript = Array.isArray(record.transcript) ? record.transcript : [];
  const guessLocation = normalizeHistoryLocation(record.guessLocation);
  const guessPlace = normalizeHistoryPlace(record.guessPlace);
  const opponentGuessLocation = normalizeHistoryLocation(record.opponentGuessLocation);
  const opponentGuessPlace = normalizeHistoryPlace(record.opponentGuessPlace);

  await pool.query(
    `INSERT INTO game_history (
       player_id, session_id, opponent_type, identity_guess, correct_identity,
       read_earned, read_possible, round_type, round_earned, round_possible,
       distance_km, model_family, model_family_guess, actual_region, actual_country,
       guess_location_lat, guess_location_lng, guess_place,
       opponent_identity_guess, opponent_correct_identity, opponent_distance_km,
       opponent_model_family_guess, opponent_explanation,
       opponent_guess_location_lat, opponent_guess_location_lng, opponent_guess_place,
       transcript, message_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     ON CONFLICT (player_id, session_id) DO NOTHING`,
    [
      record.playerId,
      record.sessionId,
      record.opponentType,
      record.identityGuess,
      record.correctIdentity,
      record.readEarned,
      record.readPossible,
      record.roundType,
      record.roundEarned,
      record.roundPossible,
      record.distanceKm,
      record.modelFamily,
      record.modelFamilyGuess ?? null,
      record.actualRegion,
      record.actualCountry,
      guessLocation?.lat ?? null,
      guessLocation?.lng ?? null,
      guessPlace ? JSON.stringify(guessPlace) : null,
      record.opponentIdentityGuess ?? null,
      record.opponentCorrectIdentity ?? null,
      record.opponentDistanceKm ?? null,
      record.opponentModelFamilyGuess ?? null,
      record.opponentExplanation ?? null,
      opponentGuessLocation?.lat ?? null,
      opponentGuessLocation?.lng ?? null,
      opponentGuessPlace ? JSON.stringify(opponentGuessPlace) : null,
      JSON.stringify(transcript),
      transcript.length,
    ],
  );
}

// Columns selected for both the player and admin history views. Kept in one
// place so the two queries and mapHistoryRow can't drift apart.
const HISTORY_COLUMNS = `player_id, session_id, played_at, opponent_type, identity_guess, correct_identity,
            read_earned, read_possible, round_type, round_earned, round_possible,
            distance_km, model_family, model_family_guess, actual_region, actual_country,
            guess_location_lat, guess_location_lng, guess_place,
            opponent_identity_guess, opponent_correct_identity, opponent_distance_km,
            opponent_model_family_guess, opponent_explanation,
            opponent_guess_location_lat, opponent_guess_location_lng, opponent_guess_place,
            transcript, message_count`;

// Shared row -> entry mapping so the player and admin views stay in sync.
function mapHistoryRow(row, { includePlayerId = false } = {}) {
  const entry = {
    sessionId: row.session_id,
    playedAt: row.played_at,
    opponentType: row.opponent_type,
    identityGuess: row.identity_guess,
    correctIdentity: row.correct_identity,
    readEarned: Number(row.read_earned),
    readPossible: Number(row.read_possible),
    roundType: row.round_type,
    roundEarned: Number(row.round_earned),
    roundPossible: Number(row.round_possible),
    distanceKm: row.distance_km === null ? null : Number(row.distance_km),
    modelFamily: row.model_family,
    modelFamilyGuess: row.model_family_guess,
    actualRegion: row.actual_region,
    actualCountry: row.actual_country,
    guessLocation: normalizeHistoryLocation({
      lat: row.guess_location_lat,
      lng: row.guess_location_lng,
    }),
    guessPlace: normalizeHistoryPlace(row.guess_place),
    opponentIdentityGuess: row.opponent_identity_guess,
    opponentCorrectIdentity: row.opponent_correct_identity,
    opponentDistanceKm: row.opponent_distance_km === null ? null : Number(row.opponent_distance_km),
    opponentModelFamilyGuess: row.opponent_model_family_guess,
    opponentExplanation: row.opponent_explanation,
    opponentGuessLocation: normalizeHistoryLocation({
      lat: row.opponent_guess_location_lat,
      lng: row.opponent_guess_location_lng,
    }),
    opponentGuessPlace: normalizeHistoryPlace(row.opponent_guess_place),
    messageCount: row.message_count === null ? 0 : Number(row.message_count),
    transcript: Array.isArray(row.transcript) ? row.transcript : [],
  };

  if (includePlayerId) {
    entry.playerId = row.player_id;
  }

  return entry;
}

async function getPlayerHistory(playerId, limit = 100) {
  if (!enabled) {
    return [];
  }

  const result = await pool.query(
    `SELECT ${HISTORY_COLUMNS}
       FROM game_history
      WHERE player_id = $1
      ORDER BY played_at DESC
      LIMIT $2`,
    [playerId, Math.min(Math.max(1, limit), 200)],
  );

  return result.rows.map((row) => mapHistoryRow(row));
}

// Admin sweep across every player's games, newest first, with optional filter
// on a (partial) player id. Returns the page plus the total for pagination.
async function getAllHistory({ limit = 25, offset = 0, playerId = "" } = {}) {
  if (!enabled) {
    return { total: 0, games: [] };
  }

  const pageSize = Math.min(Math.max(1, limit), 100);
  const pageOffset = Math.max(0, offset);
  const filter = String(playerId || "").trim();
  const where = filter ? `WHERE player_id ILIKE $1` : "";
  const filterParams = filter ? [`%${filter}%`] : [];

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM game_history ${where}`,
    filterParams,
  );

  const rowsResult = await pool.query(
    `SELECT ${HISTORY_COLUMNS}
       FROM game_history
       ${where}
      ORDER BY played_at DESC
      LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
    [...filterParams, pageSize, pageOffset],
  );

  return {
    total: totalResult.rows[0]?.total ?? 0,
    games: rowsResult.rows.map((row) => mapHistoryRow(row, { includePlayerId: true })),
  };
}

// Per-player aggregates used to seed the Redis leaderboard on boot.
async function getLeaderboardSeed() {
  if (!enabled) {
    return [];
  }

  const result = await pool.query(
    `SELECT player_id,
            COUNT(*)::int AS games,
            COALESCE(SUM(read_earned), 0)::int AS read_sum
       FROM game_history
      GROUP BY player_id`,
  );

  return result.rows.map((row) => ({
    playerId: row.player_id,
    games: Number(row.games),
    readSum: Number(row.read_sum),
  }));
}

function normalizeHistoryLocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const lat = normalizeCoordinate(value.lat, -90, 90);
  const lng = normalizeCoordinate(value.lng, -180, 180);

  return lat === null || lng === null ? null : { lat, lng };
}

function normalizeCoordinate(value, min, max) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeHistoryPlace(value) {
  let place = value;

  if (typeof place === "string") {
    try {
      place = JSON.parse(place);
    } catch {
      return null;
    }
  }

  if (!place || typeof place !== "object" || Array.isArray(place)) {
    return null;
  }

  const city = normalizePlaceText(place.city ?? place.locality, 160);
  const region = normalizePlaceText(place.region, 160);
  const country = normalizePlaceText(place.country, 160);
  const countryCode = normalizeCountryCode(place.countryCode);
  const label = normalizePlaceText(place.label, 320);

  if (!label) {
    return null;
  }

  return Object.fromEntries(
    Object.entries({
      label,
      city,
      region,
      country,
      countryCode,
    }).filter(([, component]) => component !== null),
  );
}

function normalizePlaceText(value, maxLength) {
  if (typeof value !== "string") {
    return null;
  }

  const text = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return text || null;
}

function normalizeCountryCode(value) {
  const code = normalizePlaceText(value, 3);

  return code && /^[a-z]{2,3}$/i.test(code) ? code.toUpperCase() : null;
}

module.exports = {
  isDbEnabled,
  initDb,
  saveGameHistory,
  getPlayerHistory,
  getAllHistory,
  getLeaderboardSeed,
};
