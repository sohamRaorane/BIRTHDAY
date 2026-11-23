# Testing

## Automated end-to-end

With Docker Compose services and both local dev servers running, execute `npm run test:e2e`. The Playwright journey uses separate browser contexts for organizer, birthday person, and a hidden friend. It covers registration, meeting and invitations, actual LiveKit connection readiness, server-filtered participant/API visibility, organizer-only controls, a generated WebM upload and playback URL, playback completion, reveal, unchanged camera/microphone defaults, and chat.

The reveal test simulates the media element's `ended` event after confirming the birthday video is served. It does not wait for a full-length birthday video.

## Build and database

- `npm run build`
- `npm run db:generate`
- `npm run db:migrate`

## Current coverage boundary

Automated real-device camera/microphone publishing, screen-share capture, refresh/reconnect recovery, invitation expiry, and multiple browser engines are not covered by the current E2E suite. LiveKit connection establishment is verified, but no real microphone or camera is automatically enabled during the test. A broader browser/device and failure-injection suite would be the next testing increment.
