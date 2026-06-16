const crypto = require("crypto");

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}

function pick(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusKm * c;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

module.exports = {
  clamp,
  cryptoRandomId,
  haversineKm,
  pick,
  randomInt,
  sha256,
  sleep,
};
