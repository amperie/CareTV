import type { PlaybackEvent, PlaybackPhase, PlaybackState } from "@caretv/core";

export type PlaybackStateEvent =
  | {
      type: "QUEUE_SELECTED";
      queueEntryId: string;
      mediaItemId: string;
      adapterId: string;
      title: string;
    }
  | { type: "BROWSER_LAUNCHED" }
  | { type: "READY" }
  | { type: "PLAYING"; positionSeconds?: number; durationSeconds?: number; fullscreen?: boolean }
  | { type: "PAUSED"; positionSeconds?: number }
  | { type: "RESUMED" }
  | { type: "BUFFERING" }
  | { type: "RECOVERING"; attempt: number }
  | { type: "FAILED"; code: string; message: string; details?: Record<string, unknown> }
  | { type: "COMPLETED"; positionSeconds?: number }
  | { type: "STOPPED" }
  | { type: "HEARTBEAT"; positionSeconds?: number };

export interface TransitionOptions {
  createId: () => string;
  now: () => Date;
}

export interface TransitionResult {
  state: PlaybackState;
  event: PlaybackEvent;
}

export class StateTransitionError extends Error {
  public override readonly name = "StateTransitionError";

  public constructor(
    public readonly from: PlaybackPhase,
    public readonly eventType: PlaybackStateEvent["type"]
  ) {
    super(`Invalid playback transition from ${from} using ${eventType}`);
  }
}

export function createIdleState(now = new Date()): PlaybackState {
  return {
    phase: "idle",
    lastHeartbeatAt: now.toISOString(),
    recoveryAttempt: 0
  };
}

export function transition(
  current: PlaybackState,
  event: PlaybackStateEvent,
  options: TransitionOptions
): TransitionResult {
  assertAllowed(current.phase, event.type);

  const timestamp = options.now().toISOString();
  const state = applyTransition(current, event, timestamp);

  return {
    state,
    event: {
      id: options.createId(),
      type: event.type,
      details: eventDetails(current.phase, state.phase, event),
      createdAt: timestamp,
      ...(state.queueEntryId ? { queueEntryId: state.queueEntryId } : {}),
      ...(state.mediaItemId ? { mediaItemId: state.mediaItemId } : {})
    }
  };
}

export function reconcileStartupState(state: PlaybackState, now = new Date()): PlaybackState {
  if (
    ["launching-browser", "loading", "awaiting-play", "playing", "paused", "buffering"].includes(
      state.phase
    )
  ) {
    return {
      ...state,
      phase: "recovering",
      lastHeartbeatAt: now.toISOString(),
      recoveryAttempt: state.recoveryAttempt + 1,
      error: {
        code: "process-restarted",
        message: "Playback state was active during process startup."
      }
    };
  }

  return { ...state, lastHeartbeatAt: now.toISOString() };
}

function assertAllowed(from: PlaybackPhase, eventType: PlaybackStateEvent["type"]): void {
  const allowed = allowedTransitions[from];

  if (!allowed.has(eventType)) {
    throw new StateTransitionError(from, eventType);
  }
}

function applyTransition(
  current: PlaybackState,
  event: PlaybackStateEvent,
  timestamp: string
): PlaybackState {
  switch (event.type) {
    case "QUEUE_SELECTED":
      return {
        phase: "launching-browser",
        queueEntryId: event.queueEntryId,
        mediaItemId: event.mediaItemId,
        adapterId: event.adapterId,
        title: event.title,
        lastHeartbeatAt: timestamp,
        recoveryAttempt: 0
      };
    case "BROWSER_LAUNCHED":
      return heartbeat({ ...current, phase: "loading" }, timestamp);
    case "READY":
      return heartbeat({ ...current, phase: "awaiting-play" }, timestamp);
    case "PLAYING":
      return withoutError({
        ...heartbeat({ ...current, phase: "playing" }, timestamp),
        ...(event.positionSeconds !== undefined ? { positionSeconds: event.positionSeconds } : {}),
        ...(event.durationSeconds !== undefined ? { durationSeconds: event.durationSeconds } : {}),
        ...(event.fullscreen !== undefined ? { fullscreen: event.fullscreen } : {}),
        lastProgressAt: timestamp
      });
    case "PAUSED":
      return {
        ...heartbeat({ ...current, phase: "paused" }, timestamp),
        ...(event.positionSeconds !== undefined ? { positionSeconds: event.positionSeconds } : {})
      };
    case "RESUMED":
      return heartbeat({ ...current, phase: "playing" }, timestamp);
    case "BUFFERING":
      return heartbeat({ ...current, phase: "buffering" }, timestamp);
    case "RECOVERING":
      return heartbeat(
        { ...current, phase: "recovering", recoveryAttempt: event.attempt },
        timestamp
      );
    case "FAILED":
      return heartbeat(
        {
          ...current,
          phase: "failed",
          error: {
            code: event.code,
            message: event.message,
            ...(event.details ? { details: event.details } : {})
          }
        },
        timestamp
      );
    case "COMPLETED":
      return {
        ...createIdleState(new Date(timestamp)),
        ...(event.positionSeconds !== undefined ? { positionSeconds: event.positionSeconds } : {})
      };
    case "STOPPED":
      return createIdleState(new Date(timestamp));
    case "HEARTBEAT":
      return {
        ...heartbeat(current, timestamp),
        ...(event.positionSeconds !== undefined ? { positionSeconds: event.positionSeconds } : {})
      };
  }
}

function heartbeat(state: PlaybackState, timestamp: string): PlaybackState {
  return {
    ...state,
    lastHeartbeatAt: timestamp
  };
}

function withoutError(state: PlaybackState): PlaybackState {
  const next = { ...state };
  delete next.error;
  return next;
}

function eventDetails(
  from: PlaybackPhase,
  to: PlaybackPhase,
  event: PlaybackStateEvent
): Record<string, unknown> {
  if (event.type === "FAILED") {
    return {
      from,
      to,
      code: event.code,
      message: event.message,
      ...(event.details ? { details: event.details } : {})
    };
  }

  return { from, to };
}

const allowedTransitions: Record<PlaybackPhase, ReadonlySet<PlaybackStateEvent["type"]>> = {
  idle: new Set(["QUEUE_SELECTED", "HEARTBEAT"]),
  "launching-browser": new Set(["BROWSER_LAUNCHED", "FAILED", "STOPPED", "HEARTBEAT"]),
  loading: new Set(["READY", "FAILED", "RECOVERING", "STOPPED", "HEARTBEAT"]),
  "awaiting-play": new Set([
    "BUFFERING",
    "PAUSED",
    "PLAYING",
    "COMPLETED",
    "FAILED",
    "RECOVERING",
    "STOPPED",
    "HEARTBEAT"
  ]),
  playing: new Set([
    "PLAYING",
    "PAUSED",
    "BUFFERING",
    "RECOVERING",
    "FAILED",
    "COMPLETED",
    "STOPPED",
    "HEARTBEAT"
  ]),
  paused: new Set(["PAUSED", "RESUMED", "RECOVERING", "FAILED", "STOPPED", "HEARTBEAT"]),
  buffering: new Set(["BUFFERING", "PLAYING", "RECOVERING", "FAILED", "STOPPED", "HEARTBEAT"]),
  ending: new Set(["COMPLETED", "FAILED", "STOPPED", "HEARTBEAT"]),
  recovering: new Set(["PLAYING", "FAILED", "STOPPED", "HEARTBEAT"]),
  failed: new Set(["QUEUE_SELECTED", "STOPPED", "HEARTBEAT"])
};
