# Local run and deployment notes

This delivery targets local end-to-end use. It is not deployed to a public host.

## Local services

Copy `.env.example` to `.env`, then run `docker compose up -d postgres livekit`. PostgreSQL is published at `localhost:5440`; LiveKit signaling is at `ws://127.0.0.1:7880`, with its local ICE transport ports configured in `docker-compose.yml` and `livekit.yaml`. The local `node_ip: 127.0.0.1` is deliberate for same-computer browser tests. It will not work for remote clients.

Run `npm install`, `npm run db:generate`, `npm run db:migrate`, and then start API and web using `npm run dev:api` and `npm run dev:web` in separate terminals. The API health endpoint is `http://localhost:3001/api/v1/health`; the frontend is `http://localhost:5173`.

## Environment variables

See `.env.example` for all variables:

- `DATABASE_URL`, `POSTGRES_PASSWORD`
- `PORT`, `APP_ORIGIN`, `SESSION_SECRET`
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `PRIVATE_MEDIA_DIR`, `MAX_BIRTHDAY_VIDEO_BYTES`

The checked-in example credentials are for local development only. `.env` is ignored by Git.

## If hosting for remote participants later

Use a reachable LiveKit host or LiveKit Cloud; configure public DNS/TLS and UDP/TCP ICE reachability (or TURN) according to the provider's deployment guide. Replace local disk media with private object storage, set production origins and secure cookies, use managed PostgreSQL and secret storage, then run migration and multi-client privacy/reveal smoke tests against the deployed services. This project has not been deployed, and remote connectivity has not been verified.
