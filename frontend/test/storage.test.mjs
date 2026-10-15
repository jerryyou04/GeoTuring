import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "vite";

// Exercise the actual TypeScript storage module with the application's existing
// compiler. Nothing is emitted to disk and no browser or API is required.
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  define: { "import.meta.env": "{}" },
  build: {
    write: false,
    minify: false,
    lib: { entry: fileURLToPath(new URL("../src/storage.ts", import.meta.url)), formats: ["cjs"] },
  },
});
const output = Array.isArray(bundle) ? bundle[0] : bundle;
const code = output.output.find((item) => item.type === "chunk").code;
const data = new Map();
const module = { exports: {} };
vm.runInNewContext(code, {
  module,
  exports: module.exports,
  URL,
  window: {
    location: { hostname: "localhost", protocol: "http:" },
    localStorage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
    },
  },
});
const { loadPersistentScore, savePersistentScore } = module.exports;
const empty = { readEarned: 0, readPossible: 0, humanEarned: 0, humanPossible: 0, aiEarned: 0, aiPossible: 0 };
beforeEach(() => data.clear());

test("missing and malformed score data safely return an empty scoreboard", () => {
  assert.deepEqual({ ...loadPersistentScore() }, empty);
  data.set("geoturing:scoreboard:v2", "not JSON");
  assert.deepEqual({ ...loadPersistentScore() }, empty);
});

test("human location points survive a save/load round trip without integer rounding", () => {
  for (const earned of [0.3, 0.7, 1.2, 12.7]) {
    const score = { ...empty, readEarned: 1, readPossible: 1, humanEarned: earned, humanPossible: 20 };
    savePersistentScore(score);
    assert.deepEqual({ ...loadPersistentScore() }, score, `preserve ${earned} human points`);
  }
});

test("accumulated fractional points keep the game's one-decimal precision", () => {
  savePersistentScore({ ...empty, humanEarned: 0.3 + 0.6, humanPossible: 2 });
  assert.equal(loadPersistentScore().humanEarned, 0.9);
  assert.equal(loadPersistentScore().humanPossible, 2);
});

test("invalid location points are rejected while integer score counters remain intact", () => {
  for (const earned of [-0.3, null, "0.3", "Infinity"]) {
    savePersistentScore({ ...empty, humanEarned: earned, readEarned: 2, readPossible: 3, humanPossible: 2, aiEarned: 1, aiPossible: 1 });
    assert.deepEqual({ ...loadPersistentScore() }, { ...empty, readEarned: 2, readPossible: 3, humanPossible: 2, aiEarned: 1, aiPossible: 1 });
  }
});
