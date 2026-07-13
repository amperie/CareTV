import { describe, expect, it } from "vitest";

import type { AdapterContext, AdapterLogger } from "./contract.js";
import { FakeStreamingAdapter, fakeFixtureHtml } from "./fakeAdapter.js";

import type { MediaItem } from "@caretv/core";

const logger: AdapterLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe("fake streaming adapter", () => {
  it("plays a normal fake item to completion", async () => {
    const clock = new TestClock();
    const adapter = new FakeStreamingAdapter();
    const context = fakeContext(clock, fakeMedia({ durationSeconds: 10 }));

    await adapter.prepare(context);
    await adapter.start(context);
    await adapter.enterFullscreen(context);

    clock.advanceSeconds(4);
    expect(await adapter.observe(context)).toMatchObject({
      status: "playing",
      positionSeconds: 4,
      fullscreen: true
    });

    clock.advanceSeconds(6);
    expect(await adapter.observe(context)).toMatchObject({
      status: "completed",
      positionSeconds: 10
    });
  });

  it("blocks on a known interruption and dismisses it", async () => {
    const clock = new TestClock();
    const adapter = new FakeStreamingAdapter();
    const context = fakeContext(
      clock,
      fakeMedia({
        scenario: "interrupt-then-recover",
        durationSeconds: 30,
        interruptAtSeconds: 5
      })
    );

    await adapter.prepare(context);
    await adapter.start(context);
    clock.advanceSeconds(5);

    expect(await adapter.observe(context)).toMatchObject({
      status: "blocked",
      errorCode: "still-watching"
    });
    expect(await adapter.dismissKnownInterruptions(context)).toBe(true);
    expect(await adapter.observe(context)).toMatchObject({ status: "playing" });
  });

  it("supports deterministic recovery attempts", async () => {
    const adapter = new FakeStreamingAdapter();
    const context = fakeContext(
      new TestClock(),
      fakeMedia({
        scenario: "interrupt-then-recover",
        recoverySucceedsOnAttempt: 2
      })
    );

    await adapter.prepare(context);

    expect(await adapter.recover(context, 1)).toMatchObject({ recovered: false });
    expect(await adapter.recover(context, 2)).toMatchObject({ recovered: true });
  });

  it("exposes a browser fixture page", () => {
    expect(fakeFixtureHtml).toContain("CareTV Fake Adapter Fixture");
    expect(fakeFixtureHtml).toContain("<video");
  });
});

class TestClock {
  private currentMs = Date.parse("2026-01-01T00:00:00.000Z");

  public now(): Date {
    return new Date(this.currentMs);
  }

  public advanceSeconds(seconds: number): void {
    this.currentMs += seconds * 1000;
  }
}

function fakeContext(clock: TestClock, mediaItem: MediaItem): AdapterContext {
  return {
    logger,
    mediaItem,
    signal: new AbortController().signal,
    now: () => clock.now()
  };
}

function fakeMedia(metadata: Record<string, unknown>): MediaItem {
  return {
    id: "media-1",
    title: "Fake media",
    service: "fake",
    mediaType: "video",
    expectedDurationSeconds: 60,
    enabled: true,
    repeatable: true,
    metadata,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
