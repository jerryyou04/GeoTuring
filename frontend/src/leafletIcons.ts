import L from "leaflet";

export const GUESS_MARKER = L.divIcon({
  className: "guessMarker",
  html: "<span></span>",
  iconSize: [34, 44],
  iconAnchor: [17, 42],
});
