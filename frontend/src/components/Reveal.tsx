import React, { useEffect, useRef } from "react";
import L from "leaflet";
import type { Pin, ResultPayload, SubmittedGuess } from "../types";

const CORRECT_MARKER = createRevealMarker("correct");
const GUESS_MARKER = createRevealMarker("guess");

export function Reveal({ result, onRestart }: { result: ResultPayload; onRestart: () => void }) {
  const isHumanRound = result.actual.participantType === "Human";
  const verdict = result.correctIdentity ? "Correct read" : "Wrong read";

  return (
    <section className="gamePanel reveal">
      <div className="revealTop">
        <div>
          <p className="roundLabel">Reveal</p>
          <h2>{verdict}</h2>
          <p>{getResultSummary(result)}</p>
        </div>
      </div>

      <div className="scoreSummary" aria-label="Round score">
        <ScoreRow
          label="Identity"
          note={result.correctIdentity ? "You identified who you were talking to." : "You picked the wrong opponent type."}
          value={`${result.score.read.earned}/${result.score.read.possible}`}
        />
        <ScoreRow
          label={isHumanRound ? "Location" : "Model"}
          note={isHumanRound ? getDistanceSummary(result.distanceKm) : "Exact model-family match."}
          value={`${result.score.round.earned}/${result.score.round.possible}`}
        />
      </div>

      {isHumanRound ? <HumanReveal result={result} /> : <AiReveal result={result} />}

      <p className="explanation resultExplanation">{result.explanation}</p>
      <button className="primaryButton" onClick={onRestart}>
        Play again
      </button>
    </section>
  );
}

function HumanReveal({ result }: { result: ResultPayload }) {
  const actualPin = getActualPin(result.actual);
  const guessedHuman = result.guess.identityGuess === "Human";
  const yourGuessPin = guessedHuman ? result.guess.locationGuess : null;
  const opponentGuess = result.opponentGuess;
  const opponentActualPin = getActualPin(result.opponentActual || null);

  return (
    <div className="mapComparisonGrid">
      {!guessedHuman && (
        <AnswerCard title="Your answer">
          <AnswerLine label="Read" value={formatIdentity(result.guess.identityGuess)} />
          <AnswerLine label="Actual" value="Human" />
          <AnswerLine label="Location score" value="No location pin was scored because you guessed AI." />
        </AnswerCard>
      )}
      <LocationComparison
        correctLabel="Correct rough location"
        correctPin={actualPin}
        detail={guessedHuman ? "Compare your pin with the correct rough location." : "You guessed AI, so this shows the human location you missed."}
        guessLabel="Your pin"
        guessPin={yourGuessPin}
        title={guessedHuman ? "Your location guess" : "Correct human location"}
      />
      {opponentGuess ? (
        opponentGuess.identityGuess === "Human" ? (
          <LocationComparison
            correctLabel="Your rough location"
            correctPin={opponentActualPin}
            detail={opponentGuess.locationGuess ? "They guessed your rough location." : "They picked human but placed no pin."}
            guessLabel="Their pin"
            guessPin={opponentGuess.locationGuess}
            title="Opponent location guess"
          />
        ) : (
          <AnswerCard title="Opponent answer">
            <AnswerLine label="Read" value={opponentGuess.submitted ? formatIdentity(opponentGuess.identityGuess) : "No guess"} />
            <AnswerLine label="Detail" value={formatSubmittedGuessDetail(opponentGuess)} />
          </AnswerCard>
        )
      ) : (
        <AnswerCard title="Opponent answer">
          <AnswerLine label="Read" value="Not available" />
          <AnswerLine label="Detail" value="Opponent guess was not returned for this round." />
        </AnswerCard>
      )}
    </div>
  );
}

function AiReveal({ result }: { result: ResultPayload }) {
  return (
    <div className="answerGrid">
      <AnswerCard title="Actual answer">
        <AnswerLine label="Opponent" value="AI" />
        <AnswerLine label="Model family" value={result.actual.modelFamily || "Unknown"} />
      </AnswerCard>
      <AnswerCard title="Your answer">
        <AnswerLine label="Opponent" value={formatIdentity(result.guess.identityGuess)} />
        <AnswerLine
          label="Model family"
          value={result.guess.identityGuess === "AI" ? result.guess.modelFamilyGuess || "No family picked" : "Not picked"}
        />
      </AnswerCard>
    </div>
  );
}

function LocationComparison({
  correctLabel,
  correctPin,
  detail,
  guessLabel,
  guessPin,
  title,
}: {
  correctLabel: string;
  correctPin: Pin | null;
  detail: string;
  guessLabel: string;
  guessPin: Pin | null;
  title: string;
}) {
  return (
    <section className="locationComparison">
      <div className="locationComparisonHeader">
        <div>
          <h3>{title}</h3>
          <p>{detail}</p>
        </div>
      </div>
      <ComparisonMap correctPin={correctPin} guessPin={guessPin} />
      <div className="pinSummary">
        <span className="correct">{correctPin ? correctLabel : "Correct pin unavailable"}</span>
        <span className="guess">{guessPin ? guessLabel : "No guess pin"}</span>
      </div>
    </section>
  );
}

function ComparisonMap({ correctPin, guessPin }: { correctPin: Pin | null; guessPin: Pin | null }) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.Marker[]>([]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapElementRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = [];
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];

    const points: L.LatLngExpression[] = [];

    if (correctPin) {
      points.push([correctPin.lat, correctPin.lng]);
      markersRef.current.push(L.marker([correctPin.lat, correctPin.lng], { icon: CORRECT_MARKER }).addTo(map));
    }

    if (guessPin) {
      points.push([guessPin.lat, guessPin.lng]);
      markersRef.current.push(L.marker([guessPin.lat, guessPin.lng], { icon: GUESS_MARKER }).addTo(map));
    }

    if (points.length > 1) {
      map.fitBounds(L.latLngBounds(points), { maxZoom: 5, padding: [28, 28] });
    } else if (points.length === 1) {
      map.setView(points[0], 4);
    } else {
      map.setView([20, 0], 2);
    }

    window.setTimeout(() => map.invalidateSize(), 0);
  }, [correctPin, guessPin]);

  return <div className="comparisonMap" ref={mapElementRef} />;
}

function ScoreRow({ label, note, value }: { label: string; note: string; value: string }) {
  return (
    <div className="scoreRow">
      <div>
        <strong>{label}</strong>
        <span>{note}</span>
      </div>
      <b>{value}</b>
    </div>
  );
}

function AnswerCard({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="answerCard">
      <h3>{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function AnswerLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function createRevealMarker(kind: "correct" | "guess") {
  return L.divIcon({
    className: `revealMarker ${kind}`,
    html: "<span></span>",
    iconSize: [32, 42],
    iconAnchor: [16, 40],
  });
}

function getActualPin(actual: ResultPayload["actual"] | ResultPayload["opponentActual"] | null | undefined): Pin | null {
  if (!actual || !Number.isFinite(actual.lat) || !Number.isFinite(actual.lng)) {
    return null;
  }

  return {
    lat: Number(actual.lat),
    lng: Number(actual.lng),
  };
}

function getResultSummary(result: ResultPayload) {
  if (result.actual.participantType === "Human") {
    const place = [result.actual.region, result.actual.country].filter(Boolean).join(", ");
    return place ? `You were speaking with a human from ${place}.` : "You were speaking with a human.";
  }

  return `You were speaking with ${result.actual.modelFamily || "an AI model"}.`;
}

function getDistanceSummary(distanceKm: number | null) {
  return distanceKm === null ? "No scored location pin." : `${distanceKm.toLocaleString()} km from the correct rough location.`;
}

function formatIdentity(value: string | null) {
  return value || "No guess";
}

function formatSubmittedGuessDetail(guess: SubmittedGuess) {
  if (!guess.submitted) {
    return "Timed out or left blank.";
  }

  if (guess.identityGuess === "Human") {
    return guess.locationGuess ? "Picked human and placed a location pin." : "Picked human with no location pin.";
  }

  if (guess.identityGuess === "AI") {
    return `Picked ${guess.modelFamilyGuess || "no model family"}.`;
  }

  return "No answer available.";
}
