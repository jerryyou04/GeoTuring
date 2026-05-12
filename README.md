# GeoTuring

Minimal full-stack GeoTuring starter with a Railway-ready backend and frontend.

## Project Structure

```text
backend/
  server.js
  package.json
  .env.example

frontend/
  src/
  package.json
  .env.example
```

## Backend Setup

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

The backend runs on `http://localhost:3000` by default.

## Frontend Setup

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
- `FRONTEND_URL` - allowed CORS origin, such as `http://localhost:5173` for local development or your deployed frontend URL.

Frontend:

- `VITE_API_URL` - backend API URL, such as `http://localhost:3000` locally or your deployed backend URL.

## Endpoints

- `GET /` - basic API status
- `GET /health` - health check for deployment monitoring

## Railway

Create two Railway services from this repo:

- Backend service root directory: `backend`
- Frontend service root directory: `frontend`

Set `FRONTEND_URL` on the backend service to your Railway frontend URL. Set `VITE_API_URL` on the frontend service to your Railway backend URL.
