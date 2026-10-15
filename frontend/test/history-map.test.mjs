import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "vite";

// Render the real HistoryMap. Replace only Leaflet's browser-only renderer:
// markup assertions cover perspective selection, passed coordinates, and copy.
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  plugins: [{
    name: "comparison-map-test-double",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./ComparisonMap" && importer?.replaceAll("\\", "/").endsWith("/HistoryMap.tsx")) return "\0comparison-map-test";
    },
    load(id) {
      if (id === "\0comparison-map-test") return `import React from 'react';
        export function ComparisonMap({correctPin, guessPin, label}) {
          return React.createElement('div', {role:'img', 'aria-label':label,
            'data-actual':JSON.stringify(correctPin), 'data-guess':JSON.stringify(guessPin)});
        }`;
    },
  }],
  build: {
    write: false,
    minify: false,
    lib: { entry: fileURLToPath(new URL("../src/components/HistoryMap.tsx", import.meta.url)), formats: ["cjs"] },
    rollupOptions: { external: ["react"] },
  },
});
const output = Array.isArray(bundle) ? bundle[0] : bundle;
const module = { exports: {} };
vm.runInNewContext(output.output.find(item => item.type === "chunk").code, {
  module, exports: module.exports, require: createRequire(import.meta.url),
});
const { HistoryMap } = module.exports;
const pin = { lat: 51.507, lng: -0.128 };
const actual = { lat: 46.8, lng: -71.2 };
const base = { opponentType: "AI", identityGuess: "AI", opponentIdentityGuess: null,
  guessLocation: null, actualLocation: null, opponentGuessLocation: null,
  opponentActualLocation: actual, distanceKm: null, opponentDistanceKm: null };
const render = changes => renderToStaticMarkup(React.createElement(HistoryMap, { game: { ...base, ...changes } }));

test("AI model verdict and failed guesses never become location maps from actual location alone", () => {
  assert.equal(render({ opponentIdentityGuess: "AI", opponentModelFamilyGuess: "ChatGPT" }), "");
  assert.equal(render({ opponentIdentityGuess: null }), "");
});

test("a Human guess against an AI retains the player's pin without inventing an actual location", () => {
  const html = render({ identityGuess: "Human", guessLocation: pin, actualLocation: actual });
  assert.match(html, /Your guess on the map/);
  assert.match(html, /51\.507, -0\.128/);
  assert.match(html, /data-actual="null"/);
  assert.match(html, /An AI opponent has no actual location to compare/);
  assert.doesNotMatch(html, /weren&#x27;t saved|Their location|Location comparison/);
});

test("a real opponent Human guess shows its pin and the player's actual location", () => {
  const html = render({ opponentIdentityGuess: "Human", opponentGuessLocation: pin, opponentDistanceKm: 4989 });
  assert.match(html, /Their guess on the map/);
  assert.match(html, /Their guess: 51\.507, -0\.128\. Your location: 46\.800, -71\.200/);
  assert.match(html, /4,989 km apart/);
});

test("both genuine location perspectives remain selectable", () => {
  const html = render({ opponentType: "Human", actualLocation: actual, guessLocation: pin,
    opponentIdentityGuess: "Human", opponentGuessLocation: actual });
  assert.match(html, /aria-label="Location comparison"/);
  assert.match(html, /aria-pressed="true"[^>]*>Your guess/);
  assert.match(html, /aria-pressed="false"[^>]*>Their guess/);
});

test("Human actual location remains visible when the player made an AI read", () => {
  const html = render({ opponentType: "Human", actualLocation: actual, opponentIdentityGuess: "AI" });
  assert.match(html, /Their location: 46\.800, -71\.200/);
  assert.doesNotMatch(html, /Location comparison|Their guess on the map/);
});

test("older saved opponent pins still render without identity metadata", () => {
  assert.match(render({ opponentGuessLocation: pin }), /Their guess: 51\.507, -0\.128/);
});

test("missing historical coordinates retain an honest empty state", () => {
  assert.match(render({ opponentType: "Human", actualLocation: null }), /Map coordinates weren&#x27;t saved for this round/);
  assert.match(render({ opponentIdentityGuess: "Human", opponentActualLocation: null }), /Map coordinates weren&#x27;t saved for this round/);
});

test("invalid saved pins don't enable spurious AI map previews", () => {
  for (const invalid of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: null, lng: 0 }]) {
    assert.equal(render({ guessLocation: invalid, opponentGuessLocation: invalid }), "");
  }
});
