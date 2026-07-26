import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { Pin, ResultPayload, SubmittedGuess } from "../types";
import { formatGuessPlace } from "../utils";

const CORRECT_MARKER = createRevealMarker("correct");
const GUESS_MARKER = createRevealMarker("guess");

export function Reveal({
  canRestart = true,
  result,
  onRestart,
  serverClockOffsetMs = 0,
}: {
  canRestart?: boolean;
  result: ResultPayload;
  onRestart: () => void;
  serverClockOffsetMs?: number;
}) {
  const isHumanRound = result.actual.participantType === "Human";
  const correct = result.correctIdentity;
  const verdict = correct ? "Correct read" : "Wrong read";

  return (
    <section className="gamePanel reveal">
      <div className="revealTop">
        <div>
          <p className="roundLabel">Reveal</p>
          <h2>{verdict}</h2>
          <p>{getResultSummary(result)}</p>
        </div>
        <span className={`verdictBadge ${correct ? "correct" : "wrong"}`} aria-label={verdict}>
          {correct ? "✓" : "✗"}
        </span>
      </div>

      <div className="scoreSummary" aria-label="Round score">
        <ScoreRow
          label="Identity"
          note={correct ? "You identified who you were talking to." : "You picked the wrong opponent type."}
          tone={scoreTone(result.score.read.earned, result.score.read.possible)}
          value={`${result.score.read.earned}/${result.score.read.possible}`}
        />
        <ScoreRow
          label={isHumanRound ? "Location" : "Model"}
          note={isHumanRound ? getLocationScoreSummary(result.guess, result.distanceKm) : "Exact model-family match."}
          tone={scoreTone(result.score.round.earned, result.score.round.possible)}
          value={`${result.score.round.earned}/${result.score.round.possible}`}
        />
      </div>

      {isHumanRound
        ? <HumanReveal result={result} serverClockOffsetMs={serverClockOffsetMs} />
        : <AiReveal result={result} serverClockOffsetMs={serverClockOffsetMs} />}

      <p className="explanation resultExplanation">{result.explanation}</p>
      <button className="primaryButton" disabled={!canRestart} onClick={onRestart}>
        {canRestart ? "Play again" : "Finalizing round..."}
      </button>
    </section>
  );
}

function HumanReveal({ result, serverClockOffsetMs }: { result: ResultPayload; serverClockOffsetMs: number }) {
  const actualPin = getActualPin(result.actual);
  const guessedHuman = result.guess.identityGuess === "Human";
  const yourGuessPin = guessedHuman ? result.guess.locationGuess : null;
  const opponentGuess = result.opponentGuess;
  const opponentPending = Boolean(result.opponentPending) && !opponentGuess;
  const opponentActualPin = getActualPin(result.opponentActual || null);
  const actualPlace = [result.actual.region, result.actual.country].filter(Boolean).join(", ") || "Location unavailable";

  return (
    <div className="mapComparisonGrid">
      {!guessedHuman && (
        <div className="answerGrid">
          <AnswerCard title="Your answer" tone="wrong">
            <AnswerLine label="Opponent" state="mismatch" value={formatIdentity(result.guess.identityGuess)} />
            <AnswerLine label="Model family" value={result.guess.modelFamilyGuess || "No family picked"} />
          </AnswerCard>
          <AnswerCard title="Correct answer" tone="correct">
            <AnswerLine label="Opponent" value="Human" />
            <AnswerLine label="Rough location" value={actualPlace} />
          </AnswerCard>
        </div>
      )}
      <LocationComparison
        correctLabel="Correct rough location"
        correctPin={actualPin}
        detail={guessedHuman ? "Compare your pin with the correct rough location." : "You guessed AI, so this shows the human location you missed."}
        guessLabel={getMapGuessLabel(result.guess, "Your guess", result.distanceKm)}
        guessPin={yourGuessPin}
        title={guessedHuman ? "Your location guess" : "Correct human location"}
      />
      {opponentPending ? (
        <OpponentPendingCard endsAt={result.opponentGuessEndsAt ?? null} serverClockOffsetMs={serverClockOffsetMs} />
      ) : opponentGuess ? (
        opponentGuess.identityGuess === "Human" ? (
          <LocationComparison
            correctLabel="Your rough location"
            correctPin={opponentActualPin}
            detail={opponentGuess.locationGuess ? "They guessed your rough location." : "They picked human but placed no pin."}
            guessLabel={getMapGuessLabel(
              opponentGuess,
              "Their guess",
              getPinDistanceKm(opponentGuess.locationGuess, opponentActualPin),
            )}
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

function AiReveal({ result, serverClockOffsetMs }: { result: ResultPayload; serverClockOffsetMs: number }) {
  const guessedAi = result.guess.identityGuess === "AI";
  const modelMatch = guessedAi && result.guess.modelFamilyGuess === result.actual.modelFamily;
  const mapRead = result.guess.locationGuess;

  return (
    <>
      <div className="answerGrid">
        <AnswerCard title="Your answer" tone={result.correctIdentity ? "correct" : "wrong"}>
          <AnswerLine label="Opponent" value={formatIdentity(result.guess.identityGuess)} state={guessedAi ? "match" : "mismatch"} />
          <AnswerLine
            label="Model family"
            state={guessedAi ? (modelMatch ? "match" : "mismatch") : undefined}
            value={guessedAi ? result.guess.modelFamilyGuess || "No family picked" : "Not picked"}
          />
        </AnswerCard>
        <AnswerCard title="Actual answer">
          <AnswerLine label="Opponent" value="AI" />
          <AnswerLine label="Model family" value={result.actual.modelFamily || "Unknown"} />
        </AnswerCard>
      </div>
      {mapRead && (
        <LocationComparison
          correctLabel="Correct location"
          correctPin={null}
          detail="This is where your location read landed. An AI opponent has no correct location pin."
          guessLabel={getMapGuessLabel(result.guess, "Your guess", null)}
          guessPin={mapRead}
          missingCorrectLabel="No correct pin — opponent was AI"
          title="Your map read"
        />
      )}
      <AiOpponentRead result={result} serverClockOffsetMs={serverClockOffsetMs} />
    </>
  );
}

// The flip side: the AI's own read of the human it was just talking to. Unlike a
// human opponent, it also explains its reasoning.
function AiOpponentRead({ result, serverClockOffsetMs }: { result: ResultPayload; serverClockOffsetMs: number }) {
  const opponentGuess = result.opponentGuess;
  const opponentPending = Boolean(result.opponentPending) && !opponentGuess;
  const opponentActualPin = getActualPin(result.opponentActual || null);
  const explanation = result.opponentExplanation;
  const guessedHuman = opponentGuess?.identityGuess === "Human";

  return (
    <div className="aiOpponentRead">
      <p className="roundLabel">Turning the tables</p>
      <h3 className="aiOpponentReadTitle">The AI's read of you</h3>

      {opponentPending ? (
        <OpponentPendingCard
          endsAt={result.opponentGuessEndsAt ?? null}
          serverClockOffsetMs={serverClockOffsetMs}
          title="The AI's guess"
          waitingText="The AI is deciding…"
        />
      ) : opponentGuess ? (
        guessedHuman ? (
          <LocationComparison
            correctLabel="Your rough location"
            correctPin={opponentActualPin}
            detail={
              opponentGuess.locationGuess
                ? "The AI pegged you as human and guessed where you're from."
                : "The AI pegged you as human but placed no pin."
            }
            guessLabel={getMapGuessLabel(
              opponentGuess,
              "AI guessed",
              getPinDistanceKm(opponentGuess.locationGuess, opponentActualPin),
            )}
            guessPin={opponentGuess.locationGuess}
            title="It read you as human ✓"
          />
        ) : (
          <AnswerCard title="It thought you were AI ✗">
            <AnswerLine label="Read" value={opponentGuess.submitted ? formatIdentity(opponentGuess.identityGuess) : "No guess"} />
            <AnswerLine label="Guessed model" value={opponentGuess.modelFamilyGuess || "No family picked"} />
          </AnswerCard>
        )
      ) : (
        <AnswerCard title="The AI's guess">
          <AnswerLine label="Read" value="Not available" />
          <AnswerLine label="Detail" value="The AI's guess couldn't be fetched this round." />
        </AnswerCard>
      )}

      {explanation && !opponentPending && <p className="explanation aiOpponentReason">“{explanation}”</p>}
    </div>
  );
}

function LocationComparison({
  correctLabel,
  correctPin,
  detail,
  guessLabel,
  guessPin,
  missingCorrectLabel = "Correct pin unavailable",
  title,
}: {
  correctLabel: string;
  correctPin: Pin | null;
  detail: string;
  guessLabel: string;
  guessPin: Pin | null;
  missingCorrectLabel?: string;
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
        <span className="correct">{correctPin ? correctLabel : missingCorrectLabel}</span>
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
    const element = mapElementRef.current;

    if (!element || mapRef.current) {
      return;
    }

    const map = L.map(element, {
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

    // The reveal panel scrolls and reflows as it mounts, so the map container's
    // size isn't final on the first paint. Re-sync Leaflet once it settles.
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
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

type ScoreTone = "correct" | "partial" | "wrong";
type LineState = "match" | "mismatch";

function scoreTone(earned: number, possible: number): ScoreTone {
  if (possible > 0 && earned >= possible) {
    return "correct";
  }

  return earned > 0 ? "partial" : "wrong";
}

function OpponentPendingCard({
  endsAt,
  title = "Opponent's guess",
  waitingText = "Waiting for their answer…",
  serverClockOffsetMs = 0,
}: {
  endsAt: number | null;
  title?: string;
  waitingText?: string;
  serverClockOffsetMs?: number;
}) {
  const [now, setNow] = useState(Date.now() + serverClockOffsetMs);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() + serverClockOffsetMs), 500);

    return () => window.clearInterval(timer);
  }, [serverClockOffsetMs]);

  const secondsLeft = endsAt === null ? null : Math.max(0, Math.ceil((endsAt - now) / 1000));

  return (
    <section className="answerCard pending opponentPending">
      <h3>{title}</h3>
      <div className="opponentPendingBody">
        <span className="opponentPendingSpinner" aria-hidden="true" />
        <div className="opponentPendingText">
          <strong>{waitingText}</strong>
          <span>
            {secondsLeft === null
              ? "They are still deciding."
              : secondsLeft > 0
                ? `${secondsLeft}s left before their guess locks`
                : "Time's up — scoring their guess."}
          </span>
        </div>
      </div>
    </section>
  );
}

function ScoreRow({ label, note, tone, value }: { label: string; note: string; tone: ScoreTone; value: string }) {
  return (
    <div className={`scoreRow ${tone}`}>
      <div>
        <strong>{label}</strong>
        <span>{note}</span>
      </div>
      <b>{value}</b>
    </div>
  );
}

function AnswerCard({ children, title, tone }: { children: React.ReactNode; title: string; tone?: ScoreTone }) {
  return (
    <section className={`answerCard ${tone || ""}`}>
      <h3>{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function AnswerLine({ label, state, value }: { label: string; state?: LineState; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={state}>
        {state && <span className="lineCue" aria-hidden="true">{state === "match" ? "✓" : "✗"}</span>}
        {value}
      </dd>
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

function getLocationScoreSummary(guess: SubmittedGuess, distanceKm: number | null) {
  if (!guess.locationGuess) {
    return "No scored location pin.";
  }

  const place = formatGuessPlace(guess.locationPlace);

  if (place) {
    return `Guessed ${place}.`;
  }

  if (guess.locationPlaceStatus === "pending") {
    return "Resolving pinned location…";
  }

  return distanceKm === null
    ? "Pinned location unavailable."
    : `${distanceKm.toLocaleString()} km from the correct rough location.`;
}

function getMapGuessLabel(guess: SubmittedGuess, prefix: string, distanceKm: number | null) {
  const place = formatGuessPlace(guess.locationPlace);

  if (place) {
    return `${prefix}: ${place}`;
  }

  if (guess.locationPlaceStatus === "pending") {
    return "Resolving pinned location…";
  }

  return distanceKm === null
    ? `${prefix}: pinned location unavailable`
    : `${prefix}: ${distanceKm.toLocaleString()} km off`;
}

function getPinDistanceKm(first: Pin | null, second: Pin | null) {
  if (!first || !second) {
    return null;
  }

  const earthRadiusKm = 6371;
  const toRadians = (value: number) => value * Math.PI / 180;
  const latDelta = toRadians(second.lat - first.lat);
  const lngDelta = toRadians(second.lng - first.lng);
  const firstLat = toRadians(first.lat);
  const secondLat = toRadians(second.lat);
  const haversine =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(lngDelta / 2) ** 2;
  const clampedHaversine = Math.min(1, Math.max(0, haversine));

  return Math.round(
    earthRadiusKm * 2 * Math.atan2(Math.sqrt(clampedHaversine), Math.sqrt(1 - clampedHaversine)),
  );
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
