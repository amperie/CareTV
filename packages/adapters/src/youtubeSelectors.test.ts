import { describe, expect, it } from "vitest";

import { observationFromYouTubeDom } from "./youtubeSelectors.js";

describe("youtube selectors", () => {
  it("reports playing video state", () => {
    expect(
      observationFromYouTubeDom(
        {
          currentTime: 12,
          duration: 90,
          fullscreen: false,
          hasVideo: true,
          paused: false,
          readyState: 4,
          text: ""
        },
        900
      )
    ).toMatchObject({
      durationSeconds: 90,
      positionSeconds: 12,
      status: "playing"
    });
  });

  it("reports unavailable and age-restricted blockers", () => {
    expect(
      observationFromYouTubeDom({ hasVideo: false, text: "Video unavailable" }, 900)
    ).toMatchObject({
      errorCode: "youtube-unavailable",
      status: "blocked"
    });
    expect(
      observationFromYouTubeDom({ hasVideo: false, text: "Sign in to confirm your age" }, 900)
    ).toMatchObject({
      errorCode: "youtube-age-verification-required",
      status: "blocked"
    });
  });

  it("reports private and unavailable terminal pages", () => {
    expect(
      observationFromYouTubeDom({ hasVideo: false, text: "This video is private" }, 900)
    ).toMatchObject({
      errorCode: "youtube-private",
      status: "blocked"
    });
    expect(
      observationFromYouTubeDom({ hasVideo: false, text: "This video isn't available anymore" }, 900)
    ).toMatchObject({
      errorCode: "youtube-unavailable",
      status: "blocked"
    });
  });

  it("completes when YouTube has navigated to a different video", () => {
    expect(
      observationFromYouTubeDom(
        {
          currentTime: 12,
          currentUrl: "https://www.youtube.com/watch?v=next456",
          duration: 90,
          expectedVideoId: "abc123",
          hasVideo: true,
          paused: false,
          readyState: 4,
          text: ""
        },
        900
      )
    ).toMatchObject({
      status: "completed"
    });
  });

  it("keeps playing when YouTube is still on the expected video", () => {
    expect(
      observationFromYouTubeDom(
        {
          currentTime: 12,
          currentUrl: "https://www.youtube.com/watch?v=abc123",
          duration: 90,
          expectedVideoId: "abc123",
          hasVideo: true,
          paused: false,
          readyState: 4,
          text: ""
        },
        900
      )
    ).toMatchObject({
      positionSeconds: 12,
      status: "playing"
    });
  });

  it("reports signed-out and verification blockers", () => {
    expect(
      observationFromYouTubeDom(
        { currentUrl: "https://accounts.google.com/ServiceLogin", hasVideo: false, text: "" },
        900
      )
    ).toMatchObject({
      errorCode: "youtube-signin-required",
      status: "blocked"
    });
    expect(
      observationFromYouTubeDom(
        { hasAccountButton: false, hasSignInButton: true, hasVideo: false, text: "" },
        900
      )
    ).toMatchObject({
      errorCode: "youtube-signin-required",
      status: "blocked"
    });
    expect(
      observationFromYouTubeDom(
        { hasVideo: false, text: "This helps protect your account. Verify it's you." },
        900
      )
    ).toMatchObject({
      errorCode: "youtube-verification-required",
      status: "blocked"
    });
  });

  it("does not block public playback just because the sign-in button is visible", () => {
    expect(
      observationFromYouTubeDom(
        {
          currentTime: 5,
          duration: 60,
          hasAccountButton: false,
          hasSignInButton: true,
          hasVideo: true,
          paused: false,
          readyState: 4,
          text: ""
        },
        900
      )
    ).toMatchObject({
      positionSeconds: 5,
      status: "playing"
    });
  });

  it("does not treat a completed preroll ad as completed content", () => {
    expect(
      observationFromYouTubeDom(
        {
          adShowing: true,
          currentTime: 15,
          duration: 15,
          ended: true,
          fullscreen: true,
          hasVideo: true,
          paused: true,
          readyState: 4,
          text: ""
        },
        900
      )
    ).toMatchObject({
      durationSeconds: 15,
      fullscreen: true,
      positionSeconds: 15,
      status: "buffering"
    });
  });
});
