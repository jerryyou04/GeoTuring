# GeoTuring

GeoTuring is a real-time social deduction web game. A player chats anonymously
with either a human-like participant or an AI-like participant, then guesses who
they were talking to. Human guesses continue into a lightweight GeoGuessr-style
map pin; AI guesses continue into a model-family pick.

This repo is intentionally small for the MVP:

- `backend/` - Express + Socket.IO API for Railway at `api.geoturing.com`
- `frontend/` - Vite React client for Railway at `geoturing.com`
- In-memory sessions only
- Human matchmaking with OpenRouter-backed AI fallback
- No login, payments, database, or Mapbox yet

## Local Development

Backend:

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

The backend runs on `http://localhost:3000` by default.

Frontend:

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

The frontend runs on `http://localhost:5173` by default.

### Local sample data without Postgres or Redis

Run `npm run dev:mock` from `backend/` instead of the normal backend command.
Use the same frontend and API URLs. This separate local entry point supplies
32 synthetic leaderboard players and six sample rounds for each new local
player, including human/AI outcomes and expandable chat transcripts.

Completed rounds and display-name changes are saved in the ignored
`backend/.local/mock-data.json` file and survive backend restarts. Stop the
backend and remove that file to reset the sample data. This mode uses local
canned AI replies and does not connect to Postgres, Redis, or OpenRouter.
`npm start` and `npm run dev` retain the regular production storage behavior;
`dev:mock` refuses to run with `NODE_ENV=production` or in Railway.

## Environment Variables

Backend:

- `PORT` - server port. Railway provides this automatically in production.
- `FRONTEND_URL` - allowed CORS origin, such as `http://localhost:5173` or
  `https://geoturing.com`.
- `ADMIN_PASSWORD` - required password for the room monitor at
  `/host-monitor`. Admin endpoints are disabled when this is unset.
- `OPENROUTER_API_KEY` - enables real AI chat opponents through OpenRouter. If
  unset, the backend falls back to local canned replies for development.
- `OPENROUTER_SITE_URL` and `OPENROUTER_APP_NAME` - optional OpenRouter app
  attribution headers.
- `OPENROUTER_MODEL_CHATGPT`, `OPENROUTER_MODEL_GEMINI`,
  `OPENROUTER_MODEL_CLAUDE`, `OPENROUTER_MODEL_GROK` - optional model slug
  overrides for each in-game AI family.
- `GEOAPIFY_API_KEY` - optional server-side key for managed reverse geocoding of
  location guesses. When unset, the backend uses the public OpenStreetMap
  Nominatim endpoint with caching and a global one-request-per-second limit.
- `GEOCODING_BASE_URL` - optional reverse-geocoding endpoint override for the
  selected provider.
- `GEOCODING_USER_AGENT` - identifying application User-Agent sent to the
  geocoder. Set this to an application name and contact URL/email when using
  public Nominatim; it defaults to an identifying GeoTuring User-Agent.
- `GEOCODING_TIMEOUT_MS` - optional end-to-end lookup timeout in milliseconds,
  including any public-provider rate-limit wait (default `2500`).
- `GEOCODING_CACHE_MAX_ENTRIES`, `GEOCODING_CACHE_GRID_DEGREES`,
  `GEOCODING_CACHE_TTL_MS`, and `GEOCODING_UNAVAILABLE_CACHE_TTL_MS` - optional
  in-memory reverse-geocode cache tuning.
- `GEOCODING_MAX_RESULT_DISTANCE_KM` - optional cutoff used when a provider
  supplies enough distance information to detect an implausible nearest-land
  result (default `100`).

Frontend:

- `NEXT_PUBLIC_API_URL` - backend HTTP URL, such as `http://localhost:3000` or
  `https://api.geoturing.com`.
- `NEXT_PUBLIC_SOCKET_URL` - backend Socket.IO URL. Usually the same value as
  `NEXT_PUBLIC_API_URL`.

The Vite aliases `VITE_API_URL` and `VITE_SOCKET_URL` are also supported for
local development.

## Socket Events

- `queue:join` - player enters matchmaking
- `session:created` - backend returns a new session
- `chat:message` - player sends a chat message
- `partner:message` - anonymous human or AI partner sends a chat message
- `guess:submit` - player submits identity and secondary guess
- `session:result` - backend returns score and reveal data

## Scoring

Each round returns a read score plus a type-specific round score:

- Read score: `0/1` or `1/1` for correctly identifying Human vs AI.
- Human round score: `0/100` through `100/100`, based on haversine distance
  from the actual location.
- AI round score: `0/1` or `1/1`. The point requires correctly identifying the
  participant as AI and guessing the exact model family.

## Railway Deployment

Create two Railway services from this repo:

- Backend service root directory: `backend`
- Frontend service root directory: `frontend`

Backend service:

- Start command: `npm start`
- Set `FRONTEND_URL=https://geoturing.com`
- Set `OPENROUTER_API_KEY` to the backend service variable in Railway.
- For production reverse-geocoding volume, set `GEOAPIFY_API_KEY`. Without it,
  the low-volume Nominatim fallback remains functional and rate-limited.
- Railway should route `api.geoturing.com` to this service.

Frontend service:

- Build command: `npm run build`
- Start command: `npm start`
- Set `NEXT_PUBLIC_API_URL=https://api.geoturing.com`
- Set `NEXT_PUBLIC_SOCKET_URL=https://api.geoturing.com`
- Railway should route `geoturing.com` to this service.

## Domain Layout

- `geoturing.com` -> frontend
- `api.geoturing.com` -> backend

## API Endpoints

- `GET /` - basic API status
- `GET /health` - deployment health check returning `{ "ok": true }`
- `POST /admin/host-monitor/login` - admin login with
  `{ "password": "..." }`
- `GET /admin/host-monitor/rooms` - authenticated room, queue, and
  transcript snapshot

## Reverse-Geocoding Attribution

Expanded History rounds include a small guess-versus-actual map. New completed
rounds persist both revealed rough locations alongside the guess pins; the
required nullable columns are added by `initDb()` on backend startup. Older rows
keep their saved pins and place labels, but cannot reconstruct actual coordinates
that were never recorded.

Guess coordinates are reverse-geocoded by the backend into concise place names;
provider credentials never belong in the frontend. Without `GEOAPIFY_API_KEY`,
the fallback uses Nominatim and OpenStreetMap data. Keep visible
[OpenStreetMap attribution](https://www.openstreetmap.org/copyright) anywhere
those labels or map data are presented, retain the identifying User-Agent, and
respect the public Nominatim usage limits. If Geoapify is enabled, also follow
the attribution and quota requirements of the selected Geoapify plan.

## Admin Room Monitor

Visit `/host-monitor` on the frontend and log in with
`ADMIN_PASSWORD`. The monitor shows waiting players, active human/AI rooms,
participant status, rough locations, and chat transcripts for live testing.
The obscure path is only for convenience; the backend password check is the
actual access control.

## Current TODOs

- Replace simulated human opponents with real human matchmaking.
- Add persistent game history once the MVP flow is stable.
