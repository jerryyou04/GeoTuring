// Synthetic records for local UI development; no production data is copied.
function createDemoHistory(playerId, now) {
  const rounds = [
    { opponentType: "Human", identityGuess: "Human", correctIdentity: true, roundEarned: 0.94, distanceKm: 65, actualRegion: "Ontario", actualCountry: "Canada", guessPlace: { label: "Toronto, Ontario, Canada" }, opponentIdentityGuess: "Human", opponentCorrectIdentity: true, opponentDistanceKm: 180 },
    { opponentType: "AI", identityGuess: "AI", correctIdentity: true, roundEarned: 0, modelFamily: "Claude", modelFamilyGuess: "ChatGPT", opponentIdentityGuess: "Human", opponentCorrectIdentity: true, opponentExplanation: "The specific follow-up questions sounded like a person." },
    { opponentType: "Human", identityGuess: "AI", correctIdentity: false, roundEarned: 0, modelFamilyGuess: "Grok", actualRegion: "Berlin", actualCountry: "Germany", opponentIdentityGuess: "AI", opponentCorrectIdentity: false, opponentModelFamilyGuess: "Gemini" },
    { opponentType: "AI", identityGuess: "Human", correctIdentity: false, roundEarned: 0, modelFamily: "Gemini", guessPlace: { label: "Sydney, New South Wales, Australia" }, opponentIdentityGuess: "Human", opponentCorrectIdentity: true, opponentExplanation: "You gave a personal preference and changed the subject naturally." },
    { opponentType: "Human", identityGuess: "Human", correctIdentity: true, roundEarned: 0.28, distanceKm: 3900, actualRegion: "British Columbia", actualCountry: "Canada", guessPlace: { label: "Montréal, Québec, Canada" }, opponentIdentityGuess: "Human", opponentCorrectIdentity: true, opponentDistanceKm: 750 },
    { opponentType: "AI", identityGuess: "AI", correctIdentity: true, roundEarned: 1, modelFamily: "ChatGPT", modelFamilyGuess: "ChatGPT", opponentIdentityGuess: "AI", opponentCorrectIdentity: false, opponentModelFamilyGuess: "Claude", opponentExplanation: "Your concise answers seemed unusually consistent." },
  ];
  const conversations = [
    ["What does your usual morning look like?", "Coffee, then the streetcar to work.", "Is it getting cold there yet?", "A little. The lake makes the wind feel worse."],
    ["What would you make for dinner?", "Probably pasta. Easy to make with whatever is left.", "Any ingredient you always add?", "Garlic. Hard to go wrong with that."],
    ["What is near your apartment?", "A bakery and a very noisy tram stop.", "Do you go to the bakery often?", "Every Saturday. The bread is worth the queue."],
    ["Do you prefer a big city or a small town?", "A city, mostly for the variety of food and transport.", "What would you miss most in a small town?", "Being able to walk to a late-night restaurant."],
    ["What do you do on weekends?", "Hike when it isn't raining, which is not often.", "Mountains or flatter trails?", "Mountains. The views make the climb worth it."],
    ["Tell me about something you learned recently.", "I learned that small changes to a routine can make it easier to stick with.", "Can you give a specific example?", "Putting a book by the kettle so I read while the water boils."],
  ];
  const locations = [
    { guessLocation: { lat: 43.6532, lng: -79.3832 }, actualLocation: { lat: 44.2377, lng: -79.3832 }, opponentGuessLocation: { lat: 45.5019, lng: -73.5674 }, opponentActualLocation: { lat: 45.4215, lng: -75.6972 } },
    { opponentGuessLocation: { lat: 45.5019, lng: -73.5674 }, opponentActualLocation: { lat: 45.4215, lng: -75.6972 }, opponentDistanceKm: 166 },
    { actualLocation: { lat: 52.52, lng: 13.405 }, opponentActualLocation: { lat: 45.4215, lng: -75.6972 } },
    { guessLocation: { lat: -33.8688, lng: 151.2093 }, opponentGuessLocation: { lat: 45.5019, lng: -73.5674 }, opponentActualLocation: { lat: 45.4215, lng: -75.6972 }, opponentDistanceKm: 166 },
    { guessLocation: { lat: 45.5019, lng: -73.5674 }, actualLocation: { lat: 49.2827, lng: -123.1207 }, opponentGuessLocation: { lat: 40.7128, lng: -74.006 }, opponentActualLocation: { lat: 45.4215, lng: -75.6972 } },
    { opponentActualLocation: { lat: 45.4215, lng: -75.6972 } },
  ];
  return rounds.map((round, index) => {
    const playedAt = now - (index + 1) * 45 * 60 * 1000;
    return {
      playerId,
      sessionId: `demo-${playerId}-${index + 1}`,
      playedAt: new Date(playedAt).toISOString(),
      readEarned: Number(round.correctIdentity),
      readPossible: 1,
      roundPossible: 1,
      roundType: round.opponentType === "Human" ? "location" : "modelFamily",
      ...round,
      ...locations[index],
      transcript: conversations[index].map((text, messageIndex) => ({
        id: `demo-${index}-${messageIndex}`,
        author: messageIndex % 2 === 0 ? "player" : "partner",
        text,
        sentAt: playedAt - 120000 + messageIndex * 25000,
      })),
    };
  });
}

function createDemoLeaderboard() {
  const names = ["Northstar", "Atlas", "MapReader", "BlueHour", "Switchback", "Meridian", "Signal", "Waypoint"];
  return Array.from({ length: 32 }, (_, index) => {
    const games = 40 - index;
    return {
      playerId: `demo_player_${String(index + 1).padStart(2, "0")}`,
      name: `${names[index % names.length]}${index < names.length ? "" : index + 1}`,
      games,
      readSum: Math.round(games * (0.45 + (index % 6) * 0.08)),
    };
  });
}

module.exports = { createDemoHistory, createDemoLeaderboard };
