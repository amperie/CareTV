import type { PlaybackObservation } from "./contract.js";
import { videoObservation, type VideoDomState } from "./videoObservation.js";

export interface PrimeDomState extends VideoDomState {
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

  return videoObservation(state, fallbackDurationSeconds);
}
