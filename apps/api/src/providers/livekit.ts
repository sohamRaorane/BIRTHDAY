import { AccessToken, EncodedFileOutput, EncodedFileType, EgressClient, EgressStatus, RoomServiceClient } from "livekit-server-sdk";
import { TrackSource } from "@livekit/protocol";
import { prisma } from "../db.js";

interface LiveKitAdapter {
  serverUrl: string;
  listParticipantIdentities(room: string): Promise<Set<string>>;
  removeParticipant(room: string, identity: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
  createParticipantToken(meetingId: string, participantId: string, displayName: string): Promise<string>;
  startRecording(room: string, meetingId: string): Promise<{ egressId: string; filePath: string }>;
  stopRecording(meetingId: string): Promise<{ egressId: string; filePath?: string }>;
  getRecording(meetingId: string): Promise<{ active: boolean; egressId?: string; filePath?: string }>;
}

class LiveKitServerAdapter implements LiveKitAdapter {
  readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rooms: RoomServiceClient;
  private readonly egress: EgressClient;
  private readonly recordings = new Map<string, { egressId: string; filePath: string }>();

  constructor() {
    const url = process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!url || !key || !secret) throw Object.assign(new Error("LiveKit is not configured for this service"), { status: 503, code: "LIVEKIT_NOT_CONFIGURED" });
    this.serverUrl = url;
    this.apiKey = key;
    this.apiSecret = secret;
    this.rooms = new RoomServiceClient(url, key, secret);
    const apiUrl = url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
    this.egress = new EgressClient(apiUrl, key, secret);
  }

  async listParticipantIdentities(room: string) {
    return new Set((await this.rooms.listParticipants(room)).map((participant) => participant.identity));
  }

  async removeParticipant(room: string, identity: string) {
    await this.rooms.removeParticipant(room, identity);
  }

  async deleteRoom(room: string) {
    await this.rooms.deleteRoom(room);
  }

  async createParticipantToken(meetingId: string, participantId: string, displayName: string) {
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
    const participant = await prisma.meetingParticipant.findUniqueOrThrow({ where: { id: participantId } });
    const token = new AccessToken(this.apiKey, this.apiSecret, { identity: participantId, name: displayName, ttl: "15m" });
    // All meeting members are hidden from one another by LiveKit itself. The
    // organizer's complete roster is served from the authorized API instead.
    token.addGrant({
      roomJoin: true,
      room: meeting.livekitRoomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // LiveKit visibility is application-controlled here: hidden participant
      // grants can suppress track discovery. Keep participants visible to media
      // subscriptions and mask names in the client for non-organizer views.
      hidden: false,
      canPublishSources: participant.role === "ORGANIZER"
        ? [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE]
        : [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE],
    });
    return token.toJwt();
  }

  async startRecording(room: string, meetingId: string) {
    const existing = this.recordings.get(meetingId);
    if (existing) return existing;
    const filePath = `/recordings/${meetingId}-${Date.now()}.mp4`;
    const output = new EncodedFileOutput({ filepath: filePath, fileType: EncodedFileType.MP4 });
    const info = await this.egress.startRoomCompositeEgress(room, output, { layout: "grid" });
    const recording = { egressId: info.egressId, filePath };
    this.recordings.set(meetingId, recording);
    return recording;
  }

  async stopRecording(meetingId: string) {
    const existing = this.recordings.get(meetingId);
    if (!existing) return { egressId: "" };
    await this.egress.stopEgress(existing.egressId);
    this.recordings.delete(meetingId);
    return existing;
  }

  async getRecording(meetingId: string) {
    const existing = this.recordings.get(meetingId);
    if (!existing) return { active: false };
    const items = await this.egress.listEgress({ roomName: undefined, egressId: existing.egressId });
    const active = items.some((item) => item.egressId === existing.egressId && [EgressStatus.EGRESS_STARTING, EgressStatus.EGRESS_ACTIVE].includes(item.status));
    if (!active) this.recordings.delete(meetingId);
    return active ? { active: true, ...existing } : { active: false };
  }
}

export const livekitProvider = (): LiveKitAdapter => new LiveKitServerAdapter();
