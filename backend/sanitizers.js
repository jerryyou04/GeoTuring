const { MODEL_FAMILIES } = require("./ai/common");
const { cryptoRandomId } = require("./utils");

function sanitizeSubmittedGuess(payload = {}) {
  const identityGuess = payload.identityGuess === "Human" || payload.identityGuess === "AI" ? payload.identityGuess : null;

  return {
    identityGuess,
    locationGuess: sanitizePin(payload.locationGuess),
    modelFamilyGuess: MODEL_FAMILIES.includes(payload.modelFamilyGuess) ? payload.modelFamilyGuess : null,
    submitted: Boolean(identityGuess),
  };
}

function createNoGuess() {
  return {
    identityGuess: null,
    locationGuess: null,
    modelFamilyGuess: null,
    submitted: false,
  };
}

function revealSubmittedGuess(guess) {
  if (!guess) {
    return null;
  }

  return {
    identityGuess: guess.identityGuess,
    locationGuess: guess.locationGuess,
    modelFamilyGuess: guess.modelFamilyGuess,
    submitted: guess.submitted,
  };
}

function sanitizeLocation(value = {}) {
  const location = typeof value === "object" && value !== null ? value : {};

  return {
    country: sanitizeText(location.country, "Unknown"),
    region: sanitizeText(location.region, ""),
    city: sanitizeText(location.city, ""),
    // Round to ~city-level (1 decimal ≈ 11km grid) so we never store or reveal a
    // neighborhood-precise coordinate. IP geolocation can resolve to within ~1km
    // for some ISPs; this keeps the revealed pin a general area, not a block.
    lat: roughenCoordinate(toFiniteRangeNumber(location.lat, -90, 90)),
    lng: roughenCoordinate(toFiniteRangeNumber(location.lng, -180, 180)),
    source: "ip",
  };
}

function roughenCoordinate(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function sanitizePlayerId(value) {
  if (typeof value !== "string") {
    return cryptoRandomId();
  }

  const trimmed = value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);

  return trimmed || cryptoRandomId();
}

function hasValidLocation(location) {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

function sanitizePin(value = {}) {
  const pin = typeof value === "object" && value !== null ? value : {};
  const lat = toFiniteRangeNumber(pin.lat, -90, 90);
  const lng = toFiniteRangeNumber(pin.lng, -180, 180);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    lat,
    lng,
  };
}

function sanitizeText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim().slice(0, 80);

  return trimmed || fallback;
}

function toFiniteRangeNumber(value, min, max) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number < min || number > max) {
    return null;
  }

  return number;
}

module.exports = {
  createNoGuess,
  hasValidLocation,
  revealSubmittedGuess,
  sanitizeLocation,
  sanitizePin,
  sanitizePlayerId,
  sanitizeSubmittedGuess,
};
