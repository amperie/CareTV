import { describe, expect, it } from "vitest";

import { observationFromPrimeDom } from "./primeSelectors.js";

describe("prime selectors", () => {
  it("reports playing video state", () => {
    expect(
      observationFromPrimeDom(
        {
          currentTime: 42,
          duration: 120,
          fullscreen: true,
          hasVideo: true,
          paused: false,
          readyState: 4,
          text: ""
        },
        7200
      )
    ).toMatchObject({
      durationSeconds: 120,
      fullscreen: true,
      positionSeconds: 42,
      status: "playing"
    });
  });

  it("reports login and purchase blockers", () => {
    expect(
      observationFromPrimeDom({ hasVideo: false, text: "Sign in to continue" }, 7200)
    ).toMatchObject({
      errorCode: "prime-login-required",
      status: "blocked"
    });
    expect(
      observationFromPrimeDom({ hasVideo: false, text: "Rent or buy this title" }, 7200)
    ).toMatchObject({
      errorCode: "prime-purchase-required",
      status: "blocked"
    });
  });
});
