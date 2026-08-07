import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { access, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import {
  FakeStreamingAdapter,
  isRecoverableBrowserPageError,
  LocalFileAdapter,
  openLoginBrowser,
  PrimeVideoAdapter,
  YouTubeVideoAdapter
} from "@caretv/adapters";
import type { AdapterContext, PlaybackObservation, StreamingAdapter } from "@caretv/adapters";
import { loadConfig } from "@caretv/config";
import type {
  MediaItem,
  PlaybackCommand,
  PlaybackEvent,
  PlaybackState,
  QueueEntry
} from "@caretv/core";
import { createIdleState, transition } from "@caretv/state-machine";
import type { PlaybackStateEvent } from "@caretv/state-machine";

const config = loadConfig();
const releaseApplianceLock = acquireApplianceLock();
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
let internetUnavailableUntil = 0;
const fullscreenCheckMs = 10_000;
const internetRetryMs = 5 * 60_000;
const serverRetryMs = 5_000;
let playbackSettings: PlaybackSettings = {
  enabled: true,
  fallbackEnabled: true,
  loopEnabled: true
};
installTimestampedConsole();

interface PlaybackSettings {
  enabled: boolean;
  fallbackEnabled: boolean;
  loopEnabled: boolean;
}

interface PendingQueueReport {
  fields: Record<string, unknown>;
  status: QueueEntry["status"];
}

interface DurableOutbox {
  events?: PlaybackEvent[];
  queueReports?: Record<string, PendingQueueReport>;
}

interface OfflineQueueSnapshot {
  syncedAt: string;
  playback: PlaybackSettings;
  queue: QueueEntry[];
  media: Record<string, MediaItem>;
}

const durableOutboxPath = join(
  config.values.runtimeDir,
  `${config.values.applianceId}-outbox.json`
);
const offlineQueuePath = join(
  config.values.runtimeDir,
  `${config.values.applianceId}-offline-queue.json`
);
const maxPendingPlaybackEvents = 500;
const pendingQueueReports = new Map<string, PendingQueueReport>();
const pendingPlaybackEvents: PlaybackEvent[] = [];
let offlineQueueSnapshot: OfflineQueueSnapshot | undefined;

async function main(): Promise<void> {
  loadDurableOutbox();
  loadOfflineQueueSnapshot();
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
      if (!(await runControlPlaneTask("Media maintenance", mediaMaintenance))) {
        await playOfflineQueueEntry();
        await sleep(Math.max(config.values.appliancePollMs, serverRetryMs));
        continue;
      }

      if (!(await runControlPlaneTask("Login command polling", applyLoginCommands))) {
        await playOfflineQueueEntry();
        await sleep(Math.max(config.values.appliancePollMs, serverRetryMs));
        continue;
      }

      const playback = await pollPlaybackSettings();

      if (!playback) {
        await playOfflineQueueEntry();
        await sleep(Math.max(config.values.appliancePollMs, serverRetryMs));
        continue;
      }

      await flushPendingQueueReports();
      await flushPendingPlaybackEvents();
      await syncOfflineQueueSnapshot(playback);

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

async function runControlPlaneTask(name: string, task: () => Promise<void>): Promise<boolean> {
  try {
    await task();
    return true;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: `${name} failed; server unavailable or control-plane request failed.`,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
    return false;
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

async function play(queueEntry: QueueEntry, offlineMediaItem?: MediaItem): Promise<void> {
  playbackInProgress = true;
  let mediaItem: MediaItem | undefined = offlineMediaItem;

  if (!mediaItem) {
    try {
      mediaItem = await getQueueMedia(queueEntry);
    } catch (error) {
      playbackInProgress = false;
      throw error;
    }
  }

  if (!mediaItem) {
    playbackInProgress = false;
    return;
  }

  const adapter = adapters.find((candidate) => candidate.supports(mediaItem));

  if (!adapter) {
    await fail(queueEntry.id, "adapter-not-found", `No adapter supports ${mediaItem.service}.`);
    return;
  }

  if (await shouldDeferForInternetOutage(mediaItem)) {
    await deferQueueEntry(
      queueEntry.id,
      "internet-unavailable",
      "Public internet is unavailable; deferring streaming playback."
    );
    playbackInProgress = false;
    await sleep(Math.min(internetRetryMs, Math.max(config.values.appliancePollMs, 30_000)));
    return;
  }

  const controller = new AbortController();
  const context: AdapterContext = {
    logger: console,
    mediaItem,
    signal: controller.signal,
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
    if (isRecoverableBrowserPageError(error)) {
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
    controller.abort();
    try {
      await withTimeout(
        adapter.cleanup(context),
        config.values.applianceRequestTimeoutMs,
        "adapter-cleanup-timeout"
      );
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

async function getQueueMedia(queueEntry: QueueEntry): Promise<MediaItem | undefined> {
  try {
    return await client.getMedia(queueEntry.mediaItemId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Media lookup failed.";

    if (message.includes(" failed with 404")) {
      await fail(
        queueEntry.id,
        "media-not-found",
        `Media item ${queueEntry.mediaItemId} was not found.`
      );
      return undefined;
    }

    throw error;
  }
}

async function syncOfflineQueueSnapshot(playback: PlaybackSettings): Promise<void> {
  try {
    const [queueEntries, mediaItems] = await Promise.all([client.playbackQueue(), client.media()]);
    offlineQueueSnapshot = {
      syncedAt: new Date().toISOString(),
      playback,
      queue: queueEntries,
      media: Object.fromEntries(mediaItems.map((item) => [item.id, item]))
    };
    persistOfflineQueueSnapshot();
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Offline queue snapshot sync failed.",
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  }
}

async function playOfflineQueueEntry(): Promise<boolean> {
  const selected = selectOfflineQueueEntry();

  if (!selected) {
    return false;
  }

  console.warn(
    JSON.stringify({
      level: "warn",
      message: "Server unavailable; playing from offline queue snapshot.",
      queueEntryId: selected.entry.id,
      mediaItemId: selected.mediaItem.id,
      snapshotSyncedAt: offlineQueueSnapshot?.syncedAt
    })
  );
  await play(selected.entry, selected.mediaItem);
  return true;
}

function selectOfflineQueueEntry(): { entry: QueueEntry; mediaItem: MediaItem } | undefined {
  if (!offlineQueueSnapshot?.playback.enabled || !canSelectQueueEntry()) {
    return undefined;
  }

  const queue = [...offlineQueueSnapshot.queue].sort((a, b) => a.position - b.position);

  for (const entry of queue) {
    if (effectiveQueueStatus(entry) !== "queued") {
      continue;
    }

    const mediaItem = offlineQueueSnapshot.media[entry.mediaItemId];

    if (!mediaItem || !mediaItem.enabled || !isOfflinePlayable(mediaItem)) {
      continue;
    }

    return {
      entry,
      mediaItem
    };
  }

  return undefined;
}

function effectiveQueueStatus(entry: QueueEntry): QueueEntry["status"] {
  return pendingQueueReports.get(entry.id)?.status ?? entry.status;
}

function updateOfflineQueueStatus(
  queueEntryId: string,
  status: QueueEntry["status"],
  fields: Record<string, unknown>
): void {
  if (!offlineQueueSnapshot) {
    return;
  }

  offlineQueueSnapshot = {
    ...offlineQueueSnapshot,
    queue: offlineQueueSnapshot.queue.map((entry) =>
      entry.id === queueEntryId
        ? {
            ...entry,
            status,
            ...(typeof fields.completedAt === "string" ? { completedAt: fields.completedAt } : {}),
            ...(typeof fields.lastErrorCode === "string"
              ? { lastErrorCode: fields.lastErrorCode }
              : {}),
            ...(typeof fields.lastErrorMessage === "string"
              ? { lastErrorMessage: fields.lastErrorMessage }
              : {})
          }
        : entry
    )
  };
  persistOfflineQueueSnapshot();
}

function isOfflinePlayable(mediaItem: MediaItem): boolean {
  if (mediaItem.service !== "local") {
    return true;
  }

  return Boolean(mediaItem.localPath && existsSync(mediaItem.localPath));
}

async function startWithRecovery(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<boolean> {
  try {
    return !(await startPlayback(queueEntryId, streamingAdapter, context));
  } catch (error) {
    if (isStartupBrowserControlTimeout(error)) {
      await fail(
        queueEntryId,
        `${streamingAdapter.id}-startup-control-timeout`,
        error instanceof Error ? error.message : "Browser control timed out during startup."
      );
      return false;
    }

    if (!isRecoverableBrowserPageError(error)) {
      throw error;
    }

    return recoverClosedPage(queueEntryId, streamingAdapter, context);
  }
}

async function startPlayback(
  queueEntryId: string,
  streamingAdapter: StreamingAdapter,
  context: AdapterContext
): Promise<"completed" | "failed" | undefined> {
  await streamingAdapter.prepare(context);
  await apply({ type: "BROWSER_LAUNCHED" });
  await streamingAdapter.start(context);
  const startupObservation = await streamingAdapter.observe(context);

  if (isTerminalStartupObservation(startupObservation)) {
    return applyObservation(queueEntryId, streamingAdapter, context, startupObservation);
  }

  await streamingAdapter.enterFullscreen(context);
  await streamingAdapter.resume(context);
  await streamingAdapter.enterFullscreen(context);
  await apply({ type: "READY" });
  return undefined;
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
    if (!isRecoverableBrowserPageError(error)) {
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

    const observation = await streamingAdapter.observe(context);

    if (isTerminalStartupObservation(observation)) {
      await applyObservation(queueEntryId, streamingAdapter, context, observation);
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
    .then(() => {
      updateOfflineQueueStatus(queueEntryId, status, fields);
      return true;
    })
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
      updateOfflineQueueStatus(queueEntryId, status, fields);
      persistDurableOutbox();
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

async function deferQueueEntry(queueEntryId: string, code: string, message: string): Promise<void> {
  pendingQueueReports.delete(queueEntryId);
  persistDurableOutbox();
  await reportQueueStatus(queueEntryId, "queued", {
    lastErrorCode: code,
    lastErrorMessage: message
  });
  if (state.phase !== "idle") {
    await apply({ type: "STOPPED" });
  }
}

async function flushPendingQueueReports(): Promise<void> {
  for (const [queueEntryId, report] of pendingQueueReports) {
    try {
      await client.updateQueueStatus(queueEntryId, report.status, report.fields);
      pendingQueueReports.delete(queueEntryId);
      persistDurableOutbox();
    } catch (error) {
      if (isConflictResponseError(error)) {
        pendingQueueReports.delete(queueEntryId);
        persistDurableOutbox();
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

async function flushPendingPlaybackEvents(): Promise<void> {
  while (pendingPlaybackEvents.length > 0) {
    const event = pendingPlaybackEvents[0]!;

    try {
      await client.appendEvent(event);
      pendingPlaybackEvents.shift();
      persistDurableOutbox();
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Pending playback event update failed.",
          eventId: event.id,
          type: event.type,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );
      return;
    }
  }
}

function queuePendingPlaybackEvent(event: PlaybackEvent): void {
  if (!isDurablePlaybackEvent(event)) {
    return;
  }

  pendingPlaybackEvents.push(event);
  if (pendingPlaybackEvents.length > maxPendingPlaybackEvents) {
    pendingPlaybackEvents.splice(0, pendingPlaybackEvents.length - maxPendingPlaybackEvents);
  }
  persistDurableOutbox();
}

function isDurablePlaybackEvent(event: PlaybackEvent): boolean {
  return event.type !== "HEARTBEAT" && event.type !== "PLAYING";
}

function loadDurableOutbox(): void {
  if (!existsSync(durableOutboxPath)) {
    return;
  }

  try {
    const outbox = JSON.parse(readFileSync(durableOutboxPath, "utf8")) as DurableOutbox;

    for (const [queueEntryId, report] of Object.entries(outbox.queueReports ?? {})) {
      pendingQueueReports.set(queueEntryId, report);
    }

    pendingPlaybackEvents.push(...(outbox.events ?? []).slice(-maxPendingPlaybackEvents));
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Durable appliance outbox could not be loaded.",
        path: durableOutboxPath,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  }
}

function persistDurableOutbox(): void {
  try {
    if (pendingQueueReports.size === 0 && pendingPlaybackEvents.length === 0) {
      if (existsSync(durableOutboxPath)) {
        unlinkSync(durableOutboxPath);
      }
      return;
    }

    writeFileSync(
      durableOutboxPath,
      JSON.stringify(
        {
          events: pendingPlaybackEvents,
          queueReports: Object.fromEntries(pendingQueueReports)
        } satisfies DurableOutbox,
        null,
        2
      )
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Durable appliance outbox could not be saved.",
        path: durableOutboxPath,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  }
}

function loadOfflineQueueSnapshot(): void {
  if (!existsSync(offlineQueuePath)) {
    return;
  }

  try {
    offlineQueueSnapshot = JSON.parse(
      readFileSync(offlineQueuePath, "utf8")
    ) as OfflineQueueSnapshot;
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Offline queue snapshot could not be loaded.",
        path: offlineQueuePath,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  }
}

function persistOfflineQueueSnapshot(): void {
  if (!offlineQueueSnapshot) {
    return;
  }

  try {
    writeFileSync(offlineQueuePath, JSON.stringify(offlineQueueSnapshot, null, 2));
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Offline queue snapshot could not be saved.",
        path: offlineQueuePath,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  }
}

function isConflictResponseError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(" failed with 409");
}

async function shouldDeferForInternetOutage(mediaItem: MediaItem): Promise<boolean> {
  if (!requiresPublicInternet(mediaItem)) {
    return false;
  }

  const now = Date.now();
  if (now < internetUnavailableUntil) {
    return true;
  }

  if (await publicInternetReachable()) {
    internetUnavailableUntil = 0;
    return false;
  }

  internetUnavailableUntil = now + internetRetryMs;
  console.warn(
    JSON.stringify({
      level: "warn",
      message: "Public internet unavailable; streaming playback deferred.",
      mediaItemId: mediaItem.id,
      title: mediaItem.title,
      retryAfterSeconds: Math.round(internetRetryMs / 1000)
    })
  );
  return true;
}

function requiresPublicInternet(mediaItem: MediaItem): boolean {
  return mediaItem.service === "youtube" || mediaItem.service === "prime";
}

async function publicInternetReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://www.youtube.com/generate_204", {
      cache: "no-store",
      signal: controller.signal
    });
    return response.ok || response.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
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
  await reportQueueStatus(queueEntryId, "failed", {
    completedAt: new Date().toISOString(),
    lastErrorCode: code,
    lastErrorMessage: message
  });

  if (state.phase !== "idle") {
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
  if (isRedundantBufferingEvent(result.event)) {
    return;
  }

  await client.appendEvent(result.event).catch((error) => {
    queuePendingPlaybackEvent(result.event);
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "Playback event reporting failed; queued for retry.",
        pendingEvents: pendingPlaybackEvents.length,
        error: error instanceof Error ? error.message : "Unknown error"
      })
    );
  });
}

function isRedundantBufferingEvent(event: PlaybackEvent): boolean {
  return (
    event.type === "BUFFERING" &&
    event.details?.from === "buffering" &&
    event.details?.to === "buffering"
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

function isTerminalStartupObservation(observation: PlaybackObservation): boolean {
  return (
    observation.status === "blocked" ||
    observation.status === "completed" ||
    observation.status === "error"
  );
}

function isStartupBrowserControlTimeout(error: unknown): boolean {
  return (
    state.phase === "loading" &&
    error instanceof Error &&
    error.message.includes("cdp-command-timeout: Runtime.evaluate")
  );
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

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
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

  public media() {
    return this.get<MediaItem[]>("/api/v1/media");
  }

  public playbackQueue() {
    return this.get<QueueEntry[]>("/api/v1/queue");
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

process.once("exit", releaseApplianceLock);
process.once("SIGINT", () => {
  releaseApplianceLock();
  process.exit(130);
});
process.once("SIGTERM", () => {
  releaseApplianceLock();
  process.exit(143);
});

function installTimestampedConsole(): void {
  for (const method of ["log", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (args.length === 1 && typeof args[0] === "string") {
        original(timestampLogLine(args[0]));
        return;
      }

      original(...args);
    };
  }
}

function timestampLogLine(line: string): string {
  const now = new Date();
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({
        time: now.toISOString(),
        timeLocal: readableLocalTime(now),
        ...(parsed as Record<string, unknown>)
      });
    }
  } catch {
    return `[${readableLocalTime(now)}] ${line}`;
  }

  return `[${readableLocalTime(now)}] ${line}`;
}

function readableLocalTime(now: Date): string {
  return now.toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    year: "numeric"
  });
}

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
  return extname(localPath).toLowerCase() === ".mp4";
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

function acquireApplianceLock(): () => void {
  const lockPath = join(config.values.runtimeDir, `${config.values.applianceId}.lock`);

  if (existsSync(lockPath)) {
    const pid = lockPid(lockPath);

    if (pid && pid !== process.pid && isProcessRunning(pid)) {
      throw new Error(
        `Appliance agent already running for ${config.values.applianceId} as PID ${pid}.`
      );
    }

    unlinkSync(lockPath);
  }

  const fd = openSync(lockPath, "wx");
  let released = false;
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort cleanup; stale locks are handled on the next startup.
    }
  };
}

function lockPid(lockPath: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
