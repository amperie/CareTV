import type { PlaybackObservation } from "./contract.js";
import { videoObservation, type VideoDomState } from "./videoObservation.js";

export interface YouTubeDomState extends VideoDomState {
  text: string;
}

const blockerPatterns = [
  { code: "youtube-signin-required", pattern: /sign in to confirm|sign in to youtube/i },
  { code: "youtube-age-restricted", pattern: /age-restricted|confirm your age/i },
  { code: "youtube-unavailable", pattern: /video unavailable|this video is unavailable|removed by the uploader/i },
  { code: "youtube-private", pattern: /private video/i },
  { code: "youtube-playback-error", pattern: /an error occurred|playback error/i }
];

export const youtubeSelectors = {
  fullscreenButton: [".ytp-fullscreen-button", "[aria-label*='Full screen' i]"],
  playButton: [".ytp-play-button", "[aria-label='Play']", "[aria-label='Pause']"],
  skipAdButton: [".ytp-ad-skip-button", ".ytp-skip-ad-button", "button.ytp-ad-skip-button-modern"],
  video: "video"
};

export function observationFromYouTubeDom(
  state: YouTubeDomState,
  fallbackDurationSeconds: number
): PlaybackObservation {
  const blocker = blockerPatterns.find(({ pattern }) => pattern.test(state.text));

  if (blocker) {
    return {
      status: blocker.code === "youtube-playback-error" ? "error" : "blocked",
      errorCode: blocker.code,
      dialog: state.text.slice(0, 300)
    };
  }

  return videoObservation(state, fallbackDurationSeconds);
}
