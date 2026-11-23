# Security and Threat Model

## Assets and actors

Protect account credentials, invitation capabilities, meeting membership, secret guest identity/status, organizer controls, birthday media, and chat. Actors include organizer, birthday participant, invited guest, unauthenticated visitor, compromised participant session, backend operator, and media-provider operator.

## Controls

- Resolve roles and visibility from persisted server state; never accept client role claims.
- Hash invitation tokens and scope/expire them; rate-limit joins and auth.
- Keep organizer roster/control APIs and socket rooms separate from birthday-visible channels.
- Issue short-lived, meeting-scoped LiveKit tokens. Keep admin credentials server-only.
- Use LiveKit hidden participant grant for guests before reveal; verify exact provider behavior in integration tests.
- Validate media MIME/size, use private object storage and time-limited signed URLs.
- Persist reveal transition transactionally and audit organizer actions.
- Use secure cookies, HTTPS, CSRF protection where applicable, security headers, input validation, and secret manager configuration.

## Limits

LiveKit hidden status conceals guests from ordinary room clients; it does not claim cryptographic invisibility from LiveKit or privileged backend operators. A compromised organizer account can see the roster. Timing/traffic inference and collusion by invited guests are outside the secrecy guarantee. For a stronger boundary, use separate media rooms plus a trusted media bridge and explicitly assess bridge/operator exposure.

## Launch review

Verify API/socket enumeration resistance, token scope/expiry, duplicate reveal behavior, upload policy, access logs, and provider permission update semantics. No security test has run yet.
