# Local run and deployment notes

This delivery supports production-style deployment on Render with LiveKit Cloud. It does not yet provide durable object storage or cloud recording storage.

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

## Render deployment

1. Push this repository to GitHub.
2. In Render, open **Blueprint** and select the repository. The [render.yaml](./render.yaml) creates the web/API service and PostgreSQL database.
3. Set `APP_ORIGIN` to the exact public Render URL, for example `https://littlemoment.onrender.com`, with no trailing slash.
4. Create a LiveKit Cloud project:
   - Open `https://cloud.livekit.io`.
   - Create or select a project.
   - Open **Settings** and find the project API keys.
   - Copy the project URL, API key, and API secret.
5. In the Render service environment, set:
   - `LIVEKIT_URL=wss://<project-subdomain>.livekit.cloud`
   - `LIVEKIT_API_KEY=<LiveKit API key>`
   - `LIVEKIT_API_SECRET=<LiveKit API secret>`
   - `APP_ORIGIN=https://<your-render-service>.onrender.com`
   - `SESSION_SECRET=<generate a random 32+-character value>`
   - `NODE_ENV=production`
   - `PRIVATE_MEDIA_DIR=/tmp/private-media`
   - `MAX_BIRTHDAY_VIDEO_BYTES=524288000`
6. Let Render run the build and pre-deploy Prisma migration, then open the Render service URL.

Database migrations run with `npm run db:deploy:render`. In the Render dashboard, a deployment's **Pre-Deploy** log should show migrations applied successfully.

### Render environment notes

- Use the database `connectionString` supplied by the Render Blueprint. Do not use a localhost PostgreSQL URL in production.
- Generate `SESSION_SECRET` with a cryptographically secure source. It must remain stable across restarts.
- `LIVEKIT_URL` must be the WebSocket URL from LiveKit Cloud, normally `wss://<project>.livekit.cloud`, not `https://` or the local Docker address.
- The API serves the built React SPA in production, so it uses the same Render origin for `/api`, `/socket.io`, and cookie sessions.
- `/tmp/private-media` is ephemeral. Uploads disappear when the Render instance restarts or is replaced. Use Render Persistent Disk or object storage before production use.
- LiveKit Cloud recording needs Egress and persistent output storage. The current recording service is configured for the local Docker Egress container and `/recordings`; it is not a durable Render Cloud recording setup yet.
