import {
  isBrowserPageClosedError,
  type AdapterLogger,
  type PlaybackObservation,
  type StreamingAdapter
} from "@caretv/adapters";
import type { MediaItem, PlaybackCommand, PlaybackState } from "@caretv/core";
import type {
  CommandRepository,
  MediaRepository,
  PlaybackEventRepository,
  QueueRepository
} from "@caretv/database";
import { createIdleState, transition } from "@caretv/state-machine";
import type { PlaybackStateEvent } from "@caretv/state-machine";

export type AgentRunResult =
  | { status: "idle" }
  | { status: "completed"; queueEntryId: string }
  | { status: "failed"; queueEntryId: string; errorCode: string }
  | { status: "skipped"; queueEntryId: string };

export interface PlaybackAgentOptions {
  adapters: StreamingAdapter[];
  commands: Pick<CommandRepository, "listPending" | "updateStatus">;
  events: Pick<PlaybackEventRepository, "append">;
  logger: AdapterLogger;
  media: Pick<MediaRepository, "get">;
  queue: Pick<QueueRepository, "selectNextQueued" | "updateStatus">;
  createId?: () => string;
  maxObservations?: number;
  now?: () => Date;
  observeIntervalMs?: number;
  onStateChange?: (state: PlaybackState) => void;
}

const fullscreenCheckMs = 10_000;

export class PlaybackAgent {
  private readonly abort = new AbortController();
  private state: PlaybackState;

  public constructor(private readonly options: PlaybackAgentOptions) {
    this.state = createIdleState(this.now());
  }

  public getState(): PlaybackState {
    return this.state;
  }

  public async runOnce(): Promise<AgentRunResult> {
    const queueEntry = this.options.queue.selectNextQueued(this.timestamp());

    if (!queueEntry) {
      return { status: "idle" };
    }

    const mediaItem = this.options.media.get(queueEntry.mediaItemId);

    if (!mediaItem) {
      this.options.queue.updateStatus(queueEntry.id, "failed", {
        lastErrorCode: "media-not-found",
        lastErrorMessage: `Media item ${queueEntry.mediaItemId} was not found.`
      });
      return { status: "failed", queueEntryId: queueEntry.id, errorCode: "media-not-found" };
    }

    const adapter = this.findAdapter(mediaItem);

    if (!adapter) {
      this.options.queue.updateStatus(queueEntry.id, "failed", {
        lastErrorCode: "adapter-not-found",
        lastErrorMessage: `No adapter supports ${mediaItem.service}.`
      });
      return { status: "failed", queueEntryId: queueEntry.id, errorCode: "adapter-not-found" };
    }

    this.apply({
      type: "QUEUE_SELECTED",
      queueEntryId: queueEntry.id,
      mediaItemId: mediaItem.id,
      adapterId: adapter.id,
      title: mediaItem.title
    });

    const context = {
      logger: this.options.logger,
      mediaItem,
      signal: this.abort.signal,
      now: () => this.now()
    };

    try {
      if (!(await this.startWithRecovery(queueEntry.id, adapter, context))) {
        return {
          status: "failed",
          queueEntryId: queueEntry.id,
          errorCode: "browser-recovery-failed"
        };
      }

      return await this.monitor(queueEntry.id, adapter, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown agent error";
      this.fail(queueEntry.id, "agent-error", message);
      return { status: "failed", queueEntryId: queueEntry.id, errorCode: "agent-error" };
    } finally {
      await adapter.cleanup(context);
    }
  }

  private async startWithRecovery(
    queueEntryId: string,
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0]
  ): Promise<boolean> {
    try {
      await this.startPlayback(adapter, context);
      return true;
    } catch (error) {
      if (!isBrowserPageClosedError(error)) {
        throw error;
      }

      const attempt = this.state.recoveryAttempt + 1;
      this.apply({ type: "RECOVERING", attempt });
      const recovery = await adapter.recover(context, attempt);

      if (!recovery.recovered) {
        this.fail(queueEntryId, "browser-recovery-failed", recovery.message);
        return false;
      }

      this.apply({ type: "PLAYING", positionSeconds: 0 });
      return true;
    }
  }

  private async startPlayback(
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0]
  ): Promise<void> {
    await adapter.prepare(context);
    this.apply({ type: "BROWSER_LAUNCHED" });
    await adapter.start(context);
    await adapter.enterFullscreen(context);
    await adapter.resume(context);
    await adapter.enterFullscreen(context);
    this.apply({ type: "READY" });
  }

  private async monitor(
    queueEntryId: string,
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0]
  ): Promise<AgentRunResult> {
    const maxObservations = this.options.maxObservations ?? 120;
    let nextFullscreenCheckAt = 0;

    for (let count = 0; count < maxObservations; count += 1) {
      const commandResult = await this.applyPendingCommands(queueEntryId, adapter, context);

      if (commandResult) {
        return commandResult;
      }

      const observation = await this.observeWithRecovery(queueEntryId, adapter, context);

      if (!observation) {
        return { status: "failed", queueEntryId, errorCode: "browser-recovery-failed" };
      }

      nextFullscreenCheckAt = await this.maintainFullscreen(
        adapter,
        context,
        observation,
        nextFullscreenCheckAt
      );
      const result = await this.applyObservation(queueEntryId, adapter, context, observation);

      if (result) {
        return result;
      }

      if (this.options.observeIntervalMs && this.options.observeIntervalMs > 0) {
        await sleep(this.options.observeIntervalMs);
      }
    }

    this.fail(queueEntryId, "observation-limit", "Fake playback did not finish in time.");
    return { status: "failed", queueEntryId, errorCode: "observation-limit" };
  }

  private async observeWithRecovery(
    queueEntryId: string,
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0]
  ): Promise<PlaybackObservation | undefined> {
    try {
      return await adapter.observe(context);
    } catch (error) {
      if (!isBrowserPageClosedError(error)) {
        throw error;
      }

      const attempt = this.state.recoveryAttempt + 1;
      this.apply({ type: "RECOVERING", attempt });
      const recovery = await adapter.recover(context, attempt);

      if (!recovery.recovered) {
        this.fail(queueEntryId, "browser-recovery-failed", recovery.message);
        return undefined;
      }

      this.apply({ type: "PLAYING", positionSeconds: 0 });
      return { status: "ready", positionSeconds: 0 };
    }
  }

  private async applyPendingCommands(
    queueEntryId: string,
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0]
  ): Promise<AgentRunResult | undefined> {
    for (const command of this.options.commands.listPending()) {
      if (command.type === "login-youtube" || command.type === "login-prime") {
        continue;
      }

      if (command.mediaItemId && command.mediaItemId !== context.mediaItem.id) {
        this.options.commands.updateStatus(command.id, "failed");
        continue;
      }

      if (!canApplyCommand(command.type, this.state.phase)) {
        this.options.commands.updateStatus(command.id, "failed");
        continue;
      }

      const result = await this.applyCommand(queueEntryId, adapter, context, command);
      this.options.commands.updateStatus(command.id, result ? "completed" : "accepted");

      if (result) {
        return result;
      }
    }

    return undefined;
  }

  private async applyCommand(
    queueEntryId: string,
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0],
    command: PlaybackCommand
  ): Promise<AgentRunResult | undefined> {
    switch (command.type) {
      case "pause":
        await adapter.pause(context);
        this.apply({ type: "PAUSED" });
        return undefined;
      case "resume":
        await adapter.resume(context);
        this.apply({ type: "RESUMED" });
        return undefined;
      case "restart":
        await adapter.restart(context);
        if (this.state.phase === "paused") {
          this.apply({ type: "RESUMED" });
        }
        this.apply({ type: "PLAYING", positionSeconds: 0 });
        return undefined;
      case "skip":
      case "stop":
        await adapter.stop(context);
        this.options.queue.updateStatus(queueEntryId, "skipped", { completedAt: this.timestamp() });
        this.apply({ type: "STOPPED" });
        return { status: "skipped", queueEntryId };
      default:
        return undefined;
    }
  }

  private async applyObservation(
    queueEntryId: string,
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0],
    observation: PlaybackObservation
  ): Promise<AgentRunResult | undefined> {
    switch (observation.status) {
      case "ready":
      case "unknown":
        this.apply(positionEvent("HEARTBEAT", observation.positionSeconds));
        return undefined;
      case "playing":
        this.options.queue.updateStatus(queueEntryId, "playing");
        this.apply(playingEvent(observation));
        return undefined;
      case "paused":
        if (this.state.phase !== "paused") {
          await adapter.resume(context);
          this.apply(positionEvent("HEARTBEAT", observation.positionSeconds));
          return undefined;
        }

        this.options.queue.updateStatus(queueEntryId, "paused");
        this.apply(positionEvent("PAUSED", observation.positionSeconds));
        return undefined;
      case "buffering":
        this.apply({ type: "BUFFERING" });
        return undefined;
      case "blocked":
        if (await adapter.dismissKnownInterruptions(context)) {
          this.apply({ type: "RECOVERING", attempt: this.state.recoveryAttempt + 1 });
          return undefined;
        }

        this.fail(
          queueEntryId,
          observation.errorCode ?? "blocked",
          observation.dialog ?? "Playback blocked."
        );
        return {
          status: "failed",
          queueEntryId,
          errorCode: observation.errorCode ?? "blocked"
        };
      case "error":
        this.fail(
          queueEntryId,
          observation.errorCode ?? "adapter-error",
          "Adapter reported playback error."
        );
        return {
          status: "failed",
          queueEntryId,
          errorCode: observation.errorCode ?? "adapter-error"
        };
      case "completed":
        this.options.queue.updateStatus(queueEntryId, "completed", {
          completedAt: this.timestamp()
        });
        this.apply(positionEvent("COMPLETED", observation.positionSeconds));
        return { status: "completed", queueEntryId };
    }
  }

  private fail(queueEntryId: string, code: string, message: string): void {
    this.options.queue.updateStatus(queueEntryId, "failed", {
      completedAt: this.timestamp(),
      lastErrorCode: code,
      lastErrorMessage: message
    });
    this.apply({ type: "FAILED", code, message });
  }

  private apply(event: PlaybackStateEvent): void {
    const result = transition(this.state, event, {
      createId: this.options.createId ?? (() => crypto.randomUUID()),
      now: () => this.now()
    });
    this.state = result.state;
    this.options.events.append(result.event);
    this.options.onStateChange?.(this.state);
  }

  private findAdapter(item: MediaItem): StreamingAdapter | undefined {
    return this.options.adapters.find((adapter) => adapter.supports(item));
  }

  private async maintainFullscreen(
    adapter: StreamingAdapter,
    context: Parameters<StreamingAdapter["observe"]>[0],
    observation: PlaybackObservation,
    nextFullscreenCheckAt: number
  ): Promise<number> {
    const now = this.now().getTime();

    if (!["playing", "buffering"].includes(observation.status) || now < nextFullscreenCheckAt) {
      return nextFullscreenCheckAt;
    }

    await adapter.enterFullscreen(context).catch((error) =>
      this.options.logger.warn(
        {
          adapterId: adapter.id,
          error: error instanceof Error ? error.message : "Unknown error",
          mediaItemId: context.mediaItem.id
        },
        "Fullscreen restore failed."
      )
    );
    return now + fullscreenCheckMs;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function positionEvent(
  type: "HEARTBEAT" | "PAUSED" | "COMPLETED",
  positionSeconds: number | undefined
): PlaybackStateEvent {
  return {
    type,
    ...(positionSeconds !== undefined ? { positionSeconds } : {})
  };
}

function playingEvent(observation: PlaybackObservation): PlaybackStateEvent {
  return {
    type: "PLAYING",
    ...(observation.positionSeconds !== undefined
      ? { positionSeconds: observation.positionSeconds }
      : {}),
    ...(observation.durationSeconds !== undefined
      ? { durationSeconds: observation.durationSeconds }
      : {}),
    ...(observation.fullscreen !== undefined ? { fullscreen: observation.fullscreen } : {})
  };
}

function canApplyCommand(command: PlaybackCommand["type"], phase: PlaybackState["phase"]): boolean {
  switch (command) {
    case "pause":
      return phase === "playing" || phase === "buffering";
    case "resume":
      return phase === "paused";
    case "restart":
      return ["playing", "paused", "buffering"].includes(phase);
    case "skip":
    case "stop":
      return !["idle", "failed"].includes(phase);
    default:
      return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
