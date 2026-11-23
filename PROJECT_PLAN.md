# Project Plan

## Repository inspection

Inspected `C:\soham\birthday` on 2026-11-21. The workspace contains no source files, package manifests, repository instructions, or existing features. This is a greenfield build; there is no current stack or functionality to preserve.

## Product and architecture decisions

- Build a TypeScript monorepo with a React/Vite frontend and Express/Socket.IO API.
- Use PostgreSQL and Prisma as durable state; use a modular monolith initially.
- Use LiveKit self-hosted in Docker Compose for local WebRTC and private local disk storage for birthday media; remote deployments can replace these with LiveKit Cloud and private object storage.
- Keep organizer-only state in server-authorized APIs and targeted Socket.IO rooms; never broadcast internal room state.
- Initialize all joining clients with camera disabled and microphone muted. Reveal only changes visibility.
- Treat deployment providers as configurable; no credentials or deployment target were present in the workspace.

## Hidden participant strategy

Issue secret guests LiveKit tokens with the documented hidden participant grant. Use backend participant records as the organizer's authoritative roster and readiness view. The birthday person receives only the visible roster via API/socket. LiveKit hidden status conceals a participant from other room clients, but is not cryptographic invisibility from the media provider or backend administrators. Keep organizer control actions outside room-wide LiveKit data packets. Reveal is a server-authorized, transactional/idempotent state transition followed by permission update and audience-scoped events. Never use reveal to change device state.

## Delivery phases

0. Inspect repository and define contracts — complete for the empty workspace; see architecture and contract docs.
1. Foundation: complete; see implementation status.
2. Authentication and meeting/invitation lifecycle: complete for local use.
3. LiveKit token service and real media controls: complete; local room connection verified.
4. Server-enforced hidden participant visibility and organizer dashboard: complete for hidden grants and server-filtered UI/API.
5. Birthday media storage and synchronized playback: complete with local private storage.
6. Idempotent reveal state machine: complete for local app workflow.
7. Chat and post-reveal meeting: complete.
8. Responsive polish and failure recovery: working UI; broader hardening remains out of scope.
9. Automated browser verification: core multi-context journey passes; see TESTING.md for coverage limits.
10. Public deployment: not performed; this delivery is local.

## Critical acceptance gate

Before building beyond the foundation, verify in a three-client environment that a hidden guest is absent from the birthday client's LiveKit participant collection, API responses, counts, and socket events, while the organizer can see that guest through the protected backend roster. Test visibility grant updates on the selected LiveKit deployment. Do not claim production readiness until that gate and the full real-browser journey pass.
