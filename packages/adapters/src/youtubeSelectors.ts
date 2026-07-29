import type { PlaybackObservation } from "./contract.js";
import { videoObservation, type VideoDomState } from "./videoObservation.js";

export interface YouTubeDomState extends VideoDomState {
  adShowing?: boolean;
  currentUrl?: string;
  hasAccountButton?: boolean;
  hasSignInButton?: boolean;
  text: string;
}

const blockerPatterns = [
  {
    code: "youtube-verification-required",
    pattern: /confirm it'?s you|verify it'?s you|this helps protect your account|couldn'?t sign you in/i
  },
  {
    code: "youtube-age-verification-required",
    pattern: /sign in to confirm your age|age-restricted|confirm your age/i
  },
  {
    code: "youtube-signin-required",
    pattern: /sign in to confirm|sign in to youtube|you'?re signed out|use youtube signed out|choose an account|use another account/i
  },
  { code: "youtube-consent-required", pattern: /before you continue to youtube|reject all|accept all/i },
  {
    code: "youtube-unavailable",
    pattern: /video unavailable|this video is unavailable|removed by the uploader/i
  },
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
  if (state.currentUrl && /(^|\.)accounts\.google\.com$/.test(hostname(state.currentUrl))) {
    return blocked("youtube-signin-required", state.text);
  }

  if (!state.hasVideo && state.hasSignInButton && !state.hasAccountButton) {
    return blocked("youtube-signin-required", state.text);
  }

  const blocker = blockerPatterns.find(({ pattern }) => pattern.test(state.text));

  if (blocker) {
    return blocker.code === "youtube-playback-error"
      ? { status: "error", errorCode: blocker.code, dialog: state.text.slice(0, 300) }
      : blocked(blocker.code, state.text);
  }

  if (state.adShowing) {
    const positionSeconds = Math.max(0, Math.floor(state.currentTime ?? 0));
    const durationSeconds = Math.max(1, Math.floor(state.duration ?? fallbackDurationSeconds));

    return {
      durationSeconds,
      fullscreen: state.fullscreen ?? false,
      positionSeconds,
      status: (state.readyState ?? 0) < 2 || state.paused || state.ended ? "buffering" : "playing"
    };
  }

  return videoObservation(state, fallbackDurationSeconds);
}

function blocked(code: string, text: string): PlaybackObservation {
  return {
    status: "blocked",
    errorCode: code,
    dialog: text.slice(0, 300)
  };
}

function hostname(input: string): string {
  try {
    return new URL(input).hostname;
  } catch {
    return "";
  }
}
