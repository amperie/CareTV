import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { access, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import {
  FakeStreamingAdapter,
  isBrowserPageClosedError,
  LocalFileAdapter,
  openLoginBrowser,
  PrimeVideoAdapter,
  YouTubeVideoAdapter
} from "@caretv/adapters";
import type { AdapterContext, PlaybackObservation, StreamingAdapter } from "@caretv/adapters";
import { loadConfig } from "@caretv/config";
import type { MediaItem, PlaybackCommand, PlaybackState, QueueEntry } from "@caretv/core";
import { createIdleState, transition } from "@caretv/state-machine";
import type { PlaybackStateEvent } from "@caretv/state-machine";

const config = loadConfig();
const adapters: StreamingAdapter[] = [
  new YouTubeVideoAdapter({ userDataDir: config.values.chromeProfileDir }),
  new PrimeVideoAdapter({ userDataDir: config.values.chromeProfileDir }),
  new LocalFileAdapter({ userDataDir: config.values.chromeProfileDir }),
  new FakeStreamingAdapter()
];
let state: PlaybackState = createIdleState();
let nextHeartbeatAt = 0;
let nextMediaScanAt = 0;
let backgroundHeartbeatInFlight = false;
let playbackInProgress = false;
const fullscreenCheckMs = 10_000;
let playbackSettings: PlaybackSettings = {
  enabled: false,
  fallbackEnabled: true,
  loopEnabled: false
};

interface PlaybackSettings {
  enabled: boolean;
  fallbackEnabled: boolean;
  loopEnabled: boolean;
}

interface PendingQueueReport {
  fields: Record<string, unknown>;
  status: QueueEntry["status"];
}

const pendingQueueReports = new Map<string, PendingQueueReport>();

async function main(): Promise<void> {
  console.log(
    JSON.stringify({
      applianceId: config.values.applianceId,
      name: config.values.applianceName,
      serverUrl: config.values.serverUrl,
      bufferingTimeoutMs: config.values.applianceBufferingTimeoutMs,
      pollMs: config.values.appliancePollMs,
      heartbeatMs: config.values.applianceHeartbeatMs,
      playbackObserveMs: config.values.appliancePlaybackObserveMs,
      requestTimeoutMs: config.values.applianceRequestTimeoutMs
    })
  );

  startBackgroundHeartbeat();

  for (;;) {
    try {
      await mediaMaintenance();
      await applyLoginCommands();
      const playback = await pollPlaybackSettings();

      if (!playback) {
        await sleep(config.values.appliancePollMs);
        continue;
      }

      await flushPendingQueueReports();

      if (!playback.enabled) {
        await sleep(config.values.appliancePollMs);
        continue;
      }

      if (!canSelectQueueEntry()) {
        await heartbeat(true);
        await sleep(config.values.appliancePollMs);
        continue;
      }

      const queueEntry = await client.claimNextQueueEntry();

      if (!queueEntry) {
        await client.completePlaybackRun();
        await sleep(config.values.appliancePollMs);
        continue;
      }

      await play(queueEntry);
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

async function applyLoginCommands(): Promise<void> {
  for (const command of await client.pendingCommands()) {
    if (command.type !== "login-youtube" && command.type !== "login-prime") {
      continue;
    }

    await client.updateCommand(command.id, "accepted");
    try {
      await openLoginBrowser(command.type === "login-youtube" ? "youtube" : "prime", {
        userDataDir: config.values.chromeProfileDir
      });
      await client.updateCommand(command.id, "completed");
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Login browser launch failed.",
          command: command.type,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );
      await client.updateCommand(command.id, "failed");
    }
  }
}

function startBackgroundHeartbeat(): void {
  setInterval(() => {
    void backgroundHeartbeat();
  }, config.values.applianceHeartbeatMs).unref();
  void backgroundHeartbeat();
}

async function mediaMaintenance(): Promise<void> {
  await processDeletions();
  await processDownloads();

  if (Date.now() < nextMediaScanAt) {
    return;
  }

  await syncMediaInventory();
  nextMediaScanAt = Date.now() + config.values.applianceMediaScanMs;
}

async function processDeletions(): Promise<void> {
  for (const deletion of await client.pendingDeletions()) {
    try {
      if (!isInsideMediaDir(deletion.localPath)) {
        throw new Error("Refusing to delete a path outside the appliance media directory.");
      }

      try {
        await unlink(deletion.localPath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }

      await client.completeDeletion(deletion.id);
      nextMediaScanAt = 0;
    } catch (error) {
      await client.failDeletion(
        deletion.id,
        error instanceof Error ? error.message : "Deletion failed."
      );
    }
  }
}

async function syncMediaInventory(): Promise<void> {
  const files = await scanMediaFiles(config.values.applianceMediaDir);
  await client.syncMediaInventory(config.values.applianceId, files);
}

async function processDownloads(): Promise<void> {
  await mkdir(config.values.applianceMediaDir, { recursive: true });

  for (const download of await client.pendingDownloads()) {
    const localPath = await uniqueLocalPath(config.values.applianceMediaDir, download.filename);
    const tempPath = `${localPath}.part`;

    try {
      await removeFileIfExists(tempPath);
      await client.downloadFile(download.url, tempPath);
      await rename(tempPath, localPath);
      await client.completeDownload(download.id, localPath);
      nextMediaScanAt = 0;
    } catch (error) {
      await removeFileIfExists(tempPath);
      await client.failDownload(
        download.id,
        error instanceof Error ? error.message : "Download failed."
      );
    }
  }
}

async function backgroundHeartbeat(): Promise<void> {
  if (backgroundHeartbeatInFlight || playbackInProgress) {
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

async function pollPlaybackSettings(): Promise<PlaybackSettings | undefined> {
  try {
    await heartbeat();
    playbackSettings = await client.playbackSettings();
    return playbackSettings;
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

async function play(queueEntry: QueueEntry): Promise<void> {
  playbackInProgress = true;
  const mediaItem = await client.getMedia(queueEntry.mediaItemId);

  const adapter = adapters.find((candidate) => candidate.supports(mediaItem));

  if (!adapter) {
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
    if (!canSelectQueueEntry()) {
      await apply({ type: "STOPPED" });
    }

    await apply({
      type: "QUEUE_SELECTED",
      queueEntryId: queueEntry.id,
      mediaItemId: mediaItem.id,
      adapterId: adapter.id,
      title: mediaItem.title
    });
    if (!(await startWithRecovery(queueEntry.id, adapter, context))) {
      return;
    }

    await monitor(queueEntry, mediaItem, adapter, context);
  } catch (error) {
    if (isBrowserPageClosedError(error)) {
      if (await recoverClosedPage(queueEntry.id, adapter, context)) {
        await monitor(queueEntry, mediaItem, adapter, context);
      }
      return;
    }

    await fail(
      queueEntry.id,
      "agent-error",
      error instanceof Error ? error.message : "Unknown appliance error"
    );
  } finally {
    try {
      await adapter.cleanup(context);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Adapter cleanup failed.",
          adapterId: adapter.id,
          mediaItemId: mediaItem.id,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );
    } finally {
      playbackInProgress = false;
      await heartbeat(true);
    }
  }
}

async function startWithRecovery(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<boolean> {
  try {
    await startPlayback(streamingAdapter, context);
    return true;
  } catch (error) {
    if (!isBrowserPageClosedError(error)) {
      throw error;
    }

    return recoverClosedPage(queueEntryId, streamingAdapter, context);
  }
}

async function startPlayback(
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<void> {
  await streamingAdapter.prepare(context);
  await apply({ type: "BROWSER_LAUNCHED" });
  await streamingAdapter.start(context);
  await streamingAdapter.enterFullscreen(context);
  await streamingAdapter.resume(context);
  await streamingAdapter.enterFullscreen(context);
  await apply({ type: "READY" });
}

async function monitor(
  queueEntry: QueueEntry,
  mediaItem: MediaItem,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<"completed" | "failed" | "skipped"> {
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastPositionSeconds = 0;
  let maxRuntimeMs = maxRuntimeMsFor(mediaItem);
  let bufferingSince: number | undefined;
  let nextFullscreenCheckAt = 0;

  for (;;) {
    const now = Date.now();

    if (now - startedAt > maxRuntimeMs && now - lastProgressAt > staleProgressLimitMs()) {
      await fail(queueEntry.id, "observation-limit", `Playback did not finish: ${mediaItem.title}`);
      return "failed";
    }

    const commandResult = await applyCommands(queueEntry.id, streamingAdapter, context);

    if (commandResult) {
      return commandResult;
    }

    const observation = await observeWithRecovery(queueEntry.id, streamingAdapter, context);

    if (!observation) {
      return "failed";
    }

    maxRuntimeMs = Math.max(maxRuntimeMs, maxRuntimeMsForObservation(observation));
    if (isPlaybackProgress(observation, lastPositionSeconds)) {
      lastPositionSeconds = observation.positionSeconds!;
      lastProgressAt = now;
    }
    await syncObservedDuration(mediaItem, observation);
    nextFullscreenCheckAt = await maintainFullscreen(
      streamingAdapter,
      context,
      observation,
      now,
      nextFullscreenCheckAt
    );

    if (observation.status === "buffering") {
      bufferingSince ??= now;

      if (now - bufferingSince >= config.values.applianceBufferingTimeoutMs) {
        await fail(
          queueEntry.id,
          `${streamingAdapter.id}-buffering-timeout`,
          `Playback buffered for more than ${Math.round(config.values.applianceBufferingTimeoutMs / 1000)} seconds.`
        );
        return "failed";
      }
    } else {
      bufferingSince = undefined;
    }

    const result = await applyObservation(queueEntry.id, streamingAdapter, context, observation);
    await heartbeat(true);

    if (result) {
      return result;
    }

    await sleep(config.values.appliancePlaybackObserveMs);
  }
}

async function observeWithRecovery(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<PlaybackObservation | undefined> {
  try {
    return await streamingAdapter.observe(context);
  } catch (error) {
    if (!isBrowserPageClosedError(error)) {
      throw error;
    }

    return (await recoverClosedPage(queueEntryId, streamingAdapter, context))
      ? { status: "ready", positionSeconds: state.positionSeconds ?? 0 }
      : undefined;
  }
}

async function recoverClosedPage(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<boolean> {
  const attempt = state.recoveryAttempt + 1;

  if (state.phase === "launching-browser") {
    await apply({ type: "BROWSER_LAUNCHED" });
  }

  try {
    await apply({ type: "RECOVERING", attempt });
    const recovery = await streamingAdapter.recover(context, attempt);

    if (!recovery.recovered) {
      await fail(queueEntryId, "browser-recovery-failed", recovery.message);
      return false;
    }

    await apply({ type: "PLAYING", positionSeconds: state.positionSeconds ?? 0 });
    return true;
  } catch (error) {
    await fail(
      queueEntryId,
      "browser-recovery-failed",
      error instanceof Error ? error.message : "Browser recovery failed."
    );
    return false;
  }
}

async function applyCommands(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<"skipped" | undefined> {
  let commands: PlaybackCommand[];
  try {
    commands = await client.pendingCommands();
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Command polling failed; continuing playback.",
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
    return undefined;
  }

  for (const command of commands) {
    if (command.type === "login-youtube" || command.type === "login-prime") {
      continue;
    }

    if (command.mediaItemId && command.mediaItemId !== context.mediaItem.id) {
      await reportCommandStatus(command.id, "failed");
      continue;
    }

    if (!canApplyCommand(command, state.phase)) {
      await reportCommandStatus(command.id, "failed");
      continue;
    }

    switch (command.type) {
      case "pause":
        await streamingAdapter.pause(context);
        await apply({ type: "PAUSED" });
        await reportQueueStatus(queueEntryId, "paused");
        await reportCommandStatus(command.id, "accepted");
        break;
      case "resume":
        await streamingAdapter.resume(context);
        await apply({ type: "RESUMED" });
        await reportQueueStatus(queueEntryId, "playing");
        await reportCommandStatus(command.id, "accepted");
        break;
      case "restart":
        await streamingAdapter.restart(context);
        if (state.phase === "paused") {
          await apply({ type: "RESUMED" });
        }
        await apply({ type: "PLAYING", positionSeconds: 0 });
        await reportQueueStatus(queueEntryId, "playing");
        await reportCommandStatus(command.id, "accepted");
        break;
      case "skip":
      case "stop":
        await streamingAdapter.stop(context);
        await apply({ type: "STOPPED" });
        await reportQueueStatus(queueEntryId, "skipped", {
          completedAt: new Date().toISOString()
        });
        await reportCommandStatus(command.id, "completed");
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
      await reportQueueStatus(queueEntryId, "playing");
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
      if (state.phase !== "paused") {
        await streamingAdapter.resume(context);
        await apply(positionEvent("HEARTBEAT", observation.positionSeconds));
        return undefined;
      }

      await reportQueueStatus(queueEntryId, "paused");
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
      if (playbackSettings.fallbackEnabled && shouldQueueYouTubeFallback(observation.errorCode)) {
        await client.queueYouTubeFallback().catch((error) =>
          console.warn(
            JSON.stringify({
              level: "warn",
              message: "YouTube fallback queue failed.",
              error: error instanceof Error ? error.message : "Unknown error"
            })
          )
        );
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
      await reportQueueStatus(queueEntryId, "completed", {
        completedAt: new Date().toISOString()
      });
      await apply(positionEvent("COMPLETED", observation.positionSeconds));
      return "completed";
  }
}

async function reportQueueStatus(
  queueEntryId: string,
  status: QueueEntry["status"],
  fields: Record<string, unknown> = {}
): Promise<boolean> {
  return client
    .updateQueueStatus(queueEntryId, status, fields)
    .then(() => true)
    .catch((error) => {
      if (isConflictResponseError(error)) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "Queue status update conflicted; dropping report.",
            queueEntryId,
            status,
            error: error instanceof Error ? error.message : "Unknown error"
          })
        );
        return false;
      }

      pendingQueueReports.set(queueEntryId, { fields, status });
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Queue status update failed.",
          queueEntryId,
          status,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );
      return false;
    });
}

async function flushPendingQueueReports(): Promise<void> {
  for (const [queueEntryId, report] of pendingQueueReports) {
    try {
      await client.updateQueueStatus(queueEntryId, report.status, report.fields);
      pendingQueueReports.delete(queueEntryId);
    } catch (error) {
      if (isConflictResponseError(error)) {
        pendingQueueReports.delete(queueEntryId);
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "Pending queue status update conflicted; dropping report.",
            queueEntryId,
            status: report.status,
            error: error instanceof Error ? error.message : "Unknown error"
          })
        );
        continue;
      }

      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Pending queue status update failed.",
          queueEntryId,
          status: report.status,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );
      return;
    }
  }
}

function isConflictResponseError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(" failed with 409");
}

async function reportCommandStatus(
  commandId: string,
  status: PlaybackCommand["status"]
): Promise<void> {
  try {
    await client.updateCommand(commandId, status);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Command status update failed.",
        commandId,
        status,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  }
}

async function fail(queueEntryId: string, code: string, message: string): Promise<void> {
  const updated = await reportQueueStatus(queueEntryId, "failed", {
    completedAt: new Date().toISOString(),
    lastErrorCode: code,
    lastErrorMessage: message
  });

  if (updated !== false && state.phase !== "idle") {
    await apply({ type: "FAILED", code, message });
  }
}

async function syncObservedDuration(
  mediaItem: MediaItem,
  observation: PlaybackObservation
): Promise<void> {
  const durationSeconds = observation.durationSeconds;

  if (
    observation.details?.durationObserved !== true ||
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    Math.floor(durationSeconds) === mediaItem.expectedDurationSeconds
  ) {
    return;
  }

  const observedDurationSeconds = Math.max(1, Math.floor(durationSeconds));
  await client.updateMediaDuration(mediaItem.id, observedDurationSeconds).catch((error) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Observed media duration update failed.",
        mediaItemId: mediaItem.id,
        durationSeconds: observedDurationSeconds,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    )
  );
  mediaItem.expectedDurationSeconds = observedDurationSeconds;
}

async function apply(event: PlaybackStateEvent): Promise<void> {
  const result = transition(state, event, {
    createId: () => crypto.randomUUID(),
    now: () => new Date()
  });
  state = result.state;
  await client.appendEvent(result.event).catch((error) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Playback event reporting failed.",
        error: error instanceof Error ? error.message : "Unknown error"
      })
    )
  );
}

function canApplyCommand(command: PlaybackCommand, phase: PlaybackState["phase"]): boolean {
  switch (command.type) {
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

function canSelectQueueEntry(): boolean {
  return state.phase === "idle" || state.phase === "failed";
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

function maxRuntimeMsFor(mediaItem: MediaItem): number {
  const expectedDurationSeconds =
    typeof mediaItem.metadata.durationSeconds === "number" &&
    Number.isFinite(mediaItem.metadata.durationSeconds)
      ? mediaItem.metadata.durationSeconds
      : mediaItem.expectedDurationSeconds;
  const expectedMs = (expectedDurationSeconds ?? 6 * 60 * 60) * 1000;
  return Math.max(60 * 60 * 1000, expectedMs + 30 * 60 * 1000);
}

function maxRuntimeMsForObservation(observation: PlaybackObservation): number {
  const durationSeconds = observation.durationSeconds;

  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return 0;
  }

  return Math.max(60 * 60 * 1000, durationSeconds * 1000 + 30 * 60 * 1000);
}

function isPlaybackProgress(
  observation: PlaybackObservation,
  lastPositionSeconds: number
): boolean {
  return (
    observation.status === "playing" &&
    typeof observation.positionSeconds === "number" &&
    Number.isFinite(observation.positionSeconds) &&
    observation.positionSeconds > lastPositionSeconds + 5
  );
}

function staleProgressLimitMs(): number {
  return Math.max(10 * 60 * 1000, config.values.applianceBufferingTimeoutMs * 2);
}

async function maintainFullscreen(
  streamingAdapter: StreamingAdapter,
  context: AdapterContext,
  observation: PlaybackObservation,
  now: number,
  nextFullscreenCheckAt: number
): Promise<number> {
  if (!["playing", "buffering"].includes(observation.status) || now < nextFullscreenCheckAt) {
    return nextFullscreenCheckAt;
  }

  await streamingAdapter.enterFullscreen(context).catch((error) =>
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Fullscreen restore failed.",
        adapterId: streamingAdapter.id,
        mediaItemId: context.mediaItem.id,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    )
  );
  return now + fullscreenCheckMs;
}

async function heartbeat(force = false): Promise<void> {
  const now = Date.now();

  if (!force && now < nextHeartbeatAt) {
    return;
  }

  await client
    .heartbeat(config.values.applianceId, config.values.applianceName, state)
    .catch((error) =>
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Appliance heartbeat failed.",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      )
    );
  nextHeartbeatAt = now + config.values.applianceHeartbeatMs;
}

class ServerClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly requestTimeoutMs: number
  ) {}

  public heartbeat(applianceId: string, name: string, playbackState: PlaybackState) {
    return this.post<{ playback: PlaybackSettings }>("/api/v1/appliance/heartbeat", {
      applianceId,
      name,
      state: playbackState
    });
  }

  public playbackSettings() {
    return this.get<PlaybackSettings>("/api/v1/appliance/playback");
  }

  public syncMediaInventory(applianceId: string, items: LocalMediaInventoryItem[]) {
    return this.post("/api/v1/appliance/media-inventory", { applianceId, items });
  }

  public pendingDownloads() {
    return this.get<PendingDownload[]>("/api/v1/appliance/downloads");
  }

  public pendingDeletions() {
    return this.get<PendingDeletion[]>("/api/v1/appliance/media-deletions");
  }

  public completeDeletion(id: string) {
    return this.post(`/api/v1/appliance/media-deletions/${id}/complete`, {});
  }

  public failDeletion(id: string, message: string) {
    return this.post(`/api/v1/appliance/media-deletions/${id}/fail`, { message });
  }

  public completeDownload(id: string, localPath: string) {
    return this.post(`/api/v1/appliance/downloads/${id}/complete`, { localPath });
  }

  public failDownload(id: string, message: string) {
    return this.post(`/api/v1/appliance/downloads/${id}/fail`, { message });
  }

  public async downloadFile(path: string, destinationPath: string): Promise<void> {
    const response = await this.fetch("GET", path);

    if (!response.ok) {
      throw new Error(`GET ${path} failed with ${response.status}`);
    }

    if (!response.body) {
      throw new Error(`GET ${path} did not return a body`);
    }

    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(destinationPath, { flags: "wx" })
    );

    const expectedBytes = Number(response.headers.get("content-length"));

    if (Number.isFinite(expectedBytes)) {
      const file = await stat(destinationPath);

      if (file.size !== expectedBytes) {
        throw new Error(`Downloaded ${file.size} bytes; expected ${expectedBytes}.`);
      }
    }
  }

  public claimNextQueueEntry() {
    return this.post<QueueEntry | null>("/api/v1/appliance/queue/next", {});
  }

  public getMedia(id: string) {
    return this.get<MediaItem>(`/api/v1/appliance/media/${id}`);
  }

  public completePlaybackRun() {
    return this.post<{ enabled: boolean; loopEnabled: boolean }>(
      "/api/v1/appliance/playback/complete-run",
      {}
    );
  }

  public queueYouTubeFallback() {
    return this.post<{ entries: QueueEntry[]; skipped?: string }>(
      "/api/v1/appliance/fallback/youtube",
      {}
    );
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

  public updateMediaDuration(id: string, durationSeconds: number) {
    return this.post(`/api/v1/appliance/media/${id}/duration`, { durationSeconds });
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
    const response = await this.fetch(method, path, body);

    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}`);
    }

    return (await response.json()) as T;
  }

  private async fetch(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>
  ): Promise<Response> {
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

    return response;
  }
}

const client = new ServerClient(config.values.serverUrl, config.values.applianceRequestTimeoutMs);

void main();

function shouldQueueYouTubeFallback(code: string | undefined): boolean {
  return Boolean(
    code &&
    [
      "youtube-signin-required",
      "youtube-age-verification-required",
      "youtube-verification-required",
      "youtube-consent-required"
    ].includes(code)
  );
}

interface LocalMediaInventoryItem {
  localPath: string;
  title: string;
  sizeBytes: number;
  modifiedAt: string;
}

interface PendingDownload {
  id: string;
  mediaItemId: string;
  filename: string;
  url: string;
}

interface PendingDeletion {
  id: string;
  localPath: string;
}

async function scanMediaFiles(root: string): Promise<LocalMediaInventoryItem[]> {
  await mkdir(root, { recursive: true });
  const results: LocalMediaInventoryItem[] = [];
  await scanDirectory(root, results);
  return results;
}

async function scanDirectory(directory: string, results: LocalMediaInventoryItem[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const localPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      await scanDirectory(localPath, results);
      continue;
    }

    if (!entry.isFile() || !isSupportedMediaPath(localPath)) {
      continue;
    }

    const fileStat = await stat(localPath);
    results.push({
      localPath,
      title: titleFromFilename(entry.name),
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString()
    });
  }
}

function isSupportedMediaPath(localPath: string): boolean {
  return [".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi"].includes(
    extname(localPath).toLowerCase()
  );
}

function safeFilename(input: string): string {
  return (
    basename(input)
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .trim() || "upload.bin"
  );
}

async function uniqueLocalPath(directory: string, filename: string): Promise<string> {
  const safe = safeFilename(filename);
  const extension = extname(safe);
  const stem = basename(safe, extension);

  for (let index = 0; index < 1000; index += 1) {
    const candidate =
      index === 0 ? join(directory, safe) : join(directory, `${stem} (${index + 1})${extension}`);

    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }

  return join(directory, `${crypto.randomUUID()}-${safe}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function titleFromFilename(input: string): string {
  return basename(input, extname(input)).replace(/[_-]+/g, " ").trim() || "Untitled media";
}

function isInsideMediaDir(localPath: string): boolean {
  const mediaDir = resolve(config.values.applianceMediaDir);
  const target = resolve(localPath);
  const pathFromMediaDir = relative(mediaDir, target);
  return (
    Boolean(pathFromMediaDir) && !pathFromMediaDir.startsWith("..") && !isAbsolute(pathFromMediaDir)
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
