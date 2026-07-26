import { describe, expect, it } from "vitest";

import {
  createIdleState,
  reconcileStartupState,
  StateTransitionError,
  transition
} from "./index.js";

const date = new Date("2026-01-01T00:00:00.000Z");
const options = {
  createId: () => "event-1",
  now: () => date
};

describe("playback state machine", () => {
  it("walks the normal startup path", () => {
    const selected = transition(
      createIdleState(date),
      {
        type: "QUEUE_SELECTED",
        queueEntryId: "queue-1",
        mediaItemId: "media-1",
        adapterId: "fake",
        title: "Test"
      },
      options
    );
    const launched = transition(selected.state, { type: "BROWSER_LAUNCHED" }, options);
    const ready = transition(launched.state, { type: "READY" }, options);
    const playing = transition(
      ready.state,
      { type: "PLAYING", positionSeconds: 1, durationSeconds: 10, fullscreen: true },
      options
    );

    expect(playing.state).toMatchObject({
      phase: "playing",
      queueEntryId: "queue-1",
      mediaItemId: "media-1",
      positionSeconds: 1,
      durationSeconds: 10,
      fullscreen: true
    });
    expect(playing.event).toMatchObject({
      queueEntryId: "queue-1",
      type: "PLAYING",
      details: { from: "awaiting-play", to: "playing" }
    });
  });

  it("rejects invalid transitions", () => {
    expect(() => transition(createIdleState(date), { type: "PLAYING" }, options)).toThrow(
      StateTransitionError
    );
  });

  it("allows initial buffering before playback starts", () => {
    const selected = transition(
      createIdleState(date),
      {
        type: "QUEUE_SELECTED",
        queueEntryId: "queue-1",
        mediaItemId: "media-1",
        adapterId: "youtube",
        title: "Test"
      },
      options
    );
    const launched = transition(selected.state, { type: "BROWSER_LAUNCHED" }, options);
    const ready = transition(launched.state, { type: "READY" }, options);
    const buffering = transition(ready.state, { type: "BUFFERING" }, options);

    expect(buffering.state.phase).toBe("buffering");
    expect(buffering.event.details).toMatchObject({
      from: "awaiting-play",
      to: "buffering"
    });
  });

  it("allows initial paused state before playback starts", () => {
    const selected = transition(
      createIdleState(date),
      {
        type: "QUEUE_SELECTED",
        queueEntryId: "queue-1",
        mediaItemId: "media-1",
        adapterId: "youtube",
        title: "Test"
      },
      options
    );
    const launched = transition(selected.state, { type: "BROWSER_LAUNCHED" }, options);
    const ready = transition(launched.state, { type: "READY" }, options);
    const paused = transition(ready.state, { type: "PAUSED", positionSeconds: 0 }, options);

    expect(paused.state.phase).toBe("paused");
    expect(paused.event.details).toMatchObject({
      from: "awaiting-play",
      to: "paused"
    });
  });

  it("records failure details", () => {
    const result = transition(
      {
        ...createIdleState(date),
        phase: "playing",
        queueEntryId: "queue-1",
        mediaItemId: "media-1"
      },
      { type: "FAILED", code: "adapter-error", message: "Adapter failed" },
      options
    );

    expect(result.state).toMatchObject({
      phase: "failed",
      error: { code: "adapter-error", message: "Adapter failed" }
    });
    expect(result.event.details).toMatchObject({
      from: "playing",
      to: "failed",
      code: "adapter-error",
      message: "Adapter failed"
    });
  });

  it("reconciles active startup state into recovery", () => {
    expect(
      reconcileStartupState({
        ...createIdleState(date),
        phase: "playing",
        recoveryAttempt: 1
      })
    ).toMatchObject({
      phase: "recovering",
      recoveryAttempt: 2,
      error: { code: "process-restarted" }
    });
  });
});
