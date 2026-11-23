# Task Breakdown

| Workstream | Ownership | Depends on | Outputs |
|---|---|---|---|
| Architecture and contracts | Lead | Repository inspection | Architecture, schema, API and event contracts |
| Frontend | Frontend agent | Contracts and shared types | Landing/auth/dashboard/meeting/organizer UI |
| Backend | Backend agent | Schema and contracts | Auth, meetings, invitations, visibility, APIs, sockets |
| Media | Media agent | Participant model | LiveKit adapter, token policy, media controls, reconnect |
| Birthday orchestration | Surprise agent | Backend/media contracts | Video playback, readiness, state machine, reveal |
| QA/security | QA agent | Working integrated slices | Unit/integration/E2E/security coverage and report |
| Platform | DevOps agent | Selected stack/deployment | CI, config, migrations, health, deployment guide |

No parallel agent owns shared schema/contracts without lead coordination. All implementations must use backend-derived authorization and audience-filtered events. The current environment supports agents, but filesystem access must be writable before code work can begin.
