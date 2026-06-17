import React from "react";
import type { GameHistoryEntry } from "../types";

export type RoundStatus = "correct" | "partial" | "wrong";

// Outcome of the second guess: full credit = correct, none = wrong, anything in
// between (a not-quite location pin) = partial.
export function roundStatus(game: GameHistoryEntry): RoundStatus {
  const possible = game.roundPossible || 1;

  if (game.roundEarned >= possible) {
    return "correct";
  }

  if (game.roundEarned <= 0) {
    return "wrong";
  }

  return "partial";
}

// Expanded summary shared by the player history and the admin archive: how this
// player's second guess landed, and (for human games) how the opponent read
// them back.
export function GuessSummary({ game }: { game: GameHistoryEntry }) {
  const isHuman = game.opponentType === "Human";

  return (
    <div className="historySummary">
      <div className="historySummaryItem">
        <span className="historySummaryLabel">Second guess</span>
        <span className={`historySummaryValue roundStatus-${roundStatus(game)}`}>
          {describeYourSecondGuess(game)}
        </span>
      </div>
      {isHuman && (
        <div className="historySummaryItem">
          <span className="historySummaryLabel">How they read you</span>
          <span
            className={`historySummaryValue ${
              game.opponentIdentityGuess ? (game.opponentCorrectIdentity ? "roundStatus-correct" : "roundStatus-wrong") : ""
            }`}
          >
            {describeOpponentRead(game)}
          </span>
        </div>
      )}
    </div>
  );
}

function describeYourSecondGuess(game: GameHistoryEntry) {
  if (game.opponentType === "AI") {
    if (!game.modelFamilyGuess) {
      return `You didn't call it AI — it was ${game.modelFamily || "an AI"}.`;
    }

    return game.modelFamilyGuess === game.modelFamily
      ? `Named ${game.modelFamilyGuess} — correct ✓`
      : `Guessed ${game.modelFamilyGuess}, it was ${game.modelFamily} ✗`;
  }

  const place = [game.actualRegion, game.actualCountry].filter(Boolean).join(", ") || "their location";

  if (game.distanceKm === null) {
    return `No location pin placed — they were in ${place}.`;
  }

  return `Pinned ${game.distanceKm.toLocaleString()} km from ${place}.`;
}

function describeOpponentRead(game: GameHistoryEntry) {
  if (!game.opponentIdentityGuess) {
    return "They didn't lock in a guess.";
  }

  const identity = game.opponentCorrectIdentity
    ? "Read you as Human ✓"
    : `Thought you were ${game.opponentIdentityGuess} ✗`;

  if (game.opponentIdentityGuess === "Human") {
    const distance = game.opponentDistanceKm === null
      ? "no location pin"
      : `${game.opponentDistanceKm.toLocaleString()} km off`;

    return `${identity} · ${distance}`;
  }

  return game.opponentModelFamilyGuess
    ? `${identity} · guessed ${game.opponentModelFamilyGuess}`
    : identity;
}
