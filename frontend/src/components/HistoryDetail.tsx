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
  // Human opponents always had a chance to read you. AI games only show the
  // AI's read when it actually recorded one (skips old/failed games).
  const showOpponentRead = isHuman || Boolean(game.opponentIdentityGuess);
  const opponentLabel = isHuman ? "How they read you" : "How the AI read you";

  return (
    <div className="historySummary">
      <div className="historySummaryItem">
        <span className="historySummaryLabel">Second guess</span>
        <span className={`historySummaryValue roundStatus-${roundStatus(game)}`}>
          {describeYourSecondGuess(game)}
        </span>
      </div>
      {showOpponentRead && (
        <div className="historySummaryItem">
          <span className="historySummaryLabel">{opponentLabel}</span>
          <span
            className={`historySummaryValue ${
              game.opponentIdentityGuess ? (game.opponentCorrectIdentity ? "roundStatus-correct" : "roundStatus-wrong") : ""
            }`}
          >
            {describeOpponentRead(game)}
          </span>
        </div>
      )}
      {game.opponentExplanation && <p className="historySummaryReason">“{game.opponentExplanation}”</p>}
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
