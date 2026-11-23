# Little Moment — Project Surprise

A working local meeting app for a private birthday reveal. It combines a React client, an Express/Socket.IO API, PostgreSQL, LiveKit WebRTC, and local private video storage.

## Run locally

Prerequisites: Node.js 22+, Docker Desktop, and npm.

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` (the checked-in defaults are local development credentials only).
3. Start PostgreSQL and LiveKit: `docker compose up -d postgres livekit`
4. Generate Prisma client and migrate: `npm run db:generate` then `npm run db:migrate`
5. In separate terminals, run `npm run dev:api` and `npm run dev:web`.
6. Open `http://localhost:5173`.

The organizer creates a Secret Birthday room and shares the birthday-person link and hidden-friend invitation from Organizer controls. The local LiveKit config advertises loopback for WebRTC ICE, so it is intended for browsers on this same computer. For another computer, use a reachable LiveKit host and open the required media ports.

## Verify

- `npm run build` — typecheck and production frontend build.
- `npm run test:e2e` — multi-context browser journey using the running local API, database, and LiveKit service.

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for tested scope and limitations, [ARCHITECTURE.md](ARCHITECTURE.md) for the hidden-participant model, and [DEPLOYMENT.md](DEPLOYMENT.md) for environment and run details.
# BIRTHDAY
