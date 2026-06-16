import React, { useEffect, useRef } from "react";
import L from "leaflet";
import { MODEL_FAMILIES } from "../config";
import { GUESS_MARKER } from "../leafletIcons";
import type { IdentityGuess, ModelFamily, Pin } from "../types";

export function FinalGuessTimer({ secondsLeft }: { secondsLeft: number }) {
  return (
    <div className="finalGuessTimer" aria-label={`${secondsLeft} seconds left to guess`}>
      <span>Guess timer</span>
      <strong>{secondsLeft}s</strong>
    </div>
  );
}

export function IdentityGuessScreen({
  disabled,
  secondsLeft,
  onPick,
}: {
  disabled: boolean;
  secondsLeft: number;
  onPick: (value: IdentityGuess) => void;
}) {
  return (
    <section className="centerPanel">
      <div className="finalGuessHeader">
        <div>
          <p className="roundLabel">First guess</p>
          <h2>Who were you talking to?</h2>
        </div>
        <FinalGuessTimer secondsLeft={secondsLeft} />
      </div>
      <div className="choiceGrid two">
        <button disabled={disabled} onClick={() => onPick("Human")}>
          <span>Human</span>
          <small>Next: place a map pin</small>
        </button>
        <button disabled={disabled} onClick={() => onPick("AI")}>
          <span>AI</span>
          <small>Next: pick the model family</small>
        </button>
      </div>
    </section>
  );
}

export function HumanGuessScreen({
  disabled,
  pin,
  secondsLeft,
  onPin,
  onBack,
  onSubmit,
}: {
  disabled: boolean;
  pin: Pin | null;
  secondsLeft: number;
  onPin: (pin: Pin) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="gamePanel humanGuessCard">
      <div className="chatHeader">
        <div>
          <p className="roundLabel">Human read</p>
          <h2>Place the origin pin.</h2>
        </div>
        <div className="guessHeaderActions">
          <FinalGuessTimer secondsLeft={secondsLeft} />
          <button className="secondaryButton" disabled={disabled} onClick={onBack}>
            Back
          </button>
        </div>
      </div>

      <GuessMap disabled={disabled} pin={pin} onPin={onPin} />

      <div className="mapFooter">
        <span>
          {disabled
            ? "Final guess time expired."
            : pin
              ? "Pin placed"
              : "Tap the map to place a pin."}
        </span>
        <button className="primaryButton" disabled={disabled || !pin} onClick={onSubmit}>
          Lock human guess
        </button>
      </div>
    </section>
  );
}

function GuessMap({ disabled, pin, onPin }: { disabled: boolean; pin: Pin | null; onPin: (pin: Pin) => void }) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onPinRef = useRef(onPin);
  const disabledRef = useRef(disabled);

  useEffect(() => {
    onPinRef.current = onPin;
  }, [onPin]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    const element = mapElementRef.current;

    if (!element || mapRef.current) {
      return;
    }

    const map = L.map(element, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: true,
      zoomControl: false,
    });

    L.control.zoom({ position: "topright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    map.on("click", (event: L.LeafletMouseEvent) => {
      if (disabledRef.current) {
        return;
      }

      onPinRef.current({
        lat: event.latlng.lat,
        lng: event.latlng.lng,
      });
    });

    mapRef.current = map;

    // The map mounts while the round grid is still reflowing from one column to
    // two, so its container size isn't final yet. Re-sync Leaflet whenever the
    // container actually settles instead of relying on a single timer tick.
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;

    if (!map) {
      return;
    }

    window.setTimeout(() => map.invalidateSize(), 0);

    if (!pin) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    const latLng = L.latLng(pin.lat, pin.lng);

    if (!markerRef.current) {
      markerRef.current = L.marker(latLng, {
        icon: GUESS_MARKER,
      }).addTo(map);
    } else {
      markerRef.current.setLatLng(latLng);
    }
  }, [pin]);

  return (
    <div className="guessMapShell">
      <div className="guessMap" ref={mapElementRef} />
      <div className="mapCallout">
        {disabled ? "Final guess time expired." : "Click anywhere to place your final guess."}
      </div>
    </div>
  );
}

export function AiGuessScreen({
  disabled,
  secondsLeft,
  selected,
  onPick,
  onBack,
}: {
  disabled: boolean;
  secondsLeft: number;
  selected: ModelFamily | null;
  onPick: (family: ModelFamily) => void;
  onBack: () => void;
}) {
  return (
    <section className="centerPanel">
      <div className="chatHeader compact">
        <div>
          <p className="roundLabel">AI read</p>
          <h2>Pick the model family.</h2>
        </div>
        <div className="guessHeaderActions">
          <FinalGuessTimer secondsLeft={secondsLeft} />
          <button className="secondaryButton" disabled={disabled} onClick={onBack}>
            Back
          </button>
        </div>
      </div>
      <div className="choiceGrid">
        {MODEL_FAMILIES.map((family) => (
          <button
            className={selected === family ? "selected" : ""}
            disabled={disabled}
            key={family}
            onClick={() => onPick(family)}
          >
            <span>{family}</span>
            <small>Lock answer</small>
          </button>
        ))}
      </div>
    </section>
  );
}

export function WaitingGuessScreen({ secondsLeft }: { secondsLeft: number }) {
  return (
    <section className="centerPanel finalGuessPanel">
      <p className="roundLabel">Final read locked</p>
      <h2>Waiting for opponent's guess.</h2>
      <p>{secondsLeft}s left before missing guesses are scored as zero.</p>
    </section>
  );
}
