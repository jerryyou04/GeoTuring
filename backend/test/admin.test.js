const test = require("node:test");
const assert = require("node:assert/strict");

function configuredAdmin(slug = "", password = "") {
  const saved = { slug: process.env.ADMIN_URL, password: process.env.ADMIN_PASSWORD };
  process.env.ADMIN_URL = slug;
  process.env.ADMIN_PASSWORD = password;
  delete require.cache[require.resolve("../config")];
  delete require.cache[require.resolve("../admin")];
  try {
    return require("../admin").registerAdminRoutes;
  } finally {
    for (const [key, value] of [["ADMIN_URL", saved.slug], ["ADMIN_PASSWORD", saved.password]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function routesFor(slug, password) {
  const routes = new Map();
  const app = Object.fromEntries(["get", "post"].map(method => [method, (path, ...handlers) => {
    routes.set(`${method} ${path}`, handlers);
  }]));
  configuredAdmin(slug, password)(app, { sessions: new Map(), waitingQueue: new Map() });
  return routes;
}

function response() {
  return { statusCode: 200, body: null,
    headers: {},
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("admin routes stay unregistered unless both slug and password are set", () => {
  assert.equal(routesFor("", "test-only-password").size, 0);
  assert.equal(routesFor("host-monitor", "").size, 0);
});

test("custom admin paths preserve login and token protection for rooms and history", () => {
  const routes = routesFor("  host-monitor_42  ", "test-only-password");
  const prefix = "/admin/host-monitor_42";
  assert.deepEqual([...routes.keys()], [`get ${prefix}/status`, `post ${prefix}/login`, `get ${prefix}/rooms`, `get ${prefix}/history`]);
  const status = response();
  routes.get(`get ${prefix}/status`)[0]({}, status);
  assert.deepEqual(status.body, { enabled: true });
  assert.equal(status.headers["Cache-Control"], "no-store");
  const login = routes.get(`post ${prefix}/login`)[0];
  const rejected = response();
  login({ body: { password: "wrong" } }, rejected);
  assert.equal(rejected.statusCode, 401);
  const accepted = response();
  login({ body: { password: "test-only-password" } }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.match(accepted.body.token, /^[a-f0-9]{64}$/);
  for (const resource of ["rooms", "history"]) {
    const [authenticate] = routes.get(`get ${prefix}/${resource}`);
    const anonymous = response();
    authenticate({ headers: {} }, anonymous, () => assert.fail("Anonymous request passed"));
    assert.equal(anonymous.statusCode, 401);
    let authorized = false;
    authenticate({ headers: { authorization: `Bearer ${accepted.body.token}` } }, response(), () => { authorized = true; });
    assert.equal(authorized, true);
  }
});

test("invalid admin slugs cannot introduce route patterns or nested paths", () => {
  for (const slug of ["nested/path", ":parameter", "wild*card", "path?query", "a".repeat(129), "history", "Leaderboard"]) {
    assert.throws(() => configuredAdmin(slug, "test-only-password"), /ADMIN_URL must be a single URL segment/);
  }
});
