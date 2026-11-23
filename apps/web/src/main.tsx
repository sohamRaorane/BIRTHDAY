import { StrictMode, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import { createLocalScreenTracks, Room, RoomEvent, Track, type Participant, type RemoteTrackPublication, type TrackPublication } from "livekit-client";
import type { MeetingSnapshot, VisibleParticipant } from "@surprise/contracts";
import "./style.css";

type Screen = "home" | "auth" | "dashboard" | "room";
type Message = { id: string; displayName: string; text: string; createdAt?: string };
type JoinResult = { snapshot: MeetingWire; participantId?: string; url?: string; token?: string; liveKitToken?: string; liveKitUrl?: string };
type MeetingWire = MeetingSnapshot & { state?: string; mediaStartedAt?: string | null; revealMessage?: string | null; birthdayMediaUrl?: string; birthdayVideoUrl?: string; media?: { playbackUrl?: string; fileName?: string }; inviteUrl?: string; inviteCode?: string };
type MeetingEnvelope = { snapshot?: MeetingWire; meeting?: Partial<MeetingWire>; participants?: VisibleParticipant[]; participantId?: string; isOrganizer?: boolean; roomCode?: string; displayName?: string; messages?: Array<{ id: string; displayName?: string; name?: string; body: string; createdAt?: string; participant?: { displayName?: string } }> };
type OrganizerPerson = VisibleParticipant & { ready: boolean };
const API = "/api/v1";
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
function normalizeMeeting(data: MeetingEnvelope): { snapshot: MeetingWire; messages: Message[]; participantId?: string } {
  const meeting = data.snapshot || data.meeting;
  if (!meeting?.id) throw new Error("The meeting response did not include meeting metadata.");
  return {
    snapshot: { ...meeting, surpriseState: meeting.surpriseState || (meeting.state === "MEDIA_PLAYING" ? "VIDEO_PLAYING" : meeting.state === "REVEALED" || meeting.state === "ENDED" ? meeting.state : "WAITING_FOR_PARTICIPANTS"), birthdayMessage: meeting.birthdayMessage || meeting.revealMessage, birthdayVideoStartedAt: meeting.birthdayVideoStartedAt || meeting.mediaStartedAt, birthdayMediaUrl: meeting.birthdayMediaUrl || meeting.birthdayVideoUrl || meeting.media?.playbackUrl, participants: data.participants || meeting.participants || [] } as MeetingWire,
    messages: (data.messages || []).map(m => ({ id: m.id, displayName: m.displayName || m.name || m.participant?.displayName || "Participant", text: m.body, createdAt: m.createdAt })), participantId: data.participantId
  };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { credentials: "include", ...init, headers: { ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Request failed (${response.status})`);
  return data as T;
}

function routeInfo() {
  const path = location.pathname.match(/^\/join\/([^/]+)/);
  const params = new URLSearchParams(location.search);
  return { code: path?.[1] ? decodeURIComponent(path[1]) : params.get("code") || "", token: params.get("token") || params.get("invite") || "" };
}

function App() {
  const route = routeInfo();
  const [screen, setScreen] = useState<Screen>(route.code || route.token ? "room" : "home");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<MeetingWire | null>(null); const [organizer, setOrganizer] = useState(false); const [organizerOpen, setOrganizerOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]); const [message, setMessage] = useState(""); const [, setMediaRevision] = useState(0);
  const [code, setCode] = useState(route.code); const [meetingTitle, setMeetingTitle] = useState(""); const [modal, setModal] = useState<"create" | "join" | null>(null);
  const [toast, setToast] = useState(""); const [socketState, setSocketState] = useState<"idle" | "connected" | "disconnected">("idle");
  const [lkState, setLkState] = useState<"idle" | "connecting" | "connected" | "unavailable">("idle"); const [roomEpoch, setRoomEpoch] = useState(0);
  const [activeTab, setActiveTab] = useState<"chat" | "people">("chat"); const [inviteBusy, setInviteBusy] = useState(false);
  const [organizerRoster, setOrganizerRoster] = useState<OrganizerPerson[]>([]); const [rosterLoading, setRosterLoading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null); const [uploadStatus, setUploadStatus] = useState(""); const [birthdayInviteUrl, setBirthdayInviteUrl] = useState(""); const [hiddenInviteUrl, setHiddenInviteUrl] = useState("");
  const [recordingState, setRecordingState] = useState<{ active: boolean; egressId?: string; filePath?: string }>({ active: false });
  const roomRef = useRef<Room | null>(null); const socketRef = useRef<Socket | null>(null); const stageRef = useRef<HTMLDivElement>(null); const peopleStripRef = useRef<HTMLDivElement>(null); const videoRef = useRef<HTMLVideoElement>(null);
  const inviteStartedRef = useRef(false); const recoveryStartedRef = useRef(false);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
  const notify = (s: string) => setToast(s);
  useEffect(() => { api<{ user?: { name?: string; email?: string } }>("/auth/me").then(x => { if (x.user) { setName(x.user.name || ""); setEmail(x.user.email || ""); } }).catch(() => {}); }, []);
  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(""), 2600); return () => clearTimeout(t); }, [toast]);

  const loadSnapshot = useCallback(async (meetingId: string) => {
    setLoading(true); setError("");
    try { const result = normalizeMeeting(await api<MeetingEnvelope>(`/meetings/${encodeURIComponent(meetingId)}/snapshot`)); setSnapshot(result.snapshot); setMessages(result.messages); }
    catch (e) { fail(e); }
    finally { setLoading(false); }
  }, []);

  const onJoined = (result: JoinResult, isOrganizer = false) => {
    setSnapshot(result.snapshot); setOrganizer(isOrganizer); setScreen("room"); setError(""); setRoomEpoch(x => x + 1);
    const url = result.url || result.liveKitUrl; const token = result.token || result.liveKitToken;
    if (url && token) sessionStorage.setItem(`livekit:${result.snapshot.id}`, JSON.stringify({ url, token }));
  };

  const resumeCurrentMeeting = async (current: MeetingEnvelope, expectedCode?: string) => {
    if (!current.snapshot?.id || (expectedCode && current.roomCode !== expectedCode)) return false;
    const result = normalizeMeeting(current);
    const creds = await api<{ url: string; token: string }>(`/meetings/${encodeURIComponent(result.snapshot.id)}/livekit-token`, { method: "POST", body: JSON.stringify({}) });
    if (current.displayName) setName(current.displayName);
    setMessages(result.messages);
    onJoined({ snapshot: result.snapshot, participantId: result.participantId, ...creds }, current.isOrganizer === true);
    return true;
  };

  useEffect(() => { if (route.code || route.token || recoveryStartedRef.current) return; recoveryStartedRef.current = true; void api<MeetingEnvelope>("/meetings/current").then(current => resumeCurrentMeeting(current)).catch(() => {}); }, []);

  useEffect(() => {
    if ((!route.code && !route.token) || inviteStartedRef.current) return;
    inviteStartedRef.current = true;
    setScreen("room"); setLoading(true); setError("");
    const invite = async () => {
      try {
        const target = route.code || route.token;
        const joined = await api<MeetingEnvelope>(`/meetings/${encodeURIComponent(target)}/join`, { method: "POST", body: JSON.stringify({ inviteToken: route.token || undefined }) });
        const normalized = normalizeMeeting(joined);
        const creds = await api<{ url: string; token: string }>(`/meetings/${encodeURIComponent(normalized.snapshot.id)}/livekit-token`, { method: "POST", body: JSON.stringify({}) });
        setMessages(normalized.messages);
        onJoined({ snapshot: normalized.snapshot, participantId: normalized.participantId, ...creds }, joined.isOrganizer === true);
        return;
      } catch (e) {
        const message = e instanceof Error ? e.message : "";
        if (message.includes("displayName is required") || message.includes("different meeting role")) {
          if (message.includes("different meeting role")) setError(message);
          setCode(route.code);
          setModal("join");
        } else fail(e);
      }
      finally { setLoading(false); }
    };
    void invite();
    // Link credentials are exchanged once on initial invite route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snapshotId = snapshot?.id;
  useEffect(() => {
    if (!snapshotId || screen !== "room") return;
    const socket: Socket = io({ path: "/socket.io", withCredentials: true, autoConnect: true }); socketRef.current = socket;
    socket.on("connect", () => setSocketState("connected")); socket.on("connection:ready", () => void loadSnapshot(snapshotId)); socket.on("disconnect", () => setSocketState("disconnected"));
    socket.on("meeting:joined", () => void loadSnapshot(snapshotId));
    socket.on("meeting:ended", () => void loadSnapshot(snapshotId));
    socket.on("media:started", () => void loadSnapshot(snapshotId));
    socket.on("media:completed", () => void loadSnapshot(snapshotId));
    socket.on("meeting:revealed", () => { void loadSnapshot(snapshotId); });
    socket.on("chat:message", (m: { id: string; displayName?: string; name?: string; body: string; createdAt?: string }) => setMessages(prev => [...prev, { id: m.id, displayName: m.displayName || m.name || "Participant", text: m.body, createdAt: m.createdAt }]));
    const updateOrganizerRoster = (person: OrganizerPerson) => setOrganizerRoster(previous => {
      const index = previous.findIndex(existing => existing.id === person.id);
      if (index < 0) return [...previous, person];
      return previous.map(existing => existing.id === person.id ? person : existing);
    });
    socket.on("organizer:participant-joined", updateOrganizerRoster);
    socket.on("organizer:participant-left", updateOrganizerRoster);
    socket.on("organizer:participant-status", updateOrganizerRoster);
    socket.on("organizer:readiness", (event: { participantId: string; ready: boolean }) => setOrganizerRoster(previous => previous.map(person => person.id === event.participantId ? { ...person, ready: event.ready } : person)));
    socket.on("meeting:error", (x: { message?: string }) => setError(x.message || "The meeting service reported an error."));
    return () => { socket.disconnect(); socketRef.current = null; setSocketState("idle"); };
  }, [snapshotId, screen, loadSnapshot]);

  useEffect(() => {
    if (!snapshot || screen !== "room") return;
    const raw = sessionStorage.getItem(`livekit:${snapshot.id}`);
    if (!raw) { setLkState("unavailable"); return; }
    let credentials: { url: string; token: string };
    try { credentials = JSON.parse(raw); } catch { setLkState("unavailable"); return; }
    if (!credentials.url || !credentials.token) { setLkState("unavailable"); return; }
    const room = new Room({ adaptiveStream: true, dynacast: true }); roomRef.current = room; setLkState("connecting");
    const attach = (publication: TrackPublication, participant: Participant) => {
      const track = publication.track; if (!track) return;
      const el = track.attach(); el.dataset.participant = participant.identity;
      if (track.kind === Track.Kind.Video) {
        el.classList.add(publication.source === Track.Source.ScreenShare ? "screen-video" : "participant-video");
        const target = publication.source === Track.Source.ScreenShare ? stageRef.current : peopleStripRef.current;
        if (target) {
          el.dataset.trackSid = publication.trackSid;
          if (publication.source === Track.Source.ScreenShare) {
            target.classList.add("screen-sharing");
            el.dataset.screenShare = "true";
            const existing = target.querySelector('[data-screen-share="true"]');
            if (existing) existing.replaceWith(el);
            else { el.dataset.screenShare = "true"; target.appendChild(el); }
          } else {
            const tile = target.querySelector(`[data-camera-participant="${participant.identity}"]`) as HTMLDivElement | null
              ?? (() => {
                const created = document.createElement("div");
                created.className = "camera-tile";
                created.dataset.cameraParticipant = participant.identity;
                const label = document.createElement("span");
                label.className = "camera-name";
                label.textContent = organizer ? (participant.name || "Participant") : "Participant";
                created.appendChild(label);
                target.appendChild(created);
                return created;
              })();
            tile.querySelectorAll("video").forEach(video => video.remove());
            el.classList.add("camera-video");
            tile.appendChild(el);
            const empty = target.querySelector(".empty-state");
            empty?.remove();
          }
        }
      } else {
        el.classList.add("remote-audio");
        stageRef.current?.appendChild(el);
      }
    };
    const detach = (publication: TrackPublication) => {
      publication.track?.detach().forEach(el => el.remove());
      if (publication.source !== Track.Source.ScreenShare && peopleStripRef.current) {
        peopleStripRef.current.querySelectorAll<HTMLElement>("[data-camera-participant]").forEach(tile => {
          if (!tile.querySelector("video")) tile.remove();
        });
        if (!peopleStripRef.current.querySelector(".camera-tile")) {
          peopleStripRef.current.querySelector(".empty-state")?.remove();
          const empty = document.createElement("div");
          empty.className = "empty-state";
          empty.textContent = "Cameras will appear here.";
          peopleStripRef.current.appendChild(empty);
        }
      }
      if (publication.source === Track.Source.ScreenShare) {
        const stage = stageRef.current;
        stage?.querySelector('[data-screen-share="true"]')?.remove();
        stage?.classList.remove("screen-sharing");
      }
    };
    room.on(RoomEvent.TrackSubscribed, (_track, publication, participant) => attach(publication, participant));
    room.on(RoomEvent.TrackUnsubscribed, (_track, publication) => detach(publication));
    room.on(RoomEvent.TrackPublished, (publication, participant) => {
      const remotePublication = publication as RemoteTrackPublication;
      remotePublication.setSubscribed(true);
      if (remotePublication.track) attach(remotePublication, participant);
    });
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      participant.videoTrackPublications.forEach(publication => {
        publication.setSubscribed(true);
        if (publication.track) attach(publication, participant);
      });
    });
    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.track) attach(publication, room.localParticipant);
      const isCamera = publication.source === Track.Source.Camera;
      const isMic = publication.source === Track.Source.Microphone;
      if (isCamera || isMic) socketRef.current?.emit(isCamera ? "participant:camera-toggle" : "participant:microphone-toggle", { meetingId: snapshot.id, requestId: newId(), enabled: true });
      if (publication.source === Track.Source.ScreenShare) socketRef.current?.emit("participant:screen-share-start", { meetingId: snapshot.id, requestId: newId() });
      setMediaRevision(x => x + 1);
    });
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      detach(publication);
      const isCamera = publication.source === Track.Source.Camera;
      const isMic = publication.source === Track.Source.Microphone;
      if (isCamera || isMic) socketRef.current?.emit(isCamera ? "participant:camera-toggle" : "participant:microphone-toggle", { meetingId: snapshot.id, requestId: newId(), enabled: false });
      if (publication.source === Track.Source.ScreenShare) socketRef.current?.emit("participant:screen-share-stop", { meetingId: snapshot.id, requestId: newId() });
      setMediaRevision(x => x + 1);
    });
    room.on(RoomEvent.Disconnected, () => setLkState("unavailable"));
    room.connect(credentials.url, credentials.token).then(async () => {
      setLkState("connected");
      room.remoteParticipants.forEach(participant => {
        participant.videoTrackPublications.forEach(publication => {
          publication.setSubscribed(true);
          if (publication.track) attach(publication, participant);
        });
      });
      try { await api(`/meetings/${encodeURIComponent(snapshot.id)}/livekit/connected`, { method: "POST", body: JSON.stringify({}) }); }
      catch (e) { fail(e); }
    }).catch(e => { setLkState("unavailable"); setError(e instanceof Error ? `Media connection unavailable: ${e.message}` : "Media connection unavailable."); });
    return () => { void room.disconnect(); roomRef.current = null; setLkState("idle"); };
  }, [snapshot?.id, screen, roomEpoch]);

  useEffect(() => {
    if (!snapshot || !organizer || !organizerOpen) return;
    setRosterLoading(true);
    api<{ participants: OrganizerPerson[] }>(`/meetings/${encodeURIComponent(snapshot.id)}/organizer/participants`)
      .then(result => setOrganizerRoster(result.participants || []))
      .catch(e => fail(e))
      .finally(() => setRosterLoading(false));
  }, [snapshot?.id, organizer, organizerOpen]);

  useEffect(() => {
    if (!snapshot || !organizer || !organizerOpen) return;
    api<{ active: boolean; egressId?: string; filePath?: string }>(`/meetings/${encodeURIComponent(snapshot.id)}/organizer/recording`)
      .then(setRecordingState)
      .catch(e => fail(e));
  }, [snapshot?.id, organizer, organizerOpen]);

  useEffect(() => {
    const video = videoRef.current; const url = snapshot?.birthdayMediaUrl || snapshot?.birthdayVideoUrl;
    if (!video || !url || snapshot?.surpriseState !== "VIDEO_PLAYING") return;
    const syncAndPlay = () => {
      const startedAt = snapshot.birthdayVideoStartedAt ? Date.parse(snapshot.birthdayVideoStartedAt) : NaN;
      if (Number.isFinite(startedAt)) {
        const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
        video.currentTime = Number.isFinite(video.duration) ? Math.min(elapsedSeconds, Math.max(0, video.duration - 0.05)) : elapsedSeconds;
      }
      video.play().catch(() => setError("Shared media is ready, but playback could not start. Use the video controls to try again."));
    };
    video.addEventListener("loadedmetadata", syncAndPlay, { once: true });
    video.src = url; video.load();
    return () => video.removeEventListener("loadedmetadata", syncAndPlay);
  }, [snapshot?.birthdayMediaUrl, snapshot?.birthdayVideoUrl, snapshot?.birthdayVideoStartedAt, snapshot?.surpriseState]);

  const submitAuth = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(""); try { await api(authMode === "login" ? "/auth/login" : "/auth/register", { method: "POST", body: JSON.stringify({ email, password, ...(authMode === "register" ? { name } : {}) }) }); setScreen("dashboard"); } catch (e) { fail(e); } finally { setBusy(false); } };
  const createMeeting = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(""); try { const response = await api<{ meeting: MeetingWire; birthdayUrl?: string; joinUrl?: string }>("/meetings", { method: "POST", body: JSON.stringify({ title: meetingTitle, secretBirthdayMode: true }) }); const result = normalizeMeeting(response); setBirthdayInviteUrl(response.birthdayUrl || response.joinUrl || ""); const creds = await api<{ url: string; token: string }>(`/meetings/${encodeURIComponent(result.snapshot.id)}/livekit-token`, { method: "POST", body: JSON.stringify({}) }); onJoined({ snapshot: result.snapshot, ...creds }, true); setModal(null); } catch (e) { fail(e); } finally { setBusy(false); } };
  const joinMeeting = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(""); try { const params = new URLSearchParams(location.search); const token = params.get("token") || params.get("invite") || undefined; const joined = normalizeMeeting(await api<MeetingEnvelope>(`/meetings/${encodeURIComponent(code.trim())}/join`, { method: "POST", body: JSON.stringify({ displayName: name, inviteToken: token }) })); setMessages(joined.messages); const creds = await api<{ url: string; token: string }>(`/meetings/${encodeURIComponent(joined.snapshot.id)}/livekit-token`, { method: "POST", body: JSON.stringify({}) }); onJoined({ snapshot: joined.snapshot, participantId: joined.participantId, ...creds }); setModal(null); } catch (e) { fail(e); } finally { setBusy(false); } };

  const organizerAction = async (action: "video/start" | "video/end" | "reveal" | "end") => {
    if (!snapshot) return; setBusy(true); setError("");
    try { await api(`/meetings/${encodeURIComponent(snapshot.id)}/organizer/${action}`, { method: "POST", body: JSON.stringify(action === "reveal" ? { meetingId: snapshot.id, requestId: newId() } : {}) }); await loadSnapshot(snapshot.id); if (action === "reveal") setOrganizerOpen(false); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const startRecording = async () => {
    if (!snapshot) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ active: boolean; egressId?: string; filePath?: string }>(`/meetings/${encodeURIComponent(snapshot.id)}/organizer/recording/start`, { method: "POST", body: JSON.stringify({}) });
      setRecordingState(result); notify("Whole-room recording started.");
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const stopRecording = async () => {
    if (!snapshot) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ active: boolean; egressId?: string; filePath?: string }>(`/meetings/${encodeURIComponent(snapshot.id)}/organizer/recording/stop`, { method: "POST", body: JSON.stringify({}) });
      setRecordingState(result); notify("Whole-room recording stopped.");
    } catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const uploadMedia = async (file?: File) => {
    if (!snapshot || !file) return;
    setBusy(true); setError(""); setUploadPercent(0); setUploadStatus(`Uploading ${file.name}…`);
    try {
      const form = new FormData(); form.append("file", file);
      const result = await new Promise<{ media: { playbackUrl?: string; fileName?: string } }>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open("PUT", `${API}/meetings/${encodeURIComponent(snapshot.id)}/organizer/media`); xhr.withCredentials = true;
        xhr.upload.onprogress = event => { if (event.lengthComputable) setUploadPercent(Math.round(event.loaded / event.total * 100)); };
        xhr.onerror = () => reject(new Error("Video upload connection failed."));
        xhr.onload = () => { const payload = JSON.parse(xhr.responseText || "{}"); if (xhr.status < 200 || xhr.status >= 300) reject(new Error(payload?.error?.message || `Upload failed (${xhr.status})`)); else resolve(payload); };
        xhr.send(form);
      });
      if (!result.media?.playbackUrl) throw new Error("Upload completed but the service returned no playback URL.");
      setSnapshot(current => current ? { ...current, birthdayMediaUrl: result.media.playbackUrl, media: result.media } : current);
      setUploadPercent(100); setUploadStatus(`Ready to preview: ${result.media.fileName || file.name}`);
    } catch (e) { setUploadStatus("Upload failed."); fail(e); }
    finally { setBusy(false); }
  };
  const mediaToggle = async (kind: "camera" | "microphone") => {
    const room = roomRef.current; if (!room || lkState !== "connected") { setError("Media controls are unavailable until the meeting media connection is ready."); return; }
    try {
      if (kind === "camera") await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
      else await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);
      setMediaRevision(x => x + 1);
    } catch (e) { fail(e); }
  };
  const shareScreen = async () => {
    const room = roomRef.current; if (!room || lkState !== "connected") { setError("Screen sharing is unavailable until the meeting media connection is ready."); return; }
    try { const tracks = await createLocalScreenTracks({ audio: false }); for (const track of tracks) await room.localParticipant.publishTrack(track); setMediaRevision(x => x + 1); }
    catch (e) { fail(e); }
  };
  const stopScreen = async () => { const room = roomRef.current; if (!room) return; for (const publication of room.localParticipant.videoTrackPublications.values()) if (publication.source === Track.Source.ScreenShare && publication.track) { const track = publication.track; await room.localParticipant.unpublishTrack(track); track.stop(); } setMediaRevision(x => x + 1); };
  const leave = async () => { if (snapshot) { try { await api(`/meetings/${encodeURIComponent(snapshot.id)}/leave`, { method: "POST" }); } catch (e) { fail(e); return; } } await roomRef.current?.disconnect(); sessionStorage.removeItem(`livekit:${snapshot?.id}`); setSnapshot(null); setScreen("dashboard"); };
  const copyBirthdayInvite = async () => {
    if (!snapshot || !organizer) return;
    setInviteBusy(true); setError("");
    try {
      let inviteUrl = birthdayInviteUrl;
      if (!inviteUrl) {
        const created = await api<{ inviteUrl?: string }>(`/meetings/${encodeURIComponent(snapshot.id)}/invitations`, { method: "POST", body: JSON.stringify({ role: "BIRTHDAY_GUEST", visibilityOnJoin: "VISIBLE" }) });
        if (!created.inviteUrl) throw new Error("The invitation service returned no URL.");
        inviteUrl = created.inviteUrl; setBirthdayInviteUrl(inviteUrl);
      }
      await navigator.clipboard.writeText(inviteUrl); notify("Participant link copied.");
    } catch (e) { fail(e); }
    finally { setInviteBusy(false); }
  };
  const createInvite = async () => { if (!snapshot) return; setInviteBusy(true); setError(""); try { const result = await api<{ inviteUrl?: string }>(`/meetings/${encodeURIComponent(snapshot.id)}/invitations`, { method: "POST", body: JSON.stringify({ role: "GUEST", visibilityOnJoin: "HIDDEN" }) }); if (!result.inviteUrl) throw new Error("The invitation service returned no URL."); setHiddenInviteUrl(result.inviteUrl); await navigator.clipboard.writeText(result.inviteUrl); notify("Guest invitation copied."); } catch (e) { fail(e); } finally { setInviteBusy(false); } };
  const finishBirthdayVideo = async () => { if (!snapshot) return; try { if (organizer) await api(`/meetings/${encodeURIComponent(snapshot.id)}/organizer/video/end`, { method: "POST", body: JSON.stringify({}) }); else await api(`/meetings/${encodeURIComponent(snapshot.id)}/video/end`, { method: "POST", body: JSON.stringify({}) }); await loadSnapshot(snapshot.id); } catch (e) { fail(e); } };
  const sendChat = (e: FormEvent) => { e.preventDefault(); if (!message.trim() || !snapshot || socketState !== "connected") return; const body = message.trim(); socketRef.current?.emit("chat:send", { meetingId: snapshot.id, requestId: newId(), body }, (result: { ok?: boolean; error?: { message?: string } }) => { if (!result?.ok) setError(result?.error?.message || "Message could not be sent."); }); setMessage(""); };
  const initials = (value: string) => value.split(/\s+/).filter(Boolean).map(x => x[0]).slice(0, 2).join("").toUpperCase();
  const people = organizer ? snapshot?.participants || [] : [];
  const state = snapshot?.surpriseState;
  const palette = (i: number) => ["rose", "gold", "lilac", "mint"][i % 4];
  const renderPeople = (emptyText = "Participant details are unavailable.") => people.length ? people.map((p, i) => <div className="person-row" key={p.id}><span className={`avatar ${palette(i)}`}>{initials(p.displayName)}</span><span className="person-name">{p.displayName}<small>{p.connectionStatus.toLowerCase()}</small></span><span className="person-media">{p.microphoneEnabled ? "Mic on" : "Mic off"} · {p.cameraEnabled ? "Camera on" : "Camera off"}</span></div>) : <div className="empty-state">{emptyText}</div>;

  return <div className="app-shell">
    <header className="topbar"><button className="brand" onClick={() => setScreen("home")}><span className="brand-mark">LM</span><span>little<span className="brand-light">moment</span></span></button><div className="top-actions"><span className="secure"><i/>Private &amp; secure</span>{screen === "dashboard" || screen === "room" ? <button className="profile" onClick={() => setScreen("dashboard")}><span className="avatar rose">{initials(name || "?")}</span>{name || "Account"}</button> : <button className="text-btn" onClick={() => { setAuthMode("login"); setScreen("auth"); }}>Log in</button>}</div></header>
    {screen === "home" && <main className="landing"><section className="hero"><div className="hero-copy"><div className="eyebrow">PRIVATE VIDEO MEETINGS</div><h1>Good conversations<br/>start <em>together.</em></h1><p>Bring your people together in a private room for clear, simple conversations.</p><div className="hero-actions"><button className="primary" onClick={() => { setAuthMode("register"); setScreen("auth"); }}>Create an account <span>→</span></button><button className="secondary" onClick={() => setModal("join")}>Join a meeting</button></div><div className="hero-proof">Private rooms for the people who matter.</div></div><div className="hero-art"><div className="art-card"><div className="meeting-art"><span>LM</span></div><span>Meet face to face</span></div></div></section><section className="how"><div className="eyebrow">SIMPLE BY DESIGN</div><h2>Clear tools. <em>Better conversations.</em></h2><div className="steps"><article><b>01</b><h3>Create a room</h3><p>Set up a private space for your next conversation.</p></article><article><b>02</b><h3>Invite participants</h3><p>Share a meeting link with the people joining you.</p></article><article><b>03</b><h3>Meet together</h3><p>Talk, share your screen, and exchange messages.</p></article></div></section></main>}
    {screen === "auth" && <main className="auth-page"><div className="auth-card"><span className="eyebrow">YOUR COMMUNICATION SPACE</span><h1>{authMode === "login" ? "Welcome back." : "Create your account."}</h1><p>Sign in to manage your meetings and account.</p><form onSubmit={submitAuth}>{authMode === "register" && <label>Your name<input required value={name} onChange={e => setName(e.target.value)}/></label>}<label>Email address<input required type="email" value={email} onChange={e => setEmail(e.target.value)}/></label><label>Password<input required minLength={authMode === "register" ? 12 : 1} type="password" value={password} onChange={e => setPassword(e.target.value)}/>{authMode === "register" && <small>Use at least 12 characters.</small>}</label>{error && <div className="error-box">{error}</div>}<button className="primary full" disabled={busy}>{busy ? "Please wait…" : authMode === "login" ? "Log in" : "Create account"}</button></form><p className="switch-auth">{authMode === "login" ? "New here?" : "Already have an account?"} <button onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}>{authMode === "login" ? "Create an account" : "Log in"}</button></p></div></main>}
    {screen === "dashboard" && <main className="dashboard"><div className="dash-welcome"><div><span className="eyebrow">YOUR WORKSPACE</span><h1>Good to see you{name ? `, ${name.split(" ")[0]}` : ""}.</h1><p>Manage your meetings and invitations.</p></div><button className="primary" onClick={() => { setError(""); setModal("create"); }}>Create a meeting <span>＋</span></button></div><div className="dash-grid"><section className="dash-main"><div className="dash-section-title"><div><h2>Your meetings</h2><p>Your recent rooms will appear here.</p></div><button className="subtle-btn" onClick={() => setModal("join")}>Join with a code →</button></div><div className="empty-panel"><span className="empty-mark">LM</span><h3>No meetings yet</h3><p>Create a meeting room or join one with an invitation.</p><button className="outline-btn" onClick={() => setModal("create")}>Create a meeting</button></div></section><aside className="side-card"><span className="eyebrow">MEETING INVITATION</span><h3>Have a meeting link?</h3><p>Join with the invitation link or room code you received.</p><button className="secondary full" onClick={() => setModal("join")}>Join a meeting →</button></aside></div></main>}
    {screen === "room" && <main className="room-page">{loading && !snapshot ? <div className="loading-panel"><span className="spinner"/>Loading meeting room…</div> : !snapshot ? <div className="loading-panel error-panel"><h2>Room unavailable</h2><p>{error || "Open a valid invitation link or enter a room code to join."}</p><button className="secondary" onClick={() => setModal("join")}>Enter room code</button></div> : <><div className="room-heading"><div><button className="back-link" onClick={() => setScreen("dashboard")}>← Back to your space</button><h1>{snapshot.title}</h1><div className="room-subline"><span className={`status-dot ${socketState === "connected" ? "online" : ""}`}/>{socketState === "connected" ? "Connected to room" : socketState === "disconnected" ? "Reconnecting to room…" : "Connecting to room…"}<span>·</span>Meeting room</div></div><div className="room-head-actions">{organizer && <><button className="outline-btn" onClick={() => void copyBirthdayInvite()}>Copy participant link</button><button className="organizer-pill" onClick={() => setOrganizerOpen(v => !v)}>Organizer controls</button></>}</div></div>{error && <div className="error-box room-error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}<div className="room-layout"><section className="stage"><div className="stage-main" ref={stageRef}>{(state === "VIDEO_PLAYING" || state === "VIDEO_COMPLETED") && (snapshot.birthdayMediaUrl || snapshot.birthdayVideoUrl) ? <div className="birthday-video"><video ref={videoRef} controls playsInline onEnded={() => void finishBirthdayVideo()}/></div> : state === "REVEALED" ? <div className="reveal-state"><div className="reveal-icon">✿</div><span className="eyebrow">MEETING MESSAGE</span><h2>Happy birthday.</h2><p>{snapshot.birthdayMessage || "A birthday message is not available."}</p></div> : state === "VIDEO_PLAYING" || state === "VIDEO_COMPLETED" ? <div className="unavailable-state"><span className="reveal-icon">▶</span><h2>Shared media unavailable</h2><p>The meeting state says the video is active, but no authenticated media URL was provided.</p></div> : snapshot.status === "ENDED" ? <div className="unavailable-state"><h2>This room has ended.</h2></div> : state === "CREATED" || state === "WAITING_FOR_PARTICIPANTS" || state === "READY" ? <div className="waiting-state"><span className="eyebrow">MEETING STATUS</span><h2>Waiting for participants.</h2><p>Meeting updates will appear here.</p></div> : <div className="unavailable-state"><h2>Room state unavailable</h2><p>Refresh the room snapshot to continue.</p><button className="secondary" onClick={() => void loadSnapshot(snapshot.id)}>Refresh state</button></div>}</div><div className="connection-line"><span className={`status-dot ${lkState === "connected" ? "online" : ""}`}/>{lkState === "connected" ? "Live media connected" : lkState === "connecting" ? "Connecting to live media…" : lkState === "unavailable" ? "Live media unavailable" : "Media connection pending"}<span className="connection-hint">Camera and microphone are off until you turn them on.</span></div>        <div className="people-strip" ref={peopleStripRef}>{people.map((p, i) => <div className={`person-tile ${palette(i)}`} key={p.id} data-person-id={p.id}><span>{initials(p.displayName)}</span><small>{p.displayName}</small><i>{p.connectionStatus.toLowerCase()}</i></div>)}{!people.length && <div className="empty-state">Camera views will appear here.</div>}</div><div className="controlbar"><button className="media-control" disabled={lkState !== "connected"} onClick={() => void mediaToggle("microphone")}>{roomRef.current?.localParticipant.isMicrophoneEnabled ? "Turn mic off" : "Turn mic on"}</button>{!organizer && <button className="media-control" disabled={lkState !== "connected"} onClick={() => void mediaToggle("camera")}>{roomRef.current?.localParticipant.isCameraEnabled ? "Turn camera off" : "Turn camera on"}</button>}<button className="media-control" disabled={lkState !== "connected"} onClick={() => void shareScreen()}>Share screen</button><button className="media-control" disabled={lkState !== "connected"} onClick={() => void stopScreen()}>Stop sharing</button><button className="leave-btn" onClick={() => void leave()}>Leave meeting</button></div></section><aside className="room-sidebar"><div className="sidebar-head"><button className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>Chat</button><button className={activeTab === "people" ? "active" : ""} onClick={() => setActiveTab("people")}>People</button></div>{activeTab === "people" ? <div className="people-list">{renderPeople()}</div> : <><div className="chat-context">Room messages appear here while connected.</div><div className="chat-list">{messages.length ? messages.map(m => <div className="message" key={m.id}><b>{m.displayName}</b><p>{m.text}</p><small>{m.createdAt || ""}</small></div>) : <div className="empty-state">No messages yet. Send a message.</div>}</div><form className="chat-compose" onSubmit={sendChat}><input value={message} onChange={e => setMessage(e.target.value)} placeholder="Write a message…" aria-label="Chat message"/><button disabled={!message.trim() || socketState !== "connected"}>Send</button></form></>}<div className="sidebar-footer">Participants and meeting messages are shown here.</div></aside></div></> }</main>}
    {screen === "room" && snapshot && organizer && organizerOpen && <div className="organizer-drawer"><div className="drawer-title"><span className="eyebrow">ORGANIZER CONTROLS</span><button onClick={() => setOrganizerOpen(false)}>Close</button></div><h3>Meeting management</h3><p>Organizer tools and participant readiness.</p><div className="readiness">{rosterLoading ? "Loading readiness" : `${organizerRoster.filter(p => p.ready).length} of ${organizerRoster.length} ready`}</div><div className="drawer-roster">{organizerRoster.length ? organizerRoster.map(p => <div className="person-row" key={p.id}><span className="avatar rose">{initials(p.displayName)}</span><span className="person-name">{p.displayName}<small>{p.connectionStatus.toLowerCase()} ? Mic {p.microphoneEnabled ? "on" : "off"} ? Camera {p.cameraEnabled ? "on" : "off"}{p.screenSharing ? " ? Sharing screen" : ""}</small></span><b>{p.ready ? "Ready" : "Not ready"}</b></div>) : !rosterLoading ? <div className="empty-state">No organizer roster entries yet.</div> : null}</div>{birthdayInviteUrl && <div className="birthday-link"><small>Participant invitation</small><code>{birthdayInviteUrl}</code><button className="outline-btn" onClick={() => void copyBirthdayInvite()}>Copy participant link</button></div>}{hiddenInviteUrl && <div className="birthday-link"><small>Guest invitation</small><code>{hiddenInviteUrl}</code></div>}<button className="outline-btn full" disabled={inviteBusy} onClick={() => void createInvite()}>{inviteBusy ? "Creating invite..." : "Create invitation"}</button><div className="drawer-divider"/><label className="upload-label">Shared media (MP4, WebM, MOV)<input type="file" accept="video/mp4,video/webm,video/quicktime" disabled={busy} onChange={e => { const file = e.currentTarget.files?.[0]; void uploadMedia(file); e.currentTarget.value = ""; }}/></label>{uploadPercent !== null && <div className="upload-state"><div>{uploadStatus} {busy ? `${uploadPercent}%` : ""}</div><progress max="100" value={uploadPercent}/></div>}{snapshot.birthdayMediaUrl && <video className="upload-preview" controls playsInline src={snapshot.birthdayMediaUrl}/>}    <button className="drawer-action" disabled={busy || !snapshot.birthdayMediaUrl} onClick={() => void organizerAction("video/start")}>Start shared media <span>→</span></button><button className="drawer-action" disabled={busy || recordingState.active} onClick={() => void startRecording()}>Start whole-room recording <span>{recordingState.active ? "● Recording" : "→"}</span></button><button className="drawer-action" disabled={busy || !recordingState.active} onClick={() => void stopRecording()}>Stop whole-room recording <span>■</span></button>{recordingState.filePath && <div className="upload-state">Recording output: <code>{recordingState.filePath}</code></div>}<button className="drawer-action" disabled={busy} onClick={() => void organizerAction("reveal")}>Make the big reveal <span>→</span></button><button className="end-action" disabled={busy} onClick={() => void organizerAction("end")}>End this room</button></div>}
    {modal && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="modal"><button className="modal-close" onClick={() => setModal(null)}>Close</button><span className="eyebrow">{modal === "create" ? "MEETING SETUP" : "JOIN A MEETING"}</span><h2>{modal === "create" ? "Create a meeting." : "Join meeting."}</h2><p>{modal === "create" ? "Set up a private meeting room." : "Use the room code from your invitation."}</p>{modal === "create" ? <form onSubmit={createMeeting}><label>Room name<input value={meetingTitle} onChange={e => setMeetingTitle(e.target.value)} required/></label>{error && <div className="error-box">{error}</div>}<button className="primary full" disabled={busy}>{busy ? "Creating…" : "Create room"}</button></form> : <form onSubmit={joinMeeting}><label>Your name<input value={name} onChange={e => setName(e.target.value)} required/></label><label>Room code<input value={code} onChange={e => setCode(e.target.value)} required/></label>{error && <div className="error-box">{error}</div>}<button className="primary full" disabled={busy}>{busy ? "Joining…" : "Join room"}</button></form>}</div></div>}
    {toast && <div className="toast" role="status">{toast}</div>}
    <footer className="site-footer"><span className="brand-mark">LM</span><span>littlemoment</span><span className="footer-copy">A moment worth sharing, made with care.</span><span className="footer-privacy">Private meetings</span></footer>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);

