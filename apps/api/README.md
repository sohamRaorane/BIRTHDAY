# API service

## Configuration

Use Node.js 22.22 or newer. Set `DATABASE_URL`, `APP_ORIGIN`, and a strong `SESSION_SECRET` (at least 32 characters). LiveKit tokens and reveal operations require `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. Generate the Prisma client with `npm run db:generate --workspace @surprise/api` after the Prisma schema is available. Prisma 7 reads its migration connection URL from `apps/api/prisma.config.ts`; remove `url` from the Prisma schema datasource as part of the schema-side Prisma 7 update.

## Private media storage

The current `LocalPrivateMediaStorage` implementation is for local development. Files are written outside the public web root with private file permissions, validated as MP4, WebM, or QuickTime, and limited to 100 MiB. Playback requires an active meeting participant and supports byte ranges for seeking.

Do not use local disk storage for production: it is not durable across hosts or deployments and is not shared across API instances. Replace the `MediaStorage` adapter with durable private object storage such as S3 or R2 before production deployment, keeping bucket objects private and authorizing playback through the API.

LiveKit updates hidden permissions one participant at a time. Reveal therefore releases currently connected guests near-simultaneously, waits for all provider calls to settle, and compensates successful calls if any peer update fails. The API commits participant visibility and emits the reveal/roster events only after every connected guest update succeeds; provider visibility itself is not an atomic batch operation.
