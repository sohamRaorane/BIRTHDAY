# Implementation status

Updated 2026-11-21. Scope is a working local end-to-end implementation; production deployment and production hardening are out of scope.

## Completed

- Monorepo foundation with React/TypeScript/Vite, Express/TypeScript, Socket.IO, shared contracts, Prisma, and PostgreSQL.
- Registration/login, persisted cookie sessions, meeting creation, birthday-person links, reusable hidden-friend invitations, join/leave, meeting snapshots, and authorization checks.
- LiveKit token issuance and actual client WebRTC room connection. Camera and microphone start off; explicit per-user controls publish/unpublish tracks. Screen share uses the browser media picker.
- Secret participant grants use LiveKit's hidden participant permission. The birthday client's server-filtered roster/snapshot/events omit hidden guests; organizer roster is protected by persisted organizer identity.
- Birthday video upload with local private storage, MIME/signature checks, byte-range playback, synchronized server start time, video completion, and an idempotent organizer reveal transition.
- Reveal changes visibility only. It does not change camera, microphone, or screen-share state.
- Socket.IO chat, participant status/readiness, visibility-filtered events, room controls, and reconnection snapshot reconciliation.
- Local Docker Compose services for PostgreSQL and LiveKit; setup and troubleshooting guidance in README.

## Verification performed

- `npm run db:generate` — passed.
- `npm run db:migrate` — passed; schema is in sync.
- `npm run build` — passed after the last verified application changes (rerun for final doc/config edits).
- `npm run test:e2e` — passed with independent Chromium contexts for organizer, birthday person, and hidden friend. Covers account/meeting/invites, actual LiveKit connection readiness, hidden roster/API filtering, unauthorized organizer controls, generated WebM upload and playback, reveal, unchanged camera/mic defaults, and chat.

## Known boundaries

- This is a local development app. The demo LiveKit credentials and local session config are not production secrets. Loopback ICE works only for clients on the same machine; remote participants need a reachable LiveKit deployment/network configuration.
- Birthday files are stored on local disk, not cloud object storage. Database cleanup/retention and broad browser/device coverage are not implemented.
- LiveKit infrastructure can observe room participants. “Hidden” means hidden from ordinary clients using the provider hidden permission plus server-filtered application APIs; it is not cryptographic invisibility.
- Reveal is idempotent and updates the server roster then provider visibility. Provider permission updates are not a distributed atomic transaction; clients reconcile against the backend snapshot.
- No production deployment was performed.
