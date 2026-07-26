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
      errorCode: "youtube-signin-required",
      status: "blocked"
    });
  });
});
