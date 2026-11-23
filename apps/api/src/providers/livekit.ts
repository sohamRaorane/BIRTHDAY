import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { prisma } from "../db.js";

interface LiveKitAdapter {
  serverUrl: string;
  listParticipantIdentities(room: string): Promise<Set<string>>;
  removeParticipant(room: string, identity: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
  createParticipantToken(meetingId: string, participantId: string, displayName: string): Promise<string>;
}

class LiveKitServerAdapter implements LiveKitAdapter {
  readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly rooms: RoomServiceClient;

  constructor() {
    const url = process.env.LIVEKIT_URL;
    const key = process.env.LIVEKIT_API_KEY;
    const secret = process.env.LIVEKIT_API_SECRET;
    if (!url || !key || !secret) throw Object.assign(new Error("LiveKit is not configured for this service"), { status: 503, code: "LIVEKIT_NOT_CONFIGURED" });
    this.serverUrl = url;
    this.apiKey = key;
    this.apiSecret = secret;
    this.rooms = new RoomServiceClient(url, key, secret);
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
    const token = new AccessToken(this.apiKey, this.apiSecret, { identity: participantId, name: displayName, ttl: "15m" });
    // All meeting members are hidden from one another by LiveKit itself. The
    // organizer's complete roster is served from the authorized API instead.
    token.addGrant({ roomJoin: true, room: meeting.livekitRoomName, canPublish: true, canSubscribe: true, canPublishData: true, hidden: true });
    return token.toJwt();
  }
}

export const livekitProvider = (): LiveKitAdapter => new LiveKitServerAdapter();
