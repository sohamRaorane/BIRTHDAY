# Realtime Events

Socket.IO connections authenticate with the same secure session. Join rooms only after backend authorization. Use separate namespaces/rooms for public-visible meeting events and organizer-only control events. Validate every payload with Zod; reject unauthorized events and rate-limit chat/control actions. Never broadcast raw provider room state.

## Client → server

`meeting:join`, `meeting:leave`, `participant:camera-toggle`, `participant:microphone-toggle`, `participant:screen-share-start`, `participant:screen-share-stop`, `participant:ready`, `chat:send`, `organizer:video-start`, `organizer:reveal`, `organizer:end-meeting`.

Payloads carry meeting ID, request/event ID, and narrowly scoped values. Identity, role, visibility, and room membership come from the authenticated server session. Organizer actions require persisted organizer authorization.

## Server → birthday-visible audience

`meeting:joined`, `meeting:ended`, `participant:visible-joined`, `participant:visible-left`, `participant:media-updated`, `chat:message`, `birthday:video-started`, `birthday:video-completed`, `birthday:reveal`, `meeting:error`.

## Organizer-only audience

`organizer:participant-joined`, `organizer:participant-left`, `organizer:participant-status`, `organizer:readiness`, `organizer:surprise-state`.

Events include schema version and stable event ID. Hidden participant events are never sent to birthday-visible rooms. On reconnect, clients fetch the audience-filtered snapshot; events are hints, not the only source of truth. Reveal publishes a single committed state version and is idempotent; device states are excluded from its mutation payload.
