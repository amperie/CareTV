import { FakeStreamingAdapter } from "@caretv/adapters";
import type { AdapterContext, PlaybackObservation, StreamingAdapter } from "@caretv/adapters";
import { loadConfig } from "@caretv/config";
import type { MediaItem, PlaybackCommand, PlaybackState, QueueEntry } from "@caretv/core";
import { createIdleState, transition } from "@caretv/state-machine";
import type { PlaybackStateEvent } from "@caretv/state-machine";

const config = loadConfig();
const adapter = new FakeStreamingAdapter();
let state: PlaybackState = createIdleState();
let nextHeartbeatAt = 0;
let backgroundHeartbeatInFlight = false;

async function main(): Promise<void> {
  console.log(
    JSON.stringify({
      applianceId: config.values.applianceId,
      name: config.values.applianceName,
      serverUrl: config.values.serverUrl,
      pollMs: config.values.appliancePollMs,
      heartbeatMs: config.values.applianceHeartbeatMs,
      playbackObserveMs: config.values.appliancePlaybackObserveMs,
      requestTimeoutMs: config.values.applianceRequestTimeoutMs
    })
  );

  startBackgroundHeartbeat();

  for (;;) {
    try {
      const playback = await pollPlaybackSettings();

      if (!playback) {
        await sleep(config.values.appliancePollMs);
        continue;
      }

      if (!playback.enabled) {
        await sleep(config.values.appliancePollMs);
        continue;
      }

      const queueEntry = await client.claimNextQueueEntry();

      if (!queueEntry) {
        await sleep(config.values.appliancePollMs);
        continue;
      }

      await play(queueEntry, playback.loopEnabled);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Appliance loop error; retrying.",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );
      await sleep(config.values.appliancePollMs);
    }
  }
}

function startBackgroundHeartbeat(): void {
  setInterval(() => {
    void backgroundHeartbeat();
  }, config.values.applianceHeartbeatMs).unref();
  void backgroundHeartbeat();
}

async function backgroundHeartbeat(): Promise<void> {
  if (backgroundHeartbeatInFlight) {
    return;
  }

  backgroundHeartbeatInFlight = true;
  try {
    await heartbeat(true);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Background heartbeat failed.",
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  } finally {
    backgroundHeartbeatInFlight = false;
  }
}

async function pollPlaybackSettings(): Promise<
  { enabled: boolean; loopEnabled: boolean } | undefined
> {
  try {
    await heartbeat();
    return await client.playbackSettings();
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Server unavailable; retrying.",
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
    return undefined;
  }
}

async function play(queueEntry: QueueEntry, loopEnabled: boolean): Promise<void> {
  const mediaItem = await client.getMedia(queueEntry.mediaItemId);

  if (!adapter.supports(mediaItem)) {
    await fail(queueEntry.id, "adapter-not-found", `No adapter supports ${mediaItem.service}.`);
    return;
  }

  const context: AdapterContext = {
    logger: console,
    mediaItem,
    signal: new AbortController().signal,
    now: () => new Date()
  };

  try {
    await apply({
      type: "QUEUE_SELECTED",
      queueEntryId: queueEntry.id,
      mediaItemId: mediaItem.id,
      adapterId: adapter.id,
      title: mediaItem.title
    });
    await adapter.prepare(context);
    await apply({ type: "BROWSER_LAUNCHED" });
    await adapter.start(context);
    await adapter.enterFullscreen(context);
    await apply({ type: "READY" });

    const result = await monitor(queueEntry, mediaItem, adapter, context);

    if (result === "completed" && loopEnabled && mediaItem.repeatable) {
      await client.enqueue(mediaItem.id, queueEntry.priority);
    }
  } catch (error) {
    await fail(
      queueEntry.id,
      "agent-error",
      error instanceof Error ? error.message : "Unknown appliance error"
    );
  } finally {
    await adapter.cleanup(context);
    await heartbeat(true);
  }
}

async function monitor(
  queueEntry: QueueEntry,
  mediaItem: MediaItem,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<"completed" | "failed" | "skipped"> {
  for (let count = 0; count < 600; count += 1) {
    const commandResult = await applyCommands(queueEntry.id, streamingAdapter, context);

    if (commandResult) {
      return commandResult;
    }

    const observation = await streamingAdapter.observe(context);
    const result = await applyObservation(queueEntry.id, streamingAdapter, context, observation);
    await heartbeat(true);

    if (result) {
      return result;
    }

    await sleep(config.values.appliancePlaybackObserveMs);
  }

  await fail(queueEntry.id, "observation-limit", `Playback did not finish: ${mediaItem.title}`);
  return "failed";
}

async function applyCommands(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<"skipped" | undefined> {
  for (const command of await client.pendingCommands()) {
    if (command.mediaItemId && command.mediaItemId !== context.mediaItem.id) {
      continue;
    }

    if (!canApplyCommand(command, state.phase)) {
      await client.updateCommand(command.id, "failed");
      continue;
    }

    switch (command.type) {
      case "pause":
        await streamingAdapter.pause(context);
        await apply({ type: "PAUSED" });
        await client.updateQueueStatus(queueEntryId, "paused");
        await client.updateCommand(command.id, "accepted");
        break;
      case "resume":
        await streamingAdapter.resume(context);
        await apply({ type: "RESUMED" });
        await client.updateQueueStatus(queueEntryId, "playing");
        await client.updateCommand(command.id, "accepted");
        break;
      case "skip":
      case "stop":
        await streamingAdapter.stop(context);
        await apply({ type: "STOPPED" });
        await client.updateQueueStatus(queueEntryId, "skipped", {
          completedAt: new Date().toISOString()
        });
        await client.updateCommand(command.id, "completed");
        return "skipped";
    }
  }

  return undefined;
}

async function applyObservation(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext,
  observation: PlaybackObservation
): Promise<"completed" | "failed" | undefined> {
  switch (observation.status) {
    case "ready":
    case "unknown":
      await apply(positionEvent("HEARTBEAT", observation.positionSeconds));
      return undefined;
    case "playing":
      await client.updateQueueStatus(queueEntryId, "playing");
      await apply({
        type: "PLAYING",
        ...(observation.positionSeconds !== undefined
          ? { positionSeconds: observation.positionSeconds }
          : {}),
        ...(observation.durationSeconds !== undefined
          ? { durationSeconds: observation.durationSeconds }
          : {}),
        ...(observation.fullscreen !== undefined ? { fullscreen: observation.fullscreen } : {})
      });
      return undefined;
    case "paused":
      await client.updateQueueStatus(queueEntryId, "paused");
      await apply(positionEvent("PAUSED", observation.positionSeconds));
      return undefined;
    case "buffering":
      await apply({ type: "BUFFERING" });
      return undefined;
    case "blocked":
      if (await streamingAdapter.dismissKnownInterruptions(context)) {
        await apply({ type: "RECOVERING", attempt: state.recoveryAttempt + 1 });
        return undefined;
      }
      await fail(
        queueEntryId,
        observation.errorCode ?? "blocked",
        observation.dialog ?? "Playback blocked."
      );
      return "failed";
    case "error":
      await fail(
        queueEntryId,
        observation.errorCode ?? "adapter-error",
        "Adapter reported playback error."
      );
      return "failed";
    case "completed":
      await client.updateQueueStatus(queueEntryId, "completed", {
        completedAt: new Date().toISOString()
      });
      await apply(positionEvent("COMPLETED", observation.positionSeconds));
      return "completed";
  }
}

async function fail(queueEntryId: string, code: string, message: string): Promise<void> {
  await client.updateQueueStatus(queueEntryId, "failed", {
    completedAt: new Date().toISOString(),
    lastErrorCode: code,
    lastErrorMessage: message
  });

  if (state.phase !== "idle") {
    await apply({ type: "FAILED", code, message });
  }
}

async function apply(event: PlaybackStateEvent): Promise<void> {
  const result = transition(state, event, {
    createId: () => crypto.randomUUID(),
    now: () => new Date()
  });
  state = result.state;
  await client.appendEvent(result.event);
}

function canApplyCommand(command: PlaybackCommand, phase: PlaybackState["phase"]): boolean {
  switch (command.type) {
    case "pause":
      return phase === "playing" || phase === "buffering";
    case "resume":
      return phase === "paused";
    case "skip":
    case "stop":
      return !["idle", "failed"].includes(phase);
    default:
      return false;
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function heartbeat(force = false): Promise<void> {
  const now = Date.now();

  if (!force && now < nextHeartbeatAt) {
    return;
  }

  await client.heartbeat(config.values.applianceId, config.values.applianceName, state);
  nextHeartbeatAt = now + config.values.applianceHeartbeatMs;
}

class ServerClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly requestTimeoutMs: number
  ) {}

  public heartbeat(applianceId: string, name: string, playbackState: PlaybackState) {
    return this.post<{ playback: { enabled: boolean; loopEnabled: boolean } }>(
      "/api/v1/appliance/heartbeat",
      {
        applianceId,
        name,
        state: playbackState
      }
    );
  }

  public playbackSettings() {
    return this.get<{ enabled: boolean; loopEnabled: boolean }>("/api/v1/appliance/playback");
  }

  public claimNextQueueEntry() {
    return this.post<QueueEntry | undefined>("/api/v1/appliance/queue/next", {});
  }

  public getMedia(id: string) {
    return this.get<MediaItem>(`/api/v1/appliance/media/${id}`);
  }

  public enqueue(mediaItemId: string, priority: number) {
    return this.post<QueueEntry>("/api/v1/appliance/queue", { mediaItemId, priority });
  }

  public pendingCommands() {
    return this.get<PlaybackCommand[]>("/api/v1/appliance/commands");
  }

  public updateCommand(id: string, status: PlaybackCommand["status"]) {
    return this.post(`/api/v1/appliance/commands/${id}/status`, { status });
  }

  public updateQueueStatus(
    id: string,
    status: QueueEntry["status"],
    fields: Record<string, unknown> = {}
  ) {
    return this.post(`/api/v1/appliance/queue/${id}/status`, { status, ...fields });
  }

  public appendEvent(event: {
    id: string;
    type: string;
    queueEntryId?: string;
    mediaItemId?: string;
    details: Record<string, unknown>;
    createdAt: string;
  }) {
    return this.post("/api/v1/appliance/events", event);
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        ...(body
          ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
          : {})
      });
    } catch (error) {
      throw new Error(
        `${method} ${path} failed: ${error instanceof Error ? error.message : "network error"}`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }
}

const client = new ServerClient(config.values.serverUrl, config.values.applianceRequestTimeoutMs);

void main();
