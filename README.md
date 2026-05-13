# GeoTuring

GeoTuring is a real-time social deduction web game. A player chats anonymously
with either a human-like participant or an AI-like participant, then guesses who
they were talking to. Human guesses continue into a lightweight GeoGuessr-style
map pin; AI guesses continue into a model-family pick.

This repo is intentionally small for the MVP:

- `backend/` - Express + Socket.IO API for Railway at `api.geoturing.com`
- `frontend/` - Vite React client for Railway at `geoturing.com`
- In-memory sessions only
- Mock human and AI opponents only
- No login, payments, database, Mapbox, or external AI APIs yet

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

## Environment Variables

Backend:

- `PORT` - server port. Railway provides this automatically in production.
- `FRONTEND_URL` - allowed CORS origin, such as `http://localhost:5173` or
  `https://geoturing.com`.

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
- `partner:message` - simulated partner sends a chat message
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

## Current TODOs

- Replace simulated human opponents with real human matchmaking.
- Add persistent game history once the MVP flow is stable.
- Swap mock AI adapters for real provider-backed adapters when API keys and
  product rules are ready.
