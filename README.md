# GeoTuring Backend

Minimal Node.js Express + Socket.IO backend ready for Railway deployment.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The server runs on `http://localhost:3000` by default.

## Scripts

- `npm start` - run the production server
- `npm run dev` - run the server with nodemon

## Environment Variables

- `PORT` - server port. Railway provides this automatically in production.
- `FRONTEND_URL` - allowed CORS origin, such as `http://localhost:5173` for local development or your deployed frontend URL.

## Endpoints

- `GET /` - basic API status
- `GET /health` - health check for deployment monitoring

## Railway

Railway will run `npm start` and provide `PORT` automatically. Set `FRONTEND_URL` in Railway once a frontend is deployed.
