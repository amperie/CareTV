import type { MediaItem } from "@caretv/core";

import type { PlaybackObservation } from "./contract.js";

export interface VideoDomState {
  currentTime?: number;
  duration?: number;
  ended?: boolean;
  fullscreen?: boolean;
  hasVideo: boolean;
  paused?: boolean;
  readyState?: number;
}

export function videoObservation(
  state: VideoDomState,
  fallbackDurationSeconds: number
): PlaybackObservation {
  if (!state.hasVideo) {
    return { status: "ready", positionSeconds: 0 };
  }

  const positionSeconds = Math.max(0, Math.floor(state.currentTime ?? 0));
  const durationSeconds = Math.max(1, Math.floor(state.duration ?? fallbackDurationSeconds));

  if (state.ended || positionSeconds >= durationSeconds) {
    return observation("completed", positionSeconds, durationSeconds, state.fullscreen);
  }

  if ((state.readyState ?? 0) < 2) {
    return observation("buffering", positionSeconds, durationSeconds, state.fullscreen);
  }

  return observation(
    state.paused ? "paused" : "playing",
    positionSeconds,
    durationSeconds,
    state.fullscreen
  );
}

export function durationSecondsFor(item: MediaItem, fallback = 7200): number {
  const metadataDuration = item.metadata.durationSeconds;
  const duration =
    typeof metadataDuration === "number" && Number.isFinite(metadataDuration)
      ? metadataDuration
      : (item.expectedDurationSeconds ?? fallback);
  return Math.max(1, Math.floor(duration));
}

function observation(
  status: PlaybackObservation["status"],
  positionSeconds: number,
  durationSeconds: number,
  fullscreen = false
): PlaybackObservation {
  return { durationSeconds, fullscreen, positionSeconds, status };
}
