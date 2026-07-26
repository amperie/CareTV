import type { PlaybackObservation } from "./contract.js";

export interface PrimeDomState {
  currentTime?: number;
  duration?: number;
  ended?: boolean;
  fullscreen?: boolean;
  hasVideo: boolean;
  paused?: boolean;
  readyState?: number;
  text: string;
}

const blockerPatterns = [
  { code: "prime-login-required", pattern: /sign in|log in/i },
  { code: "prime-profile-required", pattern: /who'?s watching|select a profile/i },
  { code: "prime-purchase-required", pattern: /rent|buy|purchase/i },
  { code: "prime-unavailable", pattern: /currently unavailable|not available|location/i },
  { code: "prime-playback-error", pattern: /something went wrong|video unavailable|playback error/i }
];

export const primeSelectors = {
  fullscreenButton: [
    "[aria-label*='Full Screen' i]",
    "[aria-label*='Fullscreen' i]",
    "[data-testid*='fullscreen' i]"
  ],
  playButton: [
    "[aria-label*='Resume' i]",
    "[aria-label*='Play' i]",
    "[data-testid*='play' i]"
  ],
  video: "video"
};

export function observationFromPrimeDom(
  state: PrimeDomState,
  fallbackDurationSeconds: number
): PlaybackObservation {
  const blocker = blockerPatterns.find(({ pattern }) => pattern.test(state.text));

  if (blocker) {
    return {
      status: blocker.code === "prime-playback-error" ? "error" : "blocked",
      errorCode: blocker.code,
      dialog: state.text.slice(0, 300)
    };
  }

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

function observation(
  status: PlaybackObservation["status"],
  positionSeconds: number,
  durationSeconds: number,
  fullscreen = false
): PlaybackObservation {
  return { durationSeconds, fullscreen, positionSeconds, status };
}
