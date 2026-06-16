const { haversineKm } = require("./utils");

function scoreHumanGuess(session, socketId, guess) {
  const player = session.players[socketId];
  const partnerSocketId = getHumanPartnerSocketId(session, socketId);
  const partner = partnerSocketId ? session.players[partnerSocketId] : null;

  if (!player || !partner) {
    return null;
  }

  return buildScoreResult({
    session,
    guess,
    actualParticipant: {
      kind: "Human",
      location: partner.location,
    },
  });
}

function scoreAiGuess(session, guess) {
  return buildScoreResult({
    session,
    guess,
    actualParticipant: session.participant,
  });
}

function buildScoreResult({ session, guess, actualParticipant }) {
  const actualType = actualParticipant.kind;
  const identityGuess = guess.identityGuess === "Human" || guess.identityGuess === "AI" ? guess.identityGuess : null;
  const correctIdentity = identityGuess === actualType;
  const readScore = correctIdentity ? 1 : 0;
  const roundType = actualType === "Human" ? "location" : "modelFamily";
  const roundPossible = actualType === "Human" ? 100 : 1;
  let distanceKm = null;
  let roundScore = 0;

  if (
    actualType === "Human" &&
    identityGuess === "Human" &&
    Number.isFinite(guess.locationGuess?.lat) &&
    Number.isFinite(guess.locationGuess?.lng) &&
    Number.isFinite(actualParticipant.location?.lat) &&
    Number.isFinite(actualParticipant.location?.lng)
  ) {
    distanceKm = haversineKm(
      guess.locationGuess.lat,
      guess.locationGuess.lng,
      actualParticipant.location.lat,
      actualParticipant.location.lng,
    );
    roundScore = Math.max(0, Math.round(100 * (1 - distanceKm / 10000)));
  }

  if (
    actualType === "AI" &&
    identityGuess === "AI" &&
    guess.modelFamilyGuess === session.participant.modelFamily
  ) {
    roundScore = 1;
  }

  return {
    sessionId: session.id,
    correctIdentity,
    score: {
      read: {
        earned: readScore,
        possible: 1,
      },
      round: {
        earned: roundScore,
        possible: roundPossible,
        type: roundType,
      },
    },
    distanceKm: distanceKm === null ? null : Math.round(distanceKm),
    guess: {
      identityGuess,
      locationGuess: guess.locationGuess,
      modelFamilyGuess: guess.modelFamilyGuess,
      submitted: Boolean(guess.submitted),
    },
    actual: revealParticipant(actualParticipant),
    explanation: buildExplanation(actualParticipant, correctIdentity, distanceKm),
  };
}

function revealParticipant(participant) {
  if (participant.kind === "Human") {
    const location = participant.location || {};

    return {
      participantType: "Human",
      region: location.region,
      country: location.country,
      lat: location.lat,
      lng: location.lng,
    };
  }

  return {
    participantType: "AI",
    modelFamily: participant.modelFamily,
  };
}

function buildExplanation(participant, correctIdentity, distanceKm) {
  if (participant.kind === "Human") {
    const location = participant.location || {};
    const place = [location.region, location.country].filter(Boolean).join(", ") || "the partner's rough location";
    const locationText =
      distanceKm === null
        ? "Your round score is 0/100 because no valid human-location comparison was available."
        : `Your location score is based on a pin ${Math.round(distanceKm)} km from ${place}.`;

    return `${correctIdentity ? "You called the identity correctly." : "The identity read was off."} ${locationText}`;
  }

  return `${correctIdentity ? "You spotted the AI." : "The identity read was off."} The AI round score is 1/1 only for the exact family: ${participant.modelFamily}.`;
}

function getHumanPartnerSocketId(session, socketId) {
  return Object.keys(session.players).find((candidateId) => candidateId !== socketId) || null;
}

module.exports = {
  scoreAiGuess,
  scoreHumanGuess,
};
