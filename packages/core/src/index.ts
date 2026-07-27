export const projectName = "CareTV";

export type MediaService = "fake" | "local" | "prime" | "netflix" | "youtube" | "plex";

export type MediaType =
  "movie" | "episode" | "series" | "video" | "local-file" | "slideshow" | "stream";

export interface MediaItem {
  id: string;
  title: string;
  service: MediaService;
  mediaType: MediaType;
  url?: string;
  localPath?: string;
  expectedDurationSeconds?: number;
  profileName?: string;
  enabled: boolean;
  repeatable: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type QueueEntryStatus =
  "queued" | "starting" | "playing" | "paused" | "completed" | "failed" | "skipped" | "cancelled";

export interface QueueEntry {
  id: string;
  mediaItemId: string;
  position: number;
  status: QueueEntryStatus;
  priority: number;
  scheduledStartAt?: string;
  startedAt?: string;
  completedAt?: string;
  attemptCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface PlaylistItem {
  playlistId: string;
  mediaItemId: string;
  position: number;
}

export interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
  createdAt: string;
  updatedAt: string;
}

export type PlaybackCommandType =
  | "play"
  | "pause"
  | "resume"
  | "stop"
  | "skip"
  | "restart"
  | "play-now"
  | "reload"
  | "restart-browser"
  | "restart-agent"
  | "login-youtube"
  | "login-prime";

export type PlaybackCommandStatus = "pending" | "accepted" | "completed" | "failed";

export interface PlaybackCommand {
  id: string;
  type: PlaybackCommandType;
  mediaItemId?: string;
  issuedAt: string;
  issuedBy: string;
  status: PlaybackCommandStatus;
}

export interface PlaybackEvent {
  id: string;
  queueEntryId?: string;
  mediaItemId?: string;
  type: string;
  message?: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export type PlaybackPhase =
  | "idle"
  | "launching-browser"
  | "loading"
  | "awaiting-play"
  | "playing"
  | "paused"
  | "buffering"
  | "ending"
  | "recovering"
  | "failed";

export interface PlaybackState {
  phase: PlaybackPhase;
  queueEntryId?: string;
  mediaItemId?: string;
  adapterId?: string;
  title?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  fullscreen?: boolean;
  lastProgressAt?: string;
  lastHeartbeatAt: string;
  recoveryAttempt: number;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface ApplianceStatus {
  applianceId: string;
  name: string;
  connected: boolean;
  lastSeenAt: string;
  playbackState?: PlaybackState;
}

export interface HealthStatus {
  service: string;
  status: "ok";
  timestamp: string;
}

export function createHealthStatus(service: string, now = new Date()): HealthStatus {
  return {
    service,
    status: "ok",
    timestamp: now.toISOString()
  };
}
