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

  console.log("Game history table is ready.");
}

async function saveGameHistory(record) {
  if (!enabled) {
    return;
  }

  await pool.query(
    `INSERT INTO game_history (
       player_id, session_id, opponent_type, identity_guess, correct_identity,
       read_earned, read_possible, round_type, round_earned, round_possible,
       distance_km, model_family, actual_region, actual_country
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      record.actualRegion,
      record.actualCountry,
    ],
  );
}

async function getPlayerHistory(playerId, limit = 100) {
  if (!enabled) {
    return [];
  }

  const result = await pool.query(
    `SELECT session_id, played_at, opponent_type, identity_guess, correct_identity,
            read_earned, read_possible, round_type, round_earned, round_possible,
            distance_km, model_family, actual_region, actual_country
       FROM game_history
      WHERE player_id = $1
      ORDER BY played_at DESC
      LIMIT $2`,
    [playerId, Math.min(Math.max(1, limit), 200)],
  );

  return result.rows.map((row) => ({
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
    actualRegion: row.actual_region,
    actualCountry: row.actual_country,
  }));
}

module.exports = {
  isDbEnabled,
  initDb,
  saveGameHistory,
  getPlayerHistory,
};
