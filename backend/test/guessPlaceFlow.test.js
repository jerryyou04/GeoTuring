const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createNoGuess,
  revealSubmittedGuess,
  sanitizeSubmittedGuess,
} = require("../sanitizers");
const { scoreHumanGuess } = require("../scoring");

test("human location guesses reserve server-owned place resolution", () => {
  const guess = sanitizeSubmittedGuess({
    identityGuess: "Human",
    locationGuess: { lat: 48.8566, lng: 2.3522 },
    locationPlace: { label: "Spoofed place" },
    locationPlaceStatus: "resolved",
  });

  assert.deepEqual(guess.locationGuess, { lat: 48.8566, lng: 2.3522 });
  assert.equal(guess.locationPlace, null);
  assert.equal(guess.locationPlaceStatus, "pending");
});

test("non-location and empty guesses are immediately unavailable", () => {
  const aiGuess = sanitizeSubmittedGuess({
    identityGuess: "AI",
    locationGuess: { lat: 48.8566, lng: 2.3522 },
  });

  assert.equal(aiGuess.locationGuess, null);
  assert.equal(aiGuess.locationPlace, null);
  assert.equal(aiGuess.locationPlaceStatus, "unavailable");
  assert.equal(createNoGuess().locationPlaceStatus, "unavailable");
});

test("revealed guesses include only the server-generated place", () => {
  const guess = sanitizeSubmittedGuess({
    identityGuess: "Human",
    locationGuess: { lat: 48.8566, lng: 2.3522 },
  });

  guess.locationPlace = {
    label: "Paris, Île-de-France, France",
    city: "Paris",
    region: "Île-de-France",
    country: "France",
    countryCode: "fr",
  };
  guess.locationPlaceStatus = "resolved";

  assert.deepEqual(revealSubmittedGuess(guess).locationPlace, guess.locationPlace);
  assert.equal(revealSubmittedGuess(guess).locationPlaceStatus, "resolved");
});

test("human scoring keeps distance for points but does not announce it", () => {
  const session = {
    id: "session-1",
    players: {
      player: {
        location: { lat: 43.7, lng: -79.4, region: "Ontario", country: "Canada" },
      },
      partner: {
        location: { lat: 48.9, lng: 2.4, region: "Île-de-France", country: "France" },
      },
    },
  };
  const guess = sanitizeSubmittedGuess({
    identityGuess: "Human",
    locationGuess: { lat: 51.5, lng: -0.1 },
  });
  const result = scoreHumanGuess(session, "player", guess);

  assert.equal(typeof result.distanceKm, "number");
  assert.equal(result.guess.locationPlaceStatus, "pending");
  assert.doesNotMatch(result.explanation, /\d[\d,]*\s*km\b/i);
  assert.match(result.explanation, /how close your pin was/i);
});
