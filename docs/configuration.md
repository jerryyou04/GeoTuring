# Configuration and deployment

GeoTuring runs as a Vite frontend and an Express/Socket.IO backend. Copy each
service's `.env.example` to `.env` for local development. Production values belong
in the hosting service's environment, with credentials on the backend only.

## Backend environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP/Socket.IO port; defaults to `3000`. Railway supplies this. |
| `FRONTEND_URL` | Allowed CORS origin, such as `http://localhost:5173` locally or the deployed frontend URL. Set it explicitly in production. |
| `DATABASE_URL` | PostgreSQL connection string for completed game history. Without it, history persistence is disabled. |
| `REDIS_URL` | Redis connection string for leaderboard statistics and display names. Configure both PostgreSQL and Redis for the complete production history/leaderboard flow. |
| `OPENROUTER_API_KEY` | Enables live AI replies. Without it, opponents use canned development replies. |
| `ADMIN_URL` | Optional host-chosen admin URL segment. No leading slash; use 1–128 letters, numbers, hyphens, or underscores. `history` and `leaderboard` are reserved. |
| `ADMIN_PASSWORD` | Admin login password. Admin routes are registered only when both this and `ADMIN_URL` are nonempty. |
| `GEOAPIFY_API_KEY` | Optional managed reverse-geocoding provider; otherwise the backend uses its rate-limited Nominatim fallback. |

### AI provider options

- `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME`: optional attribution headers.
- `OPENROUTER_MODEL_CHATGPT`, `OPENROUTER_MODEL_GEMINI`,
  `OPENROUTER_MODEL_CLAUDE`, and `OPENROUTER_MODEL_GROK`: model slug overrides
  for each in-game family.
- `OPENROUTER_TIMEOUT_MS`, `OPENROUTER_MAX_CONTEXT_MESSAGES`, and
  `OPENROUTER_MAX_TOKENS`: chat request tuning.
- `OPENROUTER_GUESS_TIMEOUT_MS` and `OPENROUTER_GUESS_MAX_TOKENS`: opponent
  final-guess request tuning.
- `OPENROUTER_REASONING_EFFORT` and `OPENROUTER_GUESS_REASONING_EFFORT`:
  provider reasoning options.
- `AI_OPPONENT_GUESS_ENABLED`: set to `false` to disable the AI's final guess.
- `AI_TYPING_WPM` and `AI_TYPING_WPM_STDDEV`: simulated typing-speed tuning.

### Reverse-geocoding options

Guess pins are resolved into structured place labels on the backend. Lookups use
an in-memory cache, coalesce concurrent requests for the same area, and fail open
when a provider is unavailable. Public Nominatim calls are globally limited to one
request per second within the backend process.

- `GEOCODING_BASE_URL`: provider endpoint override.
- `GEOCODING_USER_AGENT`: identifying application User-Agent. When using public
  Nominatim, include an application name and contact URL or email.
- `GEOCODING_TIMEOUT_MS`: end-to-end timeout including rate-limit waits;
  defaults to `2500` milliseconds.
- `GEOCODING_CACHE_MAX_ENTRIES`, `GEOCODING_CACHE_GRID_DEGREES`,
  `GEOCODING_CACHE_TTL_MS`, and `GEOCODING_UNAVAILABLE_CACHE_TTL_MS`: cache tuning.
- `GEOCODING_MAX_RESULT_DISTANCE_KM`: cutoff for implausible nearest-land
  responses where the provider supplies distance information; defaults to `100`.

## Frontend environment

- `NEXT_PUBLIC_API_URL`: backend HTTP URL, such as `http://localhost:3000`.
- `NEXT_PUBLIC_SOCKET_URL`: Socket.IO URL, normally the same as the HTTP URL.

`VITE_API_URL` and `VITE_SOCKET_URL` are supported aliases. Frontend variables are
read at build time and included in browser JavaScript. Rebuild the frontend after
changing them. Never put credentials in frontend variables.

There is no frontend admin environment variable. The browser checks the candidate
path being visited with the backend.

## Railway deployment

Use two services from the same repository, with a Node version supported by Vite
(`^20.19.0 || >=22.12.0`; Node 22.12+ also covers local development).

| Service | Root directory | Build | Start |
| --- | --- | --- | --- |
| Backend | `backend` | Install from the lockfile | `npm start` |
| Frontend | `frontend` | `npm run build` | `npm start` |

The hosted app uses `geoturing.com` for the frontend and `api.geoturing.com` for
the backend. For another deployment, configure the frontend API/socket URLs and
backend CORS origin to match its domains.

Set `FRONTEND_URL` on the backend. Add `OPENROUTER_API_KEY`, `DATABASE_URL`, and
`REDIS_URL` for the full production feature set. For higher geocoding volume,
configure a provider and quota appropriate to that deployment.

Active sessions, timers, and matchmaking queues are in process memory. Run one
backend instance with the current implementation. On startup, `initDb()` creates
or updates the history schema, and PostgreSQL history seeds the Redis leaderboard
when both stores are enabled.

## Admin monitor

Set `ADMIN_URL` and `ADMIN_PASSWORD` on the backend. For example, a URL segment of
`host-monitor` gives a frontend page at `/host-monitor` and API routes under
`/admin/host-monitor`. Visit that page on the frontend and sign in.

Changing the configured path requires a backend redeployment, with no frontend
variable or rebuild. The frontend verifies the requested path before showing the
login screen. Unconfigured paths fall back to the game. The monitor displays
queued players, live rooms and transcripts, and paginated completed history.

The configured value is absent from the source and browser bundle. Anyone who
knows or guesses a valid path can confirm it through the status endpoint; the
backend password and issued bearer token control access to monitor data.

## HTTP routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Basic API status |
| GET | `/health` | Health check returning `{ "ok": true }` |
| GET | `/api/history?playerId=…` | Completed rounds for an anonymous player ID |
| POST | `/api/name` | Set the display name for an anonymous player ID |
| GET | `/api/leaderboard?page=1&pageSize=25` | Paginated leaderboard |
| GET | `/admin/<ADMIN_URL>/status` | Confirm the candidate admin route is enabled; no room or player data |
| POST | `/admin/<ADMIN_URL>/login` | Authenticate with `{ "password": "…" }` |
| GET | `/admin/<ADMIN_URL>/rooms` | Authenticated queue, room, and transcript snapshot |
| GET | `/admin/<ADMIN_URL>/history` | Authenticated paginated archive, with optional player filtering |

## Socket events

The primary flow uses `queue:join`, `session:created`, `chat:message`,
`partner:message`, `round:lock`, `guess:submit`, and `session:result`.
`session:resume` restores an active session; `turn:update` provides the
server-owned turn state and deadlines. Message IDs and acknowledgements support
retry deduplication.

## Local demo storage

`npm run dev:mock` substitutes synthetic history and leaderboard data, and disables
OpenRouter calls in that process. Its ignored data file is
`backend/.local/mock-data.json`. Remove it while the server is stopped to reset
the samples. Regular `npm start` and `npm run dev` use the production storage
implementations. Mock mode refuses to run in production or on Railway.

## Manual production checks

Use separate browser profiles for independent players. Two tabs on the same
origin share a player ID and exercise ownership transfer instead.

The frontend's `npm run test:production-proxy` can serve the deployed frontend on
a fresh loopback origin for a second browser identity. It connects to the real
production backend, so gameplay through it creates production records. See the
[paired-player QA procedure](qa/production-e2e-2026-10-14.md).

## Map and geocoding attribution

Keep visible [OpenStreetMap attribution](https://www.openstreetmap.org/copyright)
where map data or derived place labels are presented. Retain an identifying
User-Agent and follow public Nominatim usage limits. When Geoapify is configured,
follow the attribution and quota requirements of the selected plan as well.

New completed rounds persist guess pins and revealed rough locations. Older
history rows cannot reconstruct actual coordinates that were never recorded.
