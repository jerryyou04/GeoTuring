import React, { useEffect, useRef } from "react";
import L from "leaflet";
import type { Pin } from "../types";

const CORRECT_MARKER = createMarker("correct");
const GUESS_MARKER = createMarker("guess");

/** Read-only comparison shared by the round reveal and saved history. */
export function ComparisonMap({ correctPin, guessPin, className = "", label, attribution = false }: {
  correctPin: Pin | null;
  guessPin: Pin | null;
  className?: string;
  label?: string;
  attribution?: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    const map = L.map(element, {
      center: [20, 0],
      zoom: 2,
      zoomControl: false,
      attributionControl: attribution,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const points: L.LatLngExpression[] = [];
    if (correctPin) {
      points.push([correctPin.lat, correctPin.lng]);
      L.marker([correctPin.lat, correctPin.lng], { icon: CORRECT_MARKER, interactive: false, keyboard: false }).addTo(map);
    }
    if (guessPin) {
      // Use the nearest world copy for comparisons spanning the date line.
      const longitude = correctPin
        ? guessPin.lng + 360 * Math.round((correctPin.lng - guessPin.lng) / 360)
        : guessPin.lng;
      points.push([guessPin.lat, longitude]);
      L.marker([guessPin.lat, longitude], { icon: GUESS_MARKER, interactive: false, keyboard: false }).addTo(map);
    }

    const fit = () => {
      map.invalidateSize({ pan: false });
      if (points.length > 1) {
        map.fitBounds(L.latLngBounds(points), { maxZoom: 5, padding: [32, 40], animate: false });
      } else if (points.length === 1) {
        map.setView(points[0], 4, { animate: false });
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);

    return () => {
      observer.disconnect();
      map.remove();
    };
  }, [correctPin?.lat, correctPin?.lng, guessPin?.lat, guessPin?.lng, attribution]);

  return <div className={`comparisonMap ${className}`} ref={elementRef} role={label ? "img" : undefined} aria-label={label} />;
}

function createMarker(kind: "correct" | "guess") {
  return L.divIcon({
    className: `revealMarker ${kind}`,
    html: "<span></span>",
    iconSize: [32, 42],
    iconAnchor: [16, 40],
  });
}
