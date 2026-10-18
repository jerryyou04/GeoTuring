import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "vite";

const bundle = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    lib: { entry: fileURLToPath(new URL("../src/config.ts", import.meta.url)), formats: ["cjs"] },
  },
});
const output = Array.isArray(bundle) ? bundle[0] : bundle;
const code = output.output.find(item => item.type === "chunk").code;
function config(pathname) {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URL,
    window: { location: { pathname, hostname: "localhost", protocol: "http:" } },
  });
  return module.exports;
}

test("public routes do not trigger admin route checks", () => {
  for (const path of ["/", "/history", "/leaderboard", "/history/", "/Leaderboard"]) {
    assert.equal(config(path).ADMIN_CONSOLE_PATH, "");
    assert.equal(config(path).ADMIN_API_PATH, "");
  }
});

test("frontend derives candidate paths from the visited URL without build-time configuration", () => {
  for (const path of ["/host-monitor_42", "/host-monitor_42/"]) {
    const value = config(path);
    assert.equal(value.ADMIN_CONSOLE_PATH, "/host-monitor_42");
    assert.equal(value.ADMIN_API_PATH, "/admin/host-monitor_42");
  }
});

test("malformed or nested routes do not trigger admin route checks", () => {
  for (const slug of ["nested/path", ":parameter", "wild*card", "path?query", "a".repeat(129)]) {
    assert.equal(config(`/${slug}`).ADMIN_CONSOLE_PATH, "");
    assert.equal(config(`/${slug}`).ADMIN_API_PATH, "");
  }
});
