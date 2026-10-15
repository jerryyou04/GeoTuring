import React, { useEffect, useRef } from "react";
import L from "leaflet";
import { MODEL_FAMILIES } from "../config";
import { GUESS_MARKER } from "../leafletIcons";
import type { IdentityGuess, ModelFamily, Pin } from "../types";
import { PanelHeading, RoundTimer } from "./PanelHeading";

export function FinalGuessTimer({ secondsLeft }: { secondsLeft: number }) {
  return (
    <RoundTimer label="Time to guess" value={`${secondsLeft}s`} urgent={secondsLeft <= 10} />
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
    <section className="centerPanel decisionPanel">
      <PanelHeading label="Identity" title="Who were you talking to?" actions={<FinalGuessTimer secondsLeft={secondsLeft} />} />
      <div className="choiceGrid two">
        <button type="button" disabled={disabled} onClick={() => onPick("Human")}>
          <span>Human</span>
          <small>Next: place a map pin</small>
        </button>
        <button type="button" disabled={disabled} onClick={() => onPick("AI")}>
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
    <section className="gamePanel humanGuessCard decisionPanel">
      <PanelHeading label="Location" title="Guess their location" actions={
        <>
          <FinalGuessTimer secondsLeft={secondsLeft} />
          <button className="secondaryButton" type="button" disabled={disabled} onClick={onBack}>
            Back
          </button>
        </>
      } />

      <GuessMap disabled={disabled} pin={pin} onPin={onPin} />

      <div className="mapFooter">
        <span role="status">
          {disabled
            ? "Final guess time expired."
            : pin
              ? "Pin placed. Tap elsewhere to move it."
              : "Click or tap to place a pin. With the map focused, Enter pins its center."}
        </span>
        <button className="primaryButton" type="button" disabled={disabled || !pin} onClick={onSubmit}>
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

      const point = event.latlng.wrap();
      onPinRef.current({ lat: point.lat, lng: point.lng });
    });

    function handleMapKey(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.target !== element || disabledRef.current) return;
      event.preventDefault();
      const center = map.getCenter().wrap();
      onPinRef.current({ lat: center.lat, lng: center.lng });
    }
    element.addEventListener("keydown", handleMapKey);

    mapRef.current = map;

    // The map mounts while the round grid is still reflowing from one column to
    // two, so its container size isn't final yet. Re-sync Leaflet whenever the
    // container actually settles instead of relying on a single timer tick.
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());

    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
      element.removeEventListener("keydown", handleMapKey);
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
      <div className="guessMap" ref={mapElementRef} role="region" aria-label="World map. Click or tap to place your location guess. Keyboard: arrows to move, plus or minus to zoom, Enter to pin the center." />
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
    <section className="centerPanel decisionPanel">
      <PanelHeading label="Model" title="Which model were you talking to?" description="Choosing a model locks your answer." actions={
        <>
          <FinalGuessTimer secondsLeft={secondsLeft} />
          <button className="secondaryButton" type="button" disabled={disabled} onClick={onBack}>
            Back
          </button>
        </>
      } />
      <div className="choiceGrid">
        {MODEL_FAMILIES.map((family) => (
          <button
            type="button"
            className={selected === family ? "selected" : ""}
            aria-pressed={selected === family}
            disabled={disabled}
            key={family}
            onClick={() => onPick(family)}
          >
            <span>{family}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function WaitingGuessScreen({ secondsLeft }: { secondsLeft: number }) {
  return (
    <section className="centerPanel decisionPanel finalGuessPanel" role="status">
      <PanelHeading title="Your guess is locked" description="Waiting for your opponent to finish." actions={<FinalGuessTimer secondsLeft={secondsLeft} />} />
      <p className="waitingNote">Unanswered guesses are scored as zero when the timer ends.</p>
    </section>
  );
}
