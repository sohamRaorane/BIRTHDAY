# API Contracts

All endpoints are versioned under `/api/v1`; JSON inputs and outputs are runtime-validated. Authentication uses secure, HttpOnly, SameSite cookies (or an established OIDC provider). Do not put bearer secrets in URLs except single-use invitation tokens, which are exchanged immediately and redacted from logs.

- `POST /auth/register`, `/auth/login`, `/auth/logout`; `GET /auth/me`.
- `POST /meetings`: authenticated organizer creates meeting; returns public join URL and private organizer URL separately.
- `GET /meetings/:code`: returns only birthday-visible metadata after valid join authorization.
- `POST /meetings/:code/join`: exchanges invite token, creates participant session, returns visible snapshot and short-lived LiveKit token; secret guest token uses server-selected hidden permission and camera/mic publish defaults disabled until user acts.
- `POST /meetings/:id/leave`: idempotent leave.
- `GET /meetings/:id/organizer/participants`: organizer-only complete participant/readiness roster.
- `PUT /meetings/:id/organizer/media`: organizer-only presigned upload workflow; validate size/type and finalize metadata.
- `POST /meetings/:id/organizer/video/start`: organizer-only, idempotent playback start with server timestamp.
- `POST /meetings/:id/organizer/reveal`: organizer-only idempotent transition; never accepts device-state changes.
- `POST /meetings/:id/organizer/end`: organizer-only idempotent end.
- `GET /meetings/:id/snapshot`: audience-filtered state; secret roster fields are never serialized to birthday participant.

Use consistent errors `{ error: { code, message, requestId } }`. Apply per-user/IP rate limits to auth, joins, invitations, and upload signing. Never return LiveKit admin credentials, raw invite tokens, hidden identities, or internal provider participant lists to birthday clients.
