import type { MediaItem } from "@caretv/core";

export interface AdapterLogger {
  info: (data: Record<string, unknown>, message?: string) => void;
  warn: (data: Record<string, unknown>, message?: string) => void;
  error: (data: Record<string, unknown>, message?: string) => void;
}

export interface AdapterContext {
  logger: AdapterLogger;
  mediaItem: MediaItem;
  signal: AbortSignal;
  now: () => Date;
}

export interface PlaybackObservation {
  status:
    "unknown" | "ready" | "playing" | "paused" | "buffering" | "completed" | "blocked" | "error";
  positionSeconds?: number;
  durationSeconds?: number;
  fullscreen?: boolean;
  dialog?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export interface RecoveryResult {
  recovered: boolean;
  message: string;
  retryAfterMs?: number;
}

export interface StreamingAdapter {
  readonly id: string;
  readonly version: string;

  supports(item: MediaItem): boolean;
  prepare(context: AdapterContext): Promise<void>;
  start(context: AdapterContext): Promise<void>;
  pause(context: AdapterContext): Promise<void>;
  resume(context: AdapterContext): Promise<void>;
  stop(context: AdapterContext): Promise<void>;
  enterFullscreen(context: AdapterContext): Promise<void>;
  observe(context: AdapterContext): Promise<PlaybackObservation>;
  dismissKnownInterruptions(context: AdapterContext): Promise<boolean>;
  recover(context: AdapterContext, attempt: number): Promise<RecoveryResult>;
  cleanup(context: AdapterContext): Promise<void>;
}
