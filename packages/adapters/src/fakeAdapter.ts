import type { MediaItem } from "@caretv/core";

import type {
  AdapterContext,
  PlaybackObservation,
  RecoveryResult,
  StreamingAdapter
} from "./contract.js";

type FakeScenario =
  | "normal"
  | "delayed-start"
  | "buffering"
  | "interrupt-then-recover"
  | "login-required"
  | "playback-failure"
  | "frozen-progress"
  | "permanent-failure";

interface FakeSession {
  durationSeconds: number;
  fullscreen: boolean;
  pausedAtMs?: number;
  startedAtMs?: number;
  stopped: boolean;
  recovered: boolean;
}

interface FakeScenarioConfig {
  scenario: FakeScenario;
  durationSeconds: number;
  delaySeconds: number;
  interruptAtSeconds: number;
  bufferingAtSeconds: number;
  bufferingDurationSeconds: number;
  recoverySucceedsOnAttempt: number;
}

export class FakeStreamingAdapter implements StreamingAdapter {
  public readonly id = "fake";
  public readonly version = "0.1.0";

  private readonly sessions = new Map<string, FakeSession>();

  public supports(item: MediaItem): boolean {
    return item.service === "fake";
  }

  public prepare(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    this.sessions.set(context.mediaItem.id, {
      durationSeconds: scenarioConfig(context.mediaItem).durationSeconds,
      fullscreen: false,
      stopped: false,
      recovered: false
    });
    return Promise.resolve();
  }

  public start(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    this.session(context).startedAtMs = context.now().getTime();
    return Promise.resolve();
  }

  public pause(context: AdapterContext): Promise<void> {
    this.session(context).pausedAtMs = context.now().getTime();
    return Promise.resolve();
  }

  public restart(context: AdapterContext): Promise<void> {
    const session = this.session(context);
    session.startedAtMs = context.now().getTime();
    session.stopped = false;
    delete session.pausedAtMs;
    return Promise.resolve();
  }

  public resume(context: AdapterContext): Promise<void> {
    const session = this.session(context);

    if (session.pausedAtMs !== undefined && session.startedAtMs !== undefined) {
      session.startedAtMs += context.now().getTime() - session.pausedAtMs;
    }

    delete session.pausedAtMs;
    return Promise.resolve();
  }

  public stop(context: AdapterContext): Promise<void> {
    this.session(context).stopped = true;
    return Promise.resolve();
  }

  public enterFullscreen(context: AdapterContext): Promise<void> {
    this.session(context).fullscreen = true;
    return Promise.resolve();
  }

  public observe(context: AdapterContext): Promise<PlaybackObservation> {
    throwIfAborted(context.signal);

    const config = scenarioConfig(context.mediaItem);
    const session = this.session(context);

    if (session.stopped) {
      return Promise.resolve(observation("completed", session, session.durationSeconds));
    }

    if (session.pausedAtMs !== undefined) {
      return Promise.resolve(
        observation("paused", session, elapsedSeconds(session, session.pausedAtMs))
      );
    }

    if (session.startedAtMs === undefined) {
      return Promise.resolve(observation("ready", session, 0));
    }

    const position = elapsedSeconds(session, context.now().getTime());

    if (config.scenario === "login-required") {
      return Promise.resolve(blocked("login-required", "Login required"));
    }

    if (config.scenario === "permanent-failure" || config.scenario === "playback-failure") {
      return Promise.resolve(error("playback-failed", "Fake playback failure"));
    }

    if (config.scenario === "delayed-start" && position < config.delaySeconds) {
      return Promise.resolve(observation("ready", session, 0));
    }

    if (
      config.scenario === "interrupt-then-recover" &&
      !session.recovered &&
      position >= config.interruptAtSeconds
    ) {
      return Promise.resolve(blocked("still-watching", "Are you still watching?"));
    }

    if (
      config.scenario === "buffering" &&
      position >= config.bufferingAtSeconds &&
      position < config.bufferingAtSeconds + config.bufferingDurationSeconds
    ) {
      return Promise.resolve(observation("buffering", session, position));
    }

    if (config.scenario === "frozen-progress") {
      return Promise.resolve(
        observation("playing", session, Math.min(position, config.interruptAtSeconds))
      );
    }

    if (position >= session.durationSeconds) {
      return Promise.resolve(observation("completed", session, session.durationSeconds));
    }

    return Promise.resolve(observation("playing", session, position));
  }

  public dismissKnownInterruptions(context: AdapterContext): Promise<boolean> {
    const session = this.session(context);
    const config = scenarioConfig(context.mediaItem);

    if (config.scenario !== "interrupt-then-recover") {
      return Promise.resolve(false);
    }

    session.recovered = true;
    context.logger.info({ adapterId: this.id }, "Dismissed fake interruption");
    return Promise.resolve(true);
  }

  public recover(context: AdapterContext, attempt: number): Promise<RecoveryResult> {
    const session = this.session(context);
    const config = scenarioConfig(context.mediaItem);

    if (attempt >= config.recoverySucceedsOnAttempt && config.scenario !== "permanent-failure") {
      session.recovered = true;
      return Promise.resolve({ recovered: true, message: "Fake recovery succeeded" });
    }

    return Promise.resolve({
      recovered: false,
      message: "Fake recovery did not succeed",
      retryAfterMs: 1000
    });
  }

  public cleanup(context: AdapterContext): Promise<void> {
    this.sessions.delete(context.mediaItem.id);
    return Promise.resolve();
  }

  private session(context: AdapterContext): FakeSession {
    const session = this.sessions.get(context.mediaItem.id);

    if (!session) {
      throw new Error(`Fake adapter session was not prepared for ${context.mediaItem.id}`);
    }

    return session;
  }
}

export const fakeFixtureHtml = String.raw`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>CareTV Fake Adapter Fixture</title></head>
  <body>
    <main>
      <h1>CareTV Fake Adapter Fixture</h1>
      <video id="player" controls></video>
      <div id="interruption" hidden>Are you still watching?</div>
    </main>
  </body>
</html>`;

function scenarioConfig(item: MediaItem): FakeScenarioConfig {
  const metadata = item.metadata;
  return {
    scenario: stringValue(metadata.scenario, "normal") as FakeScenario,
    durationSeconds: numberValue(metadata.durationSeconds, item.expectedDurationSeconds ?? 60),
    delaySeconds: numberValue(metadata.delaySeconds, 5),
    interruptAtSeconds: numberValue(metadata.interruptAtSeconds, 15),
    bufferingAtSeconds: numberValue(metadata.bufferingAtSeconds, 10),
    bufferingDurationSeconds: numberValue(metadata.bufferingDurationSeconds, 5),
    recoverySucceedsOnAttempt: numberValue(metadata.recoverySucceedsOnAttempt, 1)
  };
}

function elapsedSeconds(session: FakeSession, nowMs: number): number {
  return session.startedAtMs === undefined
    ? 0
    : Math.max(0, Math.floor((nowMs - session.startedAtMs) / 1000));
}

function observation(
  status: PlaybackObservation["status"],
  session: FakeSession,
  positionSeconds: number
): PlaybackObservation {
  return {
    status,
    positionSeconds,
    durationSeconds: session.durationSeconds,
    fullscreen: session.fullscreen
  };
}

function blocked(errorCode: string, dialog: string): PlaybackObservation {
  return { status: "blocked", errorCode, dialog };
}

function error(errorCode: string, message: string): PlaybackObservation {
  return { status: "error", errorCode, details: { message } };
}

function numberValue(input: unknown, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback;
}

function stringValue(input: unknown, fallback: string): string {
  return typeof input === "string" ? input : fallback;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Adapter operation was aborted.");
  }
}
