import React, { useId, useState } from "react";
import type { GameHistoryEntry, Pin } from "../types";
import { ComparisonMap } from "./ComparisonMap";

export function HistoryMap({ game }: { game: GameHistoryEntry }) {
  const showYourGuess = game.opponentType === "Human" || Boolean(validPin(game.guessLocation));
  // An actual location alone doesn't mean the opponent made a location guess.
  // Retain saved pins from older records that may lack an identity verdict.
  const showTheirGuess = game.opponentIdentityGuess === "Human" || Boolean(validPin(game.opponentGuessLocation));
  const [perspective, setPerspective] = useState<"you" | "opponent">(showYourGuess ? "you" : "opponent");
  const mapId = useId();
  if (!showYourGuess && !showTheirGuess) return null;

  const yours = perspective === "you";
  const guess = validPin(yours ? game.guessLocation : game.opponentGuessLocation);
  const noActualLocation = yours && game.opponentType === "AI";
  const actual = noActualLocation ? null : validPin(yours ? game.actualLocation : game.opponentActualLocation);
  const distance = yours ? game.distanceKm : game.opponentDistanceKm;
  const guessLabel = yours ? "Your guess" : "Their guess";
  const actualLabel = yours ? "Their location" : "Your location";
  const description = `${guessLabel}: ${guess ? coordinates(guess) : "no saved pin"}. ${noActualLocation ? "AI opponents have no actual location" : `${actualLabel}: ${actual ? coordinates(actual) : "coordinates unavailable"}`}.`;

  return (
    <figure className="historyMapPreview">
      {showYourGuess && showTheirGuess ? (
        <div className="historyMapSwitch" role="group" aria-label="Location comparison">
          <button type="button" aria-pressed={yours} aria-controls={mapId} onClick={() => setPerspective("you")}>Your guess</button>
          <button type="button" aria-pressed={!yours} aria-controls={mapId} onClick={() => setPerspective("opponent")}>Their guess</button>
        </div>
      ) : <h2 className="historyChatMeta">{guessLabel} on the map</h2>}
      <div id={mapId}>
        {guess || actual ? (
          <ComparisonMap correctPin={actual} guessPin={guess} className="historyComparisonMap" label={description} attribution />
        ) : <p className="historyMapEmpty">Map coordinates weren't saved for this round.</p>}
      </div>
      <figcaption>
        <div className="historyMapLegend">
          <span><i className="guess" aria-hidden="true" />{guessLabel}{!guess ? " · no saved pin" : ""}</span>
          {!noActualLocation && <span><i className="actual" aria-hidden="true" />{actualLabel}{!actual ? " · unavailable" : ""}</span>}
        </div>
        {guess && actual && typeof distance === "number" && Number.isFinite(distance) && (
          <p>{distance.toLocaleString()} km apart</p>
        )}
        {noActualLocation ? <p>An AI opponent has no actual location to compare.</p> : !actual && guess && <p>The actual coordinates weren't saved for this round.</p>}
      </figcaption>
    </figure>
  );
}

function validPin(pin: Pin | null | undefined): Pin | null {
  return pin && Number.isFinite(pin.lat) && Number.isFinite(pin.lng)
    && Math.abs(pin.lat) <= 90 && Math.abs(pin.lng) <= 180 ? pin : null;
}

function coordinates(pin: Pin) {
  return `${pin.lat.toFixed(3)}, ${pin.lng.toFixed(3)}`;
}
