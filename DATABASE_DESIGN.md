# Database Design

PostgreSQL is the source of truth. Prisma schema/migrations will enforce foreign keys, uniqueness, and indexes. IDs are UUIDs unless a provider requires otherwise. Timestamps are UTC.

## Tables

- `User`: id, email (unique), name, passwordHash or authProvider/subject, avatarUrl, createdAt, updatedAt.
- `Meeting`: id, title, roomCode (unique random identifier), organizerId, status, secretBirthdayMode, surpriseState, birthdayMessage, livekitRoomName (unique), createdAt, expiresAt, endedAt.
- `MeetingParticipant`: id, meetingId, userId nullable for guest access, displayName, role, visibility, connectionStatus, cameraEnabled, microphoneEnabled, screenSharing, ready, joinedAt, leftAt. Unique active identity per meeting; never trust role from client.
- `MeetingInvitation`: id, meetingId, tokenHash unique, invitedEmail nullable, role, visibilityOnJoin, expiresAt, usedAt, createdBy.
- `BirthdayMedia`: id, meetingId unique, uploadedBy, storageKey unique, fileName, mimeType, byteSize, durationSeconds nullable, createdAt.
- `ChatMessage`: id, meetingId, participantId, body, createdAt; visibility policy is enforced at query time and secret-mode rules are explicit.
- `MeetingEvent`: id, meetingId, actorId nullable, eventType, metadata JSON, createdAt; append-only audit trail.
- `OutboxEvent`: id, aggregateType, aggregateId, eventType/version, payload JSON, createdAt, publishedAt, attempts.

Index `(meetingId, connectionStatus)`, `(meetingId, visibility)`, `(meetingId, createdAt)` for messages/events, invitation token hash and expiry, and outbox publication state. Add database constraints for enum states and positive media size. Hash invitation bearer tokens; do not store raw invite tokens. Use transactions for join/leave, reveal, and meeting end. Avoid persisting transient device state as authoritative media permissions; participant media status is observational.

## Authorization invariant

Only backend-resolved organizer membership can query secret participant records or mutate surprise state. Guest invitation grants are scoped to one meeting and cannot select organizer role or visibility. Birthday-person participant queries use a visibility-filtered repository method by default; an explicit privileged method requires organizer authorization.
