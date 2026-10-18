# GeoTuring

<img src="frontend/public/geoturing-logo.svg" width="72" alt="GeoTuring globe logo">

A real-time social deduction game: chat anonymously, then decide whether your
opponent is human or AI. If you guess human, pin their rough location on a map.
If you guess AI, pick the model family.

**[Play GeoTuring](https://geoturing.com)** · [Configuration and deployment](docs/configuration.md)

**The live game runs on Railway at [geoturing.com](https://geoturing.com).**
Play there to join the public matchmaking pool. Local instances are for development
and testing against AI or other players connected to your own backend, such as
players on your local network. They do not join the live site's matchmaking pool.

## Features

- **Human and AI matchmaking.** Match with another player or an OpenRouter-backed
  opponent from the ChatGPT, Gemini, Claude, or Grok model families.
- **Timed, turn-based conversations.** Server-controlled turns, early round locking,
  final-guess deadlines, and acknowledgements for message delivery.
- **Session recovery.** Restore conversations after a refresh or reconnect, transfer
  ownership between tabs, and prevent duplicate messages from retries.
- **Map-based reveals.** Compare location guesses with rough actual locations using
  Leaflet, with server-generated place labels and two perspectives in saved rounds.
- **History and leaderboard.** PostgreSQL stores completed rounds and transcripts;
  Redis maintains a paginated leaderboard. A device-local scoreboard tracks results.
- **Host tools.** An optional password-protected console shows queued players,
  live conversations, and completed rounds. Its URL is configured on the backend.

## Architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Vite, Leaflet | Game screens, maps, client state, and reconnect handling |
| Backend | Node.js, Express, Socket.IO | Matchmaking, timers, turn ownership, scoring, and AI orchestration |
| History | PostgreSQL | Completed rounds, transcripts, and guess/reveal coordinates |
| Leaderboard | Redis | Ranked player statistics and display names |
| External services | OpenRouter, ipapi.co, Geoapify / Nominatim, OpenStreetMap tiles | AI replies, rough IP location, place labels, and maps |

The live frontend (`geoturing.com`) and backend (`api.geoturing.com`) run as
separate services on Railway.

Live sessions are held in backend memory; completed rounds are saved separately.
The current implementation is designed for one backend instance. Horizontal scaling would require
shared session state and coordination between Socket.IO servers.

## Run locally

Use Node.js **22.12 or newer** and npm. The local demo needs no PostgreSQL, Redis,
or AI API key.

```bash
git clone https://github.com/jerryyou04/GeoTuring.git
cd GeoTuring
```

Start the demo backend in one terminal:

```bash
cd backend
npm ci
cp .env.example .env
npm run dev:mock
```

Start the frontend in another terminal, from the repository root:

```bash
cd frontend
npm ci
cp .env.example .env
npm run dev
```

Open **http://localhost:5173**. The backend listens on **http://localhost:3000**.
The browser asks for consent to estimate a rough location from your IP address.
Use separate browser profiles to test two independent human players.

For players on your local network, set the frontend's API and Socket.IO URLs to
your backend's LAN address instead of `localhost`, and allow the frontend's origin
with backend `FRONTEND_URL`. Everyone must connect to that same backend to match.
Local AI replies are canned in demo mode; use the regular backend with an
OpenRouter key to test live AI models.

Demo mode supplies 32 synthetic leaderboard players, six sample rounds per new
local player, and canned AI replies. Local changes persist in the ignored
`backend/.local/mock-data.json` file; stop the backend and delete that file to reset
it. Demo mode refuses to run in production or on Railway.

For the regular backend, use `npm run dev` instead. Add `OPENROUTER_API_KEY` for
live AI opponents, and `DATABASE_URL` plus `REDIS_URL` for persistent history and
leaderboard statistics. See [configuration](docs/configuration.md) for all options.

## Validation

Run these commands from the repository root:

```bash
npm --prefix backend test
npm --prefix frontend test
npm --prefix frontend run build
```

The automated suites cover matchmaking, socket ownership and reconnection,
message IDs, admin route configuration and authentication, AI prompt construction,
history persistence, leaderboard pagination, reverse geocoding, map rendering
conditions, and scoreboard storage. They run without production credentials.

Manual browser checks are documented separately:

- [Production gameplay and responsive QA](docs/qa/production-e2e-2026-10-14.md)
- [History map regression checks](docs/qa/history-map-fixes-e2e-2026-10-14.md)

## Game rules and implementation choices

Each completed round awards an identity-read score of **0 or 1**. A human round
also awards **0.0–1.0** location points based on haversine distance, rounded to one
decimal. An AI round awards **0 or 1** model points, requiring both a correct AI
identity guess and the exact model family.

Players use an anonymous browser-stored ID, with no account signup. Human locations
are estimated from IP addresses and rounded to one decimal before storage or
reveal. Active matches do not survive a backend restart; completed history does
when PostgreSQL is configured. AI provider credentials stay on the backend.

## Repository layout

```text
backend/
  ai/          AI personas, prompts, and provider adapters
  dev/         Local demo server, synthetic fixtures, and file-backed storage
  test/        Backend regression tests
frontend/
  src/         React screens, maps, styles, and browser storage
  test/        Frontend configuration, map, and storage regression tests
docs/
  qa/          Manual browser verification reports
```

Deployment, environment variables, admin setup, API routes, and map attribution
are covered in [configuration and deployment](docs/configuration.md).
