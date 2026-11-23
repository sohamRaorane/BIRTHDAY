# Architecture

## System shape

```text
React/Vite clients ── HTTPS/Socket.IO ── Express modular monolith ── PostgreSQL
         │                                      │
         └──────────── LiveKit WebRTC ──────────┤ (token/admin APIs)
                                                └── Object storage (birthday video)
```

The backend is the source of truth for identity, roles, invitations, participant visibility, readiness, meeting lifecycle, and reveal state. LiveKit handles media transport. PostgreSQL stores durable state. Socket.IO emits audience-filtered application events. Birthday video is stored in object storage and played through a normal HTML media element with server-coordinated start time; no screen-share dependency.

## Hidden participant isolation

Each participant has an application visibility state independent of room membership. Secret guests join LiveKit with `hidden: true`; clients do not receive their participant objects or join/leave events under the documented LiveKit behavior. Organizer roster and readiness use a separately authorized API/socket namespace keyed to server-validated organizer membership. Birthday clients get only visible application records. Never expose secret roster through room metadata, public meeting metadata, client participant APIs, generic socket broadcasts, chat history, or counts.

The organizer is a normal visible LiveKit participant so the birthday person sees and hears the organizer. Secret guests are hidden from all ordinary LiveKit clients, including organizer clients; organizers inspect guest presence/status in the backend dashboard. The design does not promise the organizer can receive secret guests' media before reveal. After reveal, the backend changes application visibility and LiveKit participant permission, then emits the visible roster and reveal event. Device permissions are untouched. Validate permission update behavior and reconnect/token replacement in the chosen LiveKit deployment before launch.

This is concealment from unauthorized room clients, not cryptographic invisibility from LiveKit infrastructure, server administrators, or a compromised organizer account. A separate-room media bridge is the stronger isolation alternative, with substantial forwarding complexity, and should be adopted if the threat model requires that stronger boundary.

## Backend modules

- Identity/authentication and session
- Meetings, invitations, and lifecycle
- Membership/roles/visibility
- LiveKit token and room administration adapter
- Birthday media and upload authorization
- Surprise state machine and audit events
- Chat and audience-filtered realtime gateway

Use Zod at HTTP/socket boundaries. Organizer authorization is resolved from persisted membership, never a client-supplied role. Persist state transition and outbox event in one transaction; publish idempotently.

## Reveal state machine

`CREATED → WAITING_FOR_PARTICIPANTS → READY → VIDEO_PLAYING → VIDEO_COMPLETED → REVEALED → ENDED`

Organizer-only transitions are validated server-side. Start/reveal requests carry idempotency keys. The reveal transaction changes visibility and state exactly once; retry returns the already-committed result. Socket delivery is retriable and clients reconcile from authorized snapshot endpoints after reconnect. Reveal does not publish tracks, change subscriptions, or toggle camera/microphone.

## Operational requirements

Use structured logs with request/correlation IDs, health/readiness endpoints, short-lived media tokens, rate limits, upload constraints, database migrations, secret manager configuration, and provider adapters. Keep LiveKit API secrets and object-storage credentials on the backend.
