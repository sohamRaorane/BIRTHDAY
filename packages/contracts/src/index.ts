export type MeetingStatus = "SCHEDULED" | "ACTIVE" | "ENDED" | "EXPIRED";
export type SurpriseState =
  | "CREATED"
  | "WAITING_FOR_PARTICIPANTS"
  | "READY"
  | "VIDEO_PLAYING"
  | "VIDEO_COMPLETED"
  | "REVEALED"
  | "ENDED";
export type ParticipantVisibility = "VISIBLE" | "HIDDEN";
export type ParticipantRole = "ORGANIZER" | "BIRTHDAY_GUEST" | "GUEST";

export interface VisibleParticipant {
  id: string;
  displayName: string;
  role: ParticipantRole;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  screenSharing: boolean;
  connectionStatus: "CONNECTING" | "CONNECTED" | "DISCONNECTED";
}

export interface MeetingSnapshot {
  id: string;
  title: string;
  status: MeetingStatus;
  surpriseState: SurpriseState;
  participants: VisibleParticipant[];
  birthdayMessage?: string;
  birthdayVideoStartedAt?: string | null;
}

export interface RevealRequest {
  meetingId: string;
  requestId: string;
}
