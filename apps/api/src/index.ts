import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { Server, type Socket } from "socket.io";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "./db.js";
import { livekitProvider } from "./providers/livekit.js";
import { mediaStorage, maxVideoBytes } from "./providers/media-storage.js";

const app = express();
const server = createServer(app);
const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
const isProduction = process.env.NODE_ENV === "production";
const userCookie = "surprise_session";
const participantCookie = "surprise_participant";

type Principal = { userId?: string; participantId?: string };
declare global { namespace Express { interface Request { principal?: Principal; requestId?: string } } }
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const cookieOptions = { httpOnly: true, secure: isProduction, sameSite: "lax" as const, path: "/", maxAge: 7 * 24 * 60 * 60 * 1000 };
const setSession = async (res: Response, id: string, kind: "user" | "participant") => {
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({ data: { tokenHash: tokenHash(raw), ...(kind === "user" ? { userId: id } : { participantId: id }), expiresAt: new Date(Date.now() + cookieOptions.maxAge) } });
  res.cookie(kind === "user" ? userCookie : participantCookie, raw, cookieOptions);
};
const clearSessions = async (req: Request, res: Response) => {
  const tokens = [req.cookies[userCookie], req.cookies[participantCookie]].filter((x): x is string => typeof x === "string");
  if (tokens.length) await prisma.session.deleteMany({ where: { tokenHash: { in: tokens.map(tokenHash) } } });
  res.clearCookie(userCookie, cookieOptions); res.clearCookie(participantCookie, cookieOptions);
};

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin, credentials: true }));
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use(async (req, res, next) => {
  req.requestId = typeof req.header("x-request-id") === "string" ? req.header("x-request-id")!.slice(0, 100) : randomUUID();
  res.setHeader("x-request-id", req.requestId);
  try {
    const tokens = [req.cookies[userCookie], req.cookies[participantCookie]].filter((x): x is string => typeof x === "string");
    const rows = tokens.length ? await prisma.session.findMany({ where: { tokenHash: { in: tokens.map(tokenHash) }, expiresAt: { gt: new Date() } } }) : [];
    const u = rows.find((x) => x.userId); const p = rows.find((x) => x.participantId);
    req.principal = { ...(u?.userId ? { userId: u.userId } : {}), ...(p?.participantId ? { participantId: p.participantId } : {}) }; next();
  } catch (e) { next(e); }
});
app.use((req, _res, next) => { const start = Date.now(); next(); _res.on("finish", () => console.info(JSON.stringify({ level: "info", event: "http_request", requestId: req.requestId, method: req.method, path: req.path, status: _res.statusCode, durationMs: Date.now() - start }))); });
app.use((req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.cookies[userCookie] || req.cookies[participantCookie]) {
    if (req.get("origin") !== origin) return next(Object.assign(new Error("Request origin is not allowed"), { status: 403, code: "CSRF_REJECTED" }));
  }
  next();
});

const router = express.Router();
const makeRateLimit = (windowMs: number, limit: number) => rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, handler: (req, res) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests; try again shortly", requestId: req.requestId } }) });
const authLimit = makeRateLimit(15 * 60_000, 20);
const joinLimit = makeRateLimit(15 * 60_000, 30);
const controlLimit = makeRateLimit(60_000, 30);
const chatHttpLimit = makeRateLimit(10_000, 5);
function fail(status: number, code: string, message: string): never { throw Object.assign(new Error(message), { status, code }); }
const requireUser = (req: Request): string => { const id = req.principal?.userId; if (!id) fail(401, "UNAUTHENTICATED", "Sign in to continue"); return id; };
const param = (req: Request, key: string) => z.string().min(1).parse(req.params[key]);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) fail(400, "VALIDATION_ERROR", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")); return result.data as T; };
const emailSchema = z.string().trim().email().max(254).transform((s) => s.toLowerCase());
const registerSchema = z.object({ email: emailSchema, password: z.string().min(12).max(128), name: z.string().trim().min(1).max(80) });
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) });
const createMeetingSchema = z.object({ title: z.string().trim().min(1).max(120), secretBirthdayMode: z.boolean().default(false), birthdayMessage: z.string().trim().max(2000).optional(), expiresAt: z.coerce.date().optional() });
const joinSchema = z.object({ displayName: z.string().trim().min(1).max(80).optional(), inviteToken: z.string().min(16).max(256).optional() });
const chatSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const activeParticipantWhere = { leftAt: null };
const hashToken = (token: string) => tokenHash(`invite:${token}`);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxVideoBytes, files: 1, fields: 2 }, fileFilter: (_req, file, cb) => ["video/mp4", "video/webm", "video/quicktime"].includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error("Only MP4, WebM, or QuickTime video is supported"), { status: 415, code: "UNSUPPORTED_VIDEO" })) });

router.get("/health", (_req, res) => res.json({ status: "ok", service: "project-surprise-api" }));
router.post("/auth/register", authLimit, async (req, res) => {
  const input = parse(registerSchema, req.body);
  const passwordHash = await bcrypt.hash(input.password, 12);
  try {
    const user = await prisma.user.create({ data: { email: input.email, name: input.name, passwordHash }, select: { id: true, email: true, name: true, avatarUrl: true } });
    await setSession(res, user.id, "user"); res.status(201).json({ user });
  } catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") fail(409, "EMAIL_EXISTS", "An account with this email already exists"); throw e; }
});
router.post("/auth/login", authLimit, async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) fail(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  await setSession(res, user.id, "user"); res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } });
});
router.post("/auth/logout", async (req, res) => { await clearSessions(req, res); res.status(204).end(); });
router.get("/auth/me", async (req, res) => {
  const userId = req.principal?.userId; if (!userId) fail(401, "UNAUTHENTICATED", "Sign in to continue");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, avatarUrl: true } });
  if (!user) fail(401, "UNAUTHENTICATED", "Sign in to continue"); res.json({ user });
});
router.get("/users/me", async (req, res) => {
  const userId = requireUser(req); const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, avatarUrl: true, createdAt: true } });
  if (!user) fail(401, "UNAUTHENTICATED", "Sign in to continue"); res.json({ user });
});
router.patch("/users/me", async (req, res) => {
  const userId = requireUser(req); const input = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), avatarUrl: z.string().url().max(2048).nullable().optional() }).refine((x) => Object.keys(x).length > 0), req.body);
  const user = await prisma.user.update({ where: { id: userId }, data: input, select: { id: true, email: true, name: true, avatarUrl: true } }); res.json({ user });
});

router.post("/meetings", async (req, res) => {
  const organizerId = requireUser(req); const input = parse(createMeetingSchema, req.body);
  const roomCode = randomBytes(9).toString("base64url"); const id = randomUUID();
  const organizer = await prisma.user.findUniqueOrThrow({ where: { id: organizerId }, select: { name: true } });
  const expiresAt = input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60_000);
  const birthdayToken = input.secretBirthdayMode ? randomBytes(32).toString("base64url") : undefined;
  const meeting = await prisma.meeting.create({ data: { id, title: input.title, roomCode, organizerId, secretBirthdayMode: input.secretBirthdayMode, birthdayMessage: input.birthdayMessage, livekitRoomName: `meeting-${id}`, expiresAt, participants: { create: { userId: organizerId, displayName: organizer.name, role: "ORGANIZER", visibility: "VISIBLE", connectionStatus: "CONNECTING" } }, ...(birthdayToken ? { invitations: { create: { tokenHash: hashToken(birthdayToken), role: "BIRTHDAY_GUEST", visibilityOnJoin: "VISIBLE", createdBy: organizerId, expiresAt } } } : {}) } });
  const participant = await prisma.meetingParticipant.findFirstOrThrow({ where: { meetingId: meeting.id, userId: organizerId, role: "ORGANIZER", leftAt: null } }); await setSession(res, participant.id, "participant");
  const birthdayUrl = birthdayToken ? `${origin}/join/${meeting.roomCode}?token=${encodeURIComponent(birthdayToken)}` : undefined;
  res.status(201).json({ meeting: publicMeeting(meeting), joinUrl: birthdayUrl ?? `${origin}/join/${meeting.roomCode}`, ...(birthdayUrl ? { birthdayUrl } : {}), organizerUrl: `${origin}/meetings/${meeting.id}/organizer`, participantId: participant.id });
});
function publicMeeting(m: { id: string; title: string; roomCode: string; status: string; createdAt: Date; expiresAt: Date }) { return { id: m.id, title: "Meeting Room", roomCode: m.roomCode, status: m.status, createdAt: m.createdAt, expiresAt: m.expiresAt }; }
async function getMeeting(req: Request) { const idOrCode = req.params.id ?? req.params.code; if (typeof idOrCode !== "string") fail(400, "VALIDATION_ERROR", "Meeting ID or code is required"); const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idOrCode); const meeting = looksLikeUuid ? await prisma.meeting.findUnique({ where: { id: idOrCode } }) : await prisma.meeting.findUnique({ where: { roomCode: idOrCode } }); if (!meeting) fail(404, "MEETING_NOT_FOUND", "Meeting not found"); return meeting; }
async function getParticipant(req: Request, meetingId: string) { const pid = req.principal?.participantId; if (pid) { const p = await prisma.meetingParticipant.findFirst({ where: { id: pid, meetingId, leftAt: null } }); if (p) return p; } const userId = req.principal?.userId; if (userId) { const p = await prisma.meetingParticipant.findFirst({ where: { meetingId, userId, leftAt: null } }); if (p) return p; } fail(403, "MEETING_MEMBERSHIP_REQUIRED", "Join this meeting to continue"); }
async function assertOrganizer(req: Request, meetingId: string) { const userId = requireUser(req); const meeting = await prisma.meeting.findFirst({ where: { id: meetingId, organizerId: userId } }); if (!meeting) fail(403, "ORGANIZER_REQUIRED", "Organizer access required"); return meeting; }
function visibleSnapshot(m: Awaited<ReturnType<typeof prisma.meeting.findFirstOrThrow>>, participants: Awaited<ReturnType<typeof prisma.meetingParticipant.findMany>>, messages: Array<{ id: string; body: string; createdAt: Date; participant: { id: string; displayName: string } }>, organizer: boolean) {
  const state = m.surpriseState === "REVEALED" ? "REVEALED" : m.surpriseState === "ENDED" ? "ENDED" : ["VIDEO_PLAYING", "VIDEO_COMPLETED"].includes(m.surpriseState) ? "MEDIA_PLAYING" : "WAITING";
  return { meeting: { id: m.id, title: m.title, status: m.status, state, ...(organizer ? { surpriseState: m.surpriseState, birthdayMessage: m.birthdayMessage } : m.surpriseState === "REVEALED" ? { revealMessage: m.birthdayMessage } : {}), expiresAt: m.expiresAt }, participants: participants.map((p) => ({ id: p.id, displayName: p.displayName, role: organizer || !m.secretBirthdayMode || m.surpriseState === "REVEALED" ? p.role : "GUEST", visibility: p.visibility, connectionStatus: p.connectionStatus, cameraEnabled: p.cameraEnabled, microphoneEnabled: p.microphoneEnabled, screenSharing: p.screenSharing, ...(organizer ? { ready: p.ready, userId: p.userId } : {}) })), messages: messages.map((x) => ({ id: x.id, body: x.body, createdAt: x.createdAt, participant: { id: x.participant.id, displayName: x.participant.displayName } })) };
}
async function snapshot(meetingId: string, organizer: boolean, participantId?: string) {
  const m = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
  const participants = organizer ? await prisma.meetingParticipant.findMany({ where: { meetingId, ...activeParticipantWhere }, orderBy: { joinedAt: "asc" } }) : [];
  const messages = await prisma.chatMessage.findMany({ where: { meetingId, ...(!organizer && participantId ? { participantId } : {}) }, include: { participant: { select: { id: true, displayName: true } } }, orderBy: { createdAt: "asc" }, take: 200 });
  const visible = visibleSnapshot(m, participants, messages, organizer);
  const media = await prisma.birthdayMedia.findUnique({ where: { meetingId }, select: { id: true, fileName: true, mimeType: true, byteSize: true } });
  const state = m.surpriseState === "REVEALED" ? "REVEALED" : m.surpriseState === "ENDED" ? "ENDED" : ["VIDEO_PLAYING", "VIDEO_COMPLETED"].includes(m.surpriseState) ? "MEDIA_PLAYING" : "WAITING";
  return { snapshot: { id: m.id, title: organizer || !m.secretBirthdayMode || m.surpriseState === "REVEALED" ? m.title : "Meeting Room", status: m.status, state, ...(organizer ? { surpriseState: m.surpriseState, birthdayMessage: m.birthdayMessage, birthdayVideoStartedAt: m.birthdayVideoStartedAt?.toISOString() ?? null } : m.surpriseState === "REVEALED" ? { revealMessage: m.birthdayMessage, mediaStartedAt: m.birthdayVideoStartedAt?.toISOString() ?? null } : m.birthdayVideoStartedAt ? { mediaStartedAt: m.birthdayVideoStartedAt.toISOString() } : {}), participants: organizer ? visible.participants : [], ...(media && (organizer || !m.secretBirthdayMode || m.surpriseState === "VIDEO_PLAYING" || m.surpriseState === "VIDEO_COMPLETED" || m.surpriseState === "REVEALED") ? { media: { ...(organizer ? media : { mimeType: media.mimeType }), ...(organizer ? { byteSize: media.byteSize.toString() } : {}), playbackUrl: `/api/v1/meetings/${m.id}/media` } } : {}) }, messages: visible.messages };
}
router.get("/meetings/current", async (req, res) => {
  const now = new Date();
  const participantId = req.principal?.participantId;
  let participant = participantId ? await prisma.meetingParticipant.findFirst({ where: { id: participantId, leftAt: null }, include: { meeting: true } }) : null;
  if (!participant && req.principal?.userId) participant = await prisma.meetingParticipant.findFirst({ where: { userId: req.principal.userId, role: "ORGANIZER", leftAt: null, meeting: { status: { in: ["SCHEDULED", "ACTIVE"] }, expiresAt: { gt: now } } }, include: { meeting: true }, orderBy: { joinedAt: "desc" } });
  if (!participant || participant.meeting.status === "ENDED" || participant.meeting.status === "EXPIRED" || participant.meeting.expiresAt <= now) fail(404, "ACTIVE_MEETING_NOT_FOUND", "No active meeting session was found");
  res.json({ ...await snapshot(participant.meetingId, participant.role === "ORGANIZER", participant.id), participantId: participant.id, isOrganizer: participant.role === "ORGANIZER", roomCode: participant.meeting.roomCode, displayName: participant.displayName });
});
router.get("/meetings/:code", async (req, res) => { const m = await getMeeting(req); await getParticipant(req, m.id); res.json({ meeting: publicMeeting(m) }); });
router.post("/meetings/:code/join", joinLimit, async (req, res) => {
  const m = await getMeeting(req); if (m.status === "ENDED" || m.expiresAt <= new Date()) fail(410, "MEETING_CLOSED", "This meeting is closed");
  const body = req.body && typeof req.body === "object" ? { ...req.body, ...(typeof req.query.token === "string" ? { inviteToken: req.query.token } : {}) } : req.body;
  const input = parse(joinSchema, body);
  const invite = input.inviteToken ? await prisma.meetingInvitation.findFirst({ where: { meetingId: m.id, tokenHash: hashToken(input.inviteToken), expiresAt: { gt: new Date() } } }) : null;
  if (input.inviteToken && !invite) fail(401, "INVALID_INVITATION", "Invitation is invalid or expired");
  if (invite?.role === "ORGANIZER") fail(403, "INVALID_INVITATION_ROLE", "Invitation role is not permitted");
  const cookieParticipant = req.principal?.participantId ? await prisma.meetingParticipant.findFirst({ where: { id: req.principal.participantId, meetingId: m.id, leftAt: null } }) : null;
  const userId = req.principal?.userId ?? null;
  const userParticipant = !cookieParticipant && userId ? await prisma.meetingParticipant.findFirst({ where: { meetingId: m.id, userId, leftAt: null } }) : null;
  const existing = cookieParticipant ?? userParticipant;
  if (existing) {
    if (invite && (existing.role !== invite.role || existing.visibility !== invite.visibilityOnJoin)) fail(409, "PARTICIPANT_SESSION_CONFLICT", "This browser already has a different meeting role. Open this invitation in a separate browser profile.");
    const participant = await prisma.meetingParticipant.update({ where: { id: existing.id }, data: { connectionStatus: "CONNECTING" } });
    if (!cookieParticipant) await setSession(res, participant.id, "participant");
    publishParticipantStatus(m.id, participant);
    const data = await snapshot(m.id, participant.role === "ORGANIZER", participant.id); res.json({ ...data, participantId: participant.id, isOrganizer: participant.role === "ORGANIZER", livekit: { available: Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) } });
    return;
  }
  if (!input.displayName) fail(400, "VALIDATION_ERROR", "displayName is required for a new participant");
  let role: "GUEST" | "BIRTHDAY_GUEST" = invite?.role ?? "GUEST"; let visibility: "VISIBLE" | "HIDDEN" = invite?.visibilityOnJoin ?? (m.secretBirthdayMode ? "HIDDEN" : "VISIBLE");
  if (!invite && m.secretBirthdayMode) fail(401, "INVITATION_REQUIRED", "Use your personal invitation link to join this meeting");
  const participant = await prisma.meetingParticipant.create({ data: { meetingId: m.id, userId, displayName: input.displayName, role, visibility, connectionStatus: "CONNECTING" } });
  await setSession(res, participant.id, "participant"); publishParticipantJoined(m.id, participant);
  const data = await snapshot(m.id, participant.role === "ORGANIZER", participant.id); res.json({ ...data, participantId: participant.id, isOrganizer: participant.role === "ORGANIZER", livekit: { available: Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) } });
});
router.post("/meetings/:id/leave", async (req, res) => { const m = await getMeeting(req); const p = await getParticipant(req, m.id); if (process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) { try { await livekitProvider().removeParticipant(m.livekitRoomName, p.id); } catch (error) { console.error(JSON.stringify({ level: "warn", event: "livekit_leave_remove_failed", meetingId: m.id, participantId: p.id, message: String(error) })); } } await prisma.meetingParticipant.updateMany({ where: { id: p.id, leftAt: null }, data: { leftAt: new Date(), connectionStatus: "DISCONNECTED" } }); const updated = await prisma.meetingParticipant.findUniqueOrThrow({ where: { id: p.id } }); const raw = req.cookies[participantCookie]; if (typeof raw === "string") await prisma.session.deleteMany({ where: { tokenHash: tokenHash(raw) } }); res.clearCookie(participantCookie, cookieOptions); publishParticipantLeft(m.id, updated); res.status(204).end(); });
router.get("/meetings/:id/snapshot", async (req, res) => { const m = await getMeeting(req); const p = await getParticipant(req, m.id); res.json({ ...await snapshot(m.id, p.role === "ORGANIZER", p.id), participantId: p.id }); });
router.get("/meetings/:id/organizer/participants", async (req, res) => { const m = await getMeeting(req); await assertOrganizer(req, m.id); const participants = await prisma.meetingParticipant.findMany({ where: { meetingId: m.id }, orderBy: { joinedAt: "asc" } }); res.json({ participants }); });
router.post("/meetings/:id/participants/ready", async (req, res) => { const m = await getMeeting(req); const p = await getParticipant(req, m.id); const input = parse(z.object({ ready: z.boolean() }), req.body); const updated = await prisma.meetingParticipant.update({ where: { id: p.id }, data: { ready: input.ready } }); publishParticipantStatus(m.id, updated); publishReadiness(m.id, updated); res.json({ participantId: updated.id, ready: updated.ready }); });

router.post("/meetings/:id/organizer/video/start", controlLimit, async (req, res) => { const m = await getMeeting(req); await assertOrganizer(req, m.id); const result = await prisma.$transaction(async (tx) => { const current = await tx.meeting.findUniqueOrThrow({ where: { id: m.id } }); if (current.surpriseState === "VIDEO_PLAYING" || current.surpriseState === "VIDEO_COMPLETED" || current.surpriseState === "REVEALING" || current.surpriseState === "REVEALED" || current.surpriseState === "ENDED") return { meeting: current, changed: false }; const startedAt = new Date(); const meeting = await tx.meeting.update({ where: { id: m.id }, data: { surpriseState: "VIDEO_PLAYING", status: "ACTIVE", birthdayVideoStartedAt: startedAt, events: { create: { actorId: req.principal!.userId, eventType: "VIDEO_STARTED", metadata: { startedAt: startedAt.toISOString() } } } } }); return { meeting, changed: true }; }); const payload = { meetingId: m.id, state: "MEDIA_PLAYING", startedAt: result.meeting.birthdayVideoStartedAt }; if (result.changed) publish(m.id, "media:started", payload); res.json(payload); });
router.post("/meetings/:id/organizer/video/end", controlLimit, async (req, res) => { const m = await getMeeting(req); await assertOrganizer(req, m.id); const result = await prisma.$transaction(async (tx) => { const current = await tx.meeting.findUniqueOrThrow({ where: { id: m.id } }); if (current.surpriseState !== "VIDEO_PLAYING") return { meeting: current, changed: false }; const meeting = await tx.meeting.update({ where: { id: m.id }, data: { surpriseState: "VIDEO_COMPLETED", events: { create: { actorId: req.principal!.userId, eventType: "VIDEO_COMPLETED" } } } }); return { meeting, changed: true }; }); const payload = { meetingId: m.id, state: "MEDIA_PLAYING" }; if (result.changed) publish(m.id, "media:completed", payload); res.json(payload); });
router.post("/meetings/:id/video/end", async (req, res) => {
  const m = await getMeeting(req); const participant = await getParticipant(req, m.id);
  const result = await prisma.$transaction(async (tx) => { const current = await tx.meeting.findUniqueOrThrow({ where: { id: m.id } }); if (current.surpriseState === "VIDEO_COMPLETED" || current.surpriseState === "REVEALING" || current.surpriseState === "REVEALED" || current.surpriseState === "ENDED") return { meeting: current, changed: false }; if (current.surpriseState !== "VIDEO_PLAYING") fail(409, "VIDEO_NOT_PLAYING", "Video playback has not started"); const meeting = await tx.meeting.update({ where: { id: m.id }, data: { surpriseState: "VIDEO_COMPLETED", events: { create: { actorId: participant.userId, eventType: "VIDEO_COMPLETED", metadata: { source: "participant" } } } } }); return { meeting, changed: true }; });
  const payload = { meetingId: m.id, state: "MEDIA_PLAYING" }; if (result.changed) publish(m.id, "media:completed", payload); res.json(payload);
});
router.post("/meetings/:id/organizer/reveal", controlLimit, async (req, res) => {
  const m = await getMeeting(req); await assertOrganizer(req, m.id);
  const lockHash = tokenHash(`reveal-lock:${m.id}`); const lockId = randomUUID();
  await prisma.session.deleteMany({ where: { tokenHash: lockHash, expiresAt: { lte: new Date() } } });
  try { await prisma.session.create({ data: { id: lockId, tokenHash: lockHash, expiresAt: new Date(Date.now() + 60_000) } }); }
  catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") fail(409, "REVEAL_IN_PROGRESS", "Reveal is already in progress; retry shortly"); throw error; }
  try {
    const claim = await prisma.$transaction(async (tx) => {
      const current = await tx.meeting.findUniqueOrThrow({ where: { id: m.id } });
      if (current.surpriseState === "REVEALED") return { revealed: true, previousState: current.surpriseState };
      if (current.surpriseState === "ENDED") fail(409, "MEETING_ENDED", "An ended meeting cannot be revealed");
      const previousState = current.surpriseState === "REVEALING" ? ((await tx.meetingEvent.findFirst({ where: { meetingId: m.id, eventType: "REVEAL_CLAIMED" }, orderBy: { createdAt: "desc" } }))?.metadata as { previousState?: string } | null)?.previousState ?? "READY" : current.surpriseState;
      if (current.surpriseState !== "REVEALING") {
        const changed = await tx.meeting.updateMany({ where: { id: m.id, version: current.version, surpriseState: current.surpriseState }, data: { surpriseState: "REVEALING", version: { increment: 1 } } });
        if (!changed.count) fail(409, "REVEAL_IN_PROGRESS", "Reveal is already in progress; retry shortly");
        await tx.meetingEvent.create({ data: { meetingId: m.id, actorId: req.principal!.userId, eventType: "REVEAL_CLAIMED", metadata: { previousState } } });
      }
      return { revealed: false, previousState };
    });
    if (claim.revealed) return res.json({ meetingId: m.id, state: "REVEALED" });
    // Reveal the organizer controlled media/message state without exposing attendees
    // through LiveKit presence or participant APIs. Roster access remains organizer-only.
    const revealed = await prisma.$transaction(async (tx) => tx.meeting.update({ where: { id: m.id }, data: { surpriseState: "REVEALED", revealedAt: new Date(), version: { increment: 1 }, events: { create: { actorId: req.principal!.userId, eventType: "REVEALED" } } } }));
    const payload = { meetingId: m.id, state: "REVEALED" }; publish(m.id, "meeting:revealed", payload);  res.json(payload);
  } finally { await prisma.session.deleteMany({ where: { id: lockId } }); }
});
router.post("/meetings/:id/organizer/end", controlLimit, async (req, res) => { const m = await getMeeting(req); await assertOrganizer(req, m.id); const provider = livekitProvider(); try { await provider.deleteRoom(m.livekitRoomName); } catch (error) { console.error(JSON.stringify({ level: "error", event: "livekit_room_close_failed", meetingId: m.id, message: String(error) })); fail(503, "LIVEKIT_ROOM_CLOSE_FAILED", "LiveKit could not close the meeting room"); } const result = await prisma.$transaction(async (tx) => { const current = await tx.meeting.findUniqueOrThrow({ where: { id: m.id } }); if (current.status === "ENDED") return { meeting: current, changed: false }; const meeting = await tx.meeting.update({ where: { id: m.id }, data: { status: "ENDED", surpriseState: "ENDED", endedAt: new Date(), events: { create: { actorId: req.principal!.userId, eventType: "MEETING_ENDED" } } } }); return { meeting, changed: true }; }); const payload = { meetingId: m.id, status: result.meeting.status, endedAt: result.meeting.endedAt }; if (result.changed) publish(m.id, "meeting:ended", payload); res.json(payload); });
router.post("/meetings/:id/invitations", controlLimit, async (req, res) => { const m = await getMeeting(req); await assertOrganizer(req, m.id); const input = parse(z.object({ role: z.enum(["GUEST", "BIRTHDAY_GUEST"]).default("GUEST"), visibilityOnJoin: z.enum(["VISIBLE", "HIDDEN"]).optional(), invitedEmail: emailSchema.optional(), expiresAt: z.coerce.date().optional() }), req.body); const token = randomBytes(32).toString("base64url"); const invitation = await prisma.meetingInvitation.create({ data: { meetingId: m.id, tokenHash: hashToken(token), invitedEmail: input.invitedEmail, role: input.role, visibilityOnJoin: input.visibilityOnJoin ?? (m.secretBirthdayMode ? "HIDDEN" : "VISIBLE"), createdBy: req.principal!.userId!, expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 86400_000) }, select: { id: true, expiresAt: true, role: true, visibilityOnJoin: true } }); const inviteUrl = `${origin}/join/${m.roomCode}?token=${encodeURIComponent(token)}`; res.status(201).json({ invitation, token, inviteUrl }); });
const mediaUploadHandler = upload.single("file");
const saveBirthdayMedia = async (req: Request, res: Response) => {
  const m = await getMeeting(req); await assertOrganizer(req, m.id); const file = req.file;
  if (!file) fail(400, "VIDEO_REQUIRED", "Upload a supported video file using multipart field 'file'");
  const signatures: Record<string, boolean> = { "video/mp4": file.buffer.length > 12 && file.buffer.toString("ascii", 4, 8) === "ftyp", "video/quicktime": file.buffer.length > 12 && file.buffer.toString("ascii", 4, 8) === "ftyp", "video/webm": file.buffer.length > 4 && file.buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) };
  if (!signatures[file.mimetype]) fail(415, "UNSUPPORTED_VIDEO", "Video content does not match its declared MIME type");
  const ext = file.mimetype === "video/webm" ? "webm" : file.mimetype === "video/quicktime" ? "mov" : "mp4"; const storageKey = `${randomUUID()}.${ext}`; await mediaStorage.put(storageKey, file.buffer);
  const previousMedia = await prisma.birthdayMedia.findUnique({ where: { meetingId: m.id }, select: { storageKey: true } });
  try {
    const media = await prisma.birthdayMedia.upsert({ where: { meetingId: m.id }, create: { meetingId: m.id, uploadedBy: req.principal!.userId!, storageKey, fileName: path.basename(file.originalname).slice(0, 200), mimeType: file.mimetype, byteSize: BigInt(file.size) }, update: { uploadedBy: req.principal!.userId!, storageKey, fileName: path.basename(file.originalname).slice(0, 200), mimeType: file.mimetype, byteSize: BigInt(file.size) } });
    if (previousMedia && previousMedia.storageKey !== storageKey) await mediaStorage.remove(previousMedia.storageKey);
    res.status(200).json({ media: { id: media.id, fileName: media.fileName, mimeType: media.mimeType, byteSize: media.byteSize.toString(), playbackUrl: `/api/v1/meetings/${m.id}/media` } });
  } catch (e) { await mediaStorage.remove(storageKey); throw e; }
};
router.put("/meetings/:id/organizer/media", controlLimit, mediaUploadHandler, saveBirthdayMedia);
router.post("/meetings/:id/organizer/media", controlLimit, mediaUploadHandler, saveBirthdayMedia);
router.get("/meetings/:id/media", async (req, res) => { const m = await getMeeting(req); const participant = await getParticipant(req, m.id); if (participant.role !== "ORGANIZER" && m.secretBirthdayMode && !["VIDEO_PLAYING", "VIDEO_COMPLETED", "REVEALED"].includes(m.surpriseState)) fail(404, "MEDIA_NOT_FOUND", "Shared media is not available"); const media = await prisma.birthdayMedia.findUnique({ where: { meetingId: m.id } }); if (!media) fail(404, "MEDIA_NOT_FOUND", "No birthday video has been uploaded"); const size = await mediaStorage.size(media.storageKey); const range = req.get("range"); res.type(media.mimeType); res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Disposition", "inline"); res.setHeader("Cache-Control", "private, no-store");
  if (range) { const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match || (!match[1] && !match[2])) { res.setHeader("Content-Range", `bytes */${size}`); return res.status(416).end(); } let start: number; let end: number; if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, size - suffix); end = size - 1; } else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; } if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) { res.setHeader("Content-Range", `bytes */${size}`); return res.status(416).end(); } res.status(206); res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`); res.setHeader("Content-Length", end - start + 1); mediaStorage.open(media.storageKey, start, end).on("error", () => { if (!res.headersSent) res.status(404).end(); }).pipe(res); return; }
  res.setHeader("Content-Length", size); mediaStorage.open(media.storageKey).on("error", () => { if (!res.headersSent) res.status(404).end(); }).pipe(res); });
router.post("/meetings/:id/livekit-token", async (req, res) => { const m = await getMeeting(req); if (m.status === "ENDED" || m.status === "EXPIRED" || m.expiresAt <= new Date()) fail(410, "MEETING_CLOSED", "This meeting is closed"); const p = await getParticipant(req, m.id); const provider = livekitProvider(); const token = await provider.createParticipantToken(m.id, p.id, p.displayName); res.json({ token, url: provider.serverUrl, identity: p.id, roomName: m.livekitRoomName, expiresInSeconds: 900, mediaDefaults: { cameraEnabled: false, microphoneEnabled: false } }); });
router.post("/meetings/:id/livekit/connected", async (req, res) => { const m = await getMeeting(req); const p = await getParticipant(req, m.id); const liveIdentities = await livekitProvider().listParticipantIdentities(m.livekitRoomName); if (!liveIdentities.has(p.id)) fail(409, "LIVEKIT_PARTICIPANT_NOT_CONNECTED", "LiveKit has not confirmed this participant in the room"); await prisma.meeting.updateMany({ where: { id: m.id, status: "SCHEDULED", expiresAt: { gt: new Date() } }, data: { status: "ACTIVE" } }); const updated = await prisma.meetingParticipant.update({ where: { id: p.id }, data: { connectionStatus: "CONNECTED" } }); publishParticipantStatus(m.id, updated); res.json({ participantId: p.id, connectionStatus: updated.connectionStatus }); });
router.get("/meetings/:id/organizer/recording", async (req, res) => {
  const m = await getMeeting(req); await assertOrganizer(req, m.id);
  res.json(await livekitProvider().getRecording(m.id));
});
router.post("/meetings/:id/organizer/recording/start", controlLimit, async (req, res) => {
  const m = await getMeeting(req); await assertOrganizer(req, m.id);
  const recording = await livekitProvider().startRecording(m.livekitRoomName, m.id);
  res.status(201).json({ active: true, ...recording });
});
router.post("/meetings/:id/organizer/recording/stop", controlLimit, async (req, res) => {
  const m = await getMeeting(req); await assertOrganizer(req, m.id);
  res.json({ active: false, ...await livekitProvider().stopRecording(m.id) });
});
router.post("/meetings/:id/chat", chatHttpLimit, async (req, res) => { const m = await getMeeting(req); const p = await getParticipant(req, m.id); const input = parse(chatSchema, req.body); if (p.leftAt) fail(403, "PARTICIPANT_LEFT", "Rejoin this meeting to chat"); const message = await prisma.chatMessage.create({ data: { meetingId: m.id, participantId: p.id, body: input.body }, include: { participant: { select: { id: true, displayName: true, visibility: true } } } }); const dto = { id: message.id, body: message.body, createdAt: message.createdAt, participant: { id: p.id, displayName: p.displayName } }; io.to(`meeting:${m.id}:organizer`).emit("chat:message", eventEnvelope(dto)); res.status(201).json(dto); });

app.use("/api/v1", router);
app.use((req, _res, next) => next(Object.assign(new Error("Route not found"), { status: 404, code: "NOT_FOUND" })));
app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = error as { status?: number; code?: string; message?: string };
  const uploadLimit = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
  const status = uploadLimit ? 413 : e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  const code = uploadLimit ? "VIDEO_TOO_LARGE" : e.code ?? (status === 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
  const message = uploadLimit ? "Video exceeds the 100 MiB upload limit" : status === 500 ? "An unexpected error occurred" : e.message ?? "Request failed";
  console.error(JSON.stringify({ level: "error", event: "request_failed", requestId: req.requestId, code, status, ...(status === 500 ? { detail: e.message } : {}) }));
  res.status(status).json({ error: { code, message, requestId: req.requestId } });
});

type SocketCtx = { meetingId: string; participantId: string; role: string; visibility: string };
const io = new Server(server, { cors: { origin, credentials: true } });
function eventEnvelope<T>(data: T) { return { schemaVersion: 1, eventId: randomUUID(), ...((data && typeof data === "object") ? data as object : { data }) }; }
function publish(meetingId: string, event: string, data: object) { const env = eventEnvelope(data); io.to(`meeting:${meetingId}:participants`).emit(event, env); io.to(`meeting:${meetingId}:organizer`).emit(event, env); }
function participantDto(p: { id: string; displayName: string; role: string; visibility: string; connectionStatus: string; ready: boolean; cameraEnabled: boolean; microphoneEnabled: boolean; screenSharing: boolean }) { return { id: p.id, displayName: p.displayName, role: p.role, visibility: p.visibility, connectionStatus: p.connectionStatus, ready: p.ready, cameraEnabled: p.cameraEnabled, microphoneEnabled: p.microphoneEnabled, screenSharing: p.screenSharing }; }
function publishParticipantJoined(meetingId: string, p: Parameters<typeof participantDto>[0]) { io.to(`meeting:${meetingId}:organizer`).emit("organizer:participant-joined", eventEnvelope(participantDto(p))); }
function publishParticipantLeft(meetingId: string, p: Parameters<typeof participantDto>[0]) { io.to(`meeting:${meetingId}:organizer`).emit("organizer:participant-left", eventEnvelope(participantDto(p))); }
function publishParticipantStatus(meetingId: string, p: Parameters<typeof participantDto>[0]) { io.to(`meeting:${meetingId}:organizer`).emit("organizer:participant-status", eventEnvelope(participantDto(p))); }
function publishReadiness(meetingId: string, p: Parameters<typeof participantDto>[0]) { io.to(`meeting:${meetingId}:organizer`).emit("organizer:readiness", eventEnvelope({ participantId: p.id, ready: p.ready })); }
const socketAck = (ack: unknown, result: object) => { if (typeof ack === "function") (ack as (x: object) => void)(result); };
io.use(async (socket, next) => {
  try { const cookies = Object.fromEntries((socket.handshake.headers.cookie ?? "").split("; ").filter(Boolean).map((part) => { const i = part.indexOf("="); return [part.slice(0, i), decodeURIComponent(part.slice(i + 1))]; }));
    const pt = cookies[participantCookie]; const ut = cookies[userCookie];
    const sessions = await prisma.session.findMany({ where: { tokenHash: { in: [pt, ut].filter((x): x is string => Boolean(x)).map(tokenHash) }, expiresAt: { gt: new Date() } } });
    const participantSession = sessions.find((x) => x.participantId); const userSession = sessions.find((x) => x.userId);
    let participant = participantSession?.participantId ? await prisma.meetingParticipant.findFirst({ where: { id: participantSession.participantId, leftAt: null }, include: { meeting: true } }) : null;
    if (!participant && userSession?.userId) participant = await prisma.meetingParticipant.findFirst({ where: { userId: userSession.userId, leftAt: null }, include: { meeting: true }, orderBy: { joinedAt: "desc" } });
    if (!participant) return next(new Error("Unauthorized"));
    (socket.data as { ctx: SocketCtx }).ctx = { meetingId: participant.meetingId, participantId: participant.id, role: participant.role, visibility: participant.visibility }; next();
  } catch { next(new Error("Unauthorized")); }
});
const payloadSchema = z.object({ meetingId: z.string().uuid().optional() }).passthrough();
function socketPayload(raw: unknown, meetingId: string) { const payload = parse(payloadSchema, raw); if (payload.meetingId && payload.meetingId !== meetingId) fail(403, "MEETING_MISMATCH", "Socket is not joined to that meeting"); return payload; }
io.on("connection", (socket: Socket) => {
  const ctx = (socket.data as { ctx: SocketCtx }).ctx;
  const chatTimes: number[] = [];
  socket.join(`meeting:${ctx.meetingId}:${ctx.role === "ORGANIZER" ? "organizer" : "participants"}`);
  socket.join(`participant:${ctx.participantId}`);
  void prisma.meeting.findUnique({ where: { id: ctx.meetingId } }).then(async (meeting) => { if (!meeting || !process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) return; const listed = await livekitProvider().listParticipantIdentities(meeting.livekitRoomName); if (!listed.has(ctx.participantId)) return; const updated = await prisma.meetingParticipant.update({ where: { id: ctx.participantId }, data: { connectionStatus: "CONNECTED" } }); publishParticipantStatus(ctx.meetingId, updated); }).catch((error) => console.error(JSON.stringify({ level: "error", event: "socket_status_refresh_failed", meetingId: ctx.meetingId, message: String(error) })));
  socket.emit("connection:ready", { schemaVersion: 1, meetingId: ctx.meetingId });
  socket.on("chat:send", async (raw: unknown, ack?: unknown) => { try { const now = Date.now(); while (chatTimes.length && now - chatTimes[0] > 10_000) chatTimes.shift(); if (chatTimes.length >= 5) fail(429, "RATE_LIMITED", "Please wait before sending another message"); socketPayload(raw, ctx.meetingId); const input = parse(chatSchema, raw); const current = await prisma.meetingParticipant.findFirst({ where: { id: ctx.participantId, meetingId: ctx.meetingId, leftAt: null } }); if (!current) fail(403, "PARTICIPANT_LEFT", "Rejoin this meeting to chat"); const msg = await prisma.chatMessage.create({ data: { meetingId: ctx.meetingId, participantId: current.id, body: input.body }, include: { participant: { select: { id: true, displayName: true } } } }); chatTimes.push(now); const dto = { id: msg.id, body: msg.body, createdAt: msg.createdAt, participant: msg.participant }; io.to(`meeting:${ctx.meetingId}:organizer`).emit("chat:message", eventEnvelope(dto)); if (current.role !== "ORGANIZER") io.to(`participant:${current.id}`).emit("chat:message", eventEnvelope(dto)); socketAck(ack, { ok: true, message: dto }); } catch (e) { socketAck(ack, { ok: false, error: { code: (e as { code?: string }).code ?? "INVALID_MESSAGE", message: (e as { message?: string }).message ?? "Message could not be sent" } }); } });
  socket.on("meeting:leave", async (raw: unknown, ack?: unknown) => { try { socketPayload(raw, ctx.meetingId); const p = await prisma.meetingParticipant.findUnique({ where: { id: ctx.participantId } }); const meeting = await prisma.meeting.findUnique({ where: { id: ctx.meetingId } }); if (p && meeting && process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) { try { await livekitProvider().removeParticipant(meeting.livekitRoomName, p.id); } catch (error) { console.error(JSON.stringify({ level: "warn", event: "livekit_leave_remove_failed", meetingId: ctx.meetingId, participantId: p.id, message: String(error) })); } } await prisma.meetingParticipant.updateMany({ where: { id: ctx.participantId, leftAt: null }, data: { leftAt: new Date(), connectionStatus: "DISCONNECTED" } }); const updated = p ? await prisma.meetingParticipant.findUnique({ where: { id: p.id } }) : null; if (updated) publishParticipantLeft(ctx.meetingId, updated); socketAck(ack, { ok: true }); socket.disconnect(true); } catch (e) { socketAck(ack, { ok: false, error: { code: (e as { code?: string }).code ?? "VALIDATION_ERROR", message: "Leave request was rejected" } }); } });
  socket.on("participant:ready", async (raw: unknown, ack?: unknown) => { try { socketPayload(raw, ctx.meetingId); const input = parse(z.object({ ready: z.boolean() }).passthrough(), raw); const current = await prisma.meetingParticipant.findFirst({ where: { id: ctx.participantId, meetingId: ctx.meetingId, leftAt: null } }); if (!current) fail(403, "PARTICIPANT_LEFT", "Rejoin this meeting to update readiness"); const updated = await prisma.meetingParticipant.update({ where: { id: current.id }, data: { ready: input.ready } }); publishParticipantStatus(ctx.meetingId, updated); publishReadiness(ctx.meetingId, updated); socketAck(ack, { ok: true, ready: updated.ready }); } catch (e) { socketAck(ack, { ok: false, error: { code: (e as { code?: string }).code ?? "VALIDATION_ERROR", message: "Readiness could not be updated" } }); } });
  for (const [event, field] of [["participant:camera-toggle", "cameraEnabled"], ["participant:microphone-toggle", "microphoneEnabled"], ["participant:screen-share-start", "screenSharing"], ["participant:screen-share-stop", "screenSharing"]] as const) socket.on(event, async (raw: unknown, ack?: unknown) => { try { socketPayload(raw, ctx.meetingId); const enabled = event === "participant:screen-share-start" ? true : event === "participant:screen-share-stop" ? false : parse(z.object({ enabled: z.boolean() }).passthrough(), raw).enabled; const current = await prisma.meetingParticipant.findFirst({ where: { id: ctx.participantId, meetingId: ctx.meetingId, leftAt: null } }); if (!current) fail(403, "PARTICIPANT_LEFT", "Rejoin this meeting to update device status"); const updated = await prisma.meetingParticipant.update({ where: { id: current.id }, data: { [field]: enabled } }); publishParticipantStatus(ctx.meetingId, updated); socketAck(ack, { ok: true }); } catch (e) { socketAck(ack, { ok: false, error: { code: (e as { code?: string }).code ?? "VALIDATION_ERROR", message: "Participant status could not be updated" } }); } });
  socket.on("organizer:video-start", async (_raw: unknown, ack?: unknown) => { if (ctx.role !== "ORGANIZER") return socketAck(ack, { ok: false, error: { code: "ORGANIZER_REQUIRED", message: "Organizer access required" } }); socketAck(ack, { ok: false, error: { code: "USE_HTTP_CONTROL", message: "Use the organizer video start endpoint" } }); });
  socket.on("disconnect", async () => { const row = await prisma.meeting.findUnique({ where: { id: ctx.meetingId } }); if (!row) return; let stillInProvider = false; if (process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET) { try { stillInProvider = (await livekitProvider().listParticipantIdentities(row.livekitRoomName)).has(ctx.participantId); } catch { /* provider status remains unknown; preserve persisted state */ return; } } if (!stillInProvider) { const result = await prisma.meetingParticipant.updateMany({ where: { id: ctx.participantId, leftAt: null }, data: { connectionStatus: "DISCONNECTED" } }); if (result.count) { const updated = await prisma.meetingParticipant.findUnique({ where: { id: ctx.participantId } }); if (updated) publishParticipantStatus(ctx.meetingId, updated); } } });
});

const port = Number(process.env.PORT ?? 3001);
server.listen(port, () => console.info(JSON.stringify({ level: "info", event: "api_started", port })));
const shutdown = async () => { io.close(); server.close(); await prisma.$disconnect(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
