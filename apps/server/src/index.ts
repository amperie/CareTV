import { createReadStream, createWriteStream } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import Fastify from "fastify";

import { loadConfig } from "@caretv/config";
import type {
  MediaItem,
  PlaybackEvent,
  PlaybackCommand,
  PlaybackCommandStatus,
  PlaybackCommandType,
  PlaybackState,
  QueueEntry,
  QueueEntryStatus
} from "@caretv/core";
import { createHealthStatus } from "@caretv/core";
import {
  ApplianceRepository,
  CommandRepository,
  MediaDeletionRepository,
  MediaDownloadRepository,
  MediaRepository,
  migrate,
  openDatabase,
  PlaybackEventRepository,
  PlaylistRepository,
  playlistItems,
  QueueRepository,
  SettingsRepository
} from "@caretv/database";

const config = loadConfig();
const db = openDatabase(join(config.values.runtimeDir, "caretv.sqlite"));
migrate(db);

const appliances = new ApplianceRepository(db);
const media = new MediaRepository(db);
const deletions = new MediaDeletionRepository(db);
const downloads = new MediaDownloadRepository(db);
const queue = new QueueRepository(db);
const commands = new CommandRepository(db);
const events = new PlaybackEventRepository(db);
const playlists = new PlaylistRepository(db);
const settings = new SettingsRepository(db);

const maxUploadBytes = 50 * 1024 * 1024 * 1024;
const app = Fastify({ bodyLimit: maxUploadBytes, logger: { level: "warn" } });
const uploadDir = join(config.values.runtimeDir, "uploads");
const youtubeFallbackSettingKey = "youtubeFallbackPlaylist";

await mkdir(uploadDir, { recursive: true });

app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
  done(null, payload);
});

app.addHook("onRequest", (request, reply, done) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "authorization,content-type,x-caretv-token");
  reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

  if (request.method === "OPTIONS") {
    reply.send();
    return;
  }

  if (!isAuthorized(request.url, request.headers)) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }

  done();
});

app.get("/health", () => createHealthStatus("server"));
app.get("/api/v1/media", () => media.list());
app.get("/api/v1/downloads", () => downloads.listPending());
app.get("/api/v1/playlists", () => playlists.list());
app.get("/api/v1/queue", () => {
  clearStaleStartingQueueEntries();
  recoverRunnableQueue();
  return queue.listPlaybackOrder();
});
app.get("/api/v1/appliances", () => appliances.list(new Date()));
app.get("/api/v1/playback/status", () => {
  clearStaleStartingQueueEntries();
  const playback = playbackSettings();
  recoverRunnableQueue(playback);
  const appliance = appliances.latest(new Date());
  return {
    appliance,
    events: events.listRecent(25),
    fallbackEnabled: playback.fallbackEnabled,
    loopEnabled: playback.loopEnabled,
    queue: queue.listPlaybackOrder(),
    remoteSupportUrl: config.values.remoteSupportUrl,
    running: playback.enabled,
    ...(appliance?.playbackState ? { state: appliance.playbackState } : {})
  };
});
app.get("/api/v1/logs", () => playbackLogs(new Date(Date.now() - 24 * 60 * 60 * 1000)));

app.post("/api/v1/media", (request, reply) => {
  const body = parseBody(request.body);
  const now = new Date().toISOString();
  const item: MediaItem = {
    id: crypto.randomUUID(),
    title: stringField(body, "title", "Untitled fake item"),
    service: "fake",
    mediaType: "video",
    enabled: true,
    repeatable: true,
    expectedDurationSeconds: numberField(body, "durationSeconds", 20),
    metadata: fakeMetadata(body),
    createdAt: now,
    updatedAt: now
  };

  media.create(item);
  reply.code(201);
  return item;
});

app.delete("/api/v1/media/:id", async (request, reply) => {
  const item = media.get(routeParam(request.params, "id"));

  if (!item) {
    reply.code(404);
    return { error: "media-not-found" };
  }

  const relatedItems = item.localPath
    ? media.list().filter((candidate) => candidate.localPath === item.localPath)
    : [item];
  const ids = relatedItems.map((candidate) => candidate.id);

  if (queue.hasActiveForMedia(ids)) {
    reply.code(409);
    return { error: "media-is-active" };
  }

  const now = new Date().toISOString();
  queue.cancelQueuedForMedia(ids);

  if (item.localPath) {
    deletions.create({
      id: crypto.randomUUID(),
      localPath: item.localPath,
      status: "pending",
      createdAt: now
    });
    media.softDeleteLocalPath(item.localPath, now);
  } else {
    await cancelPendingUpload(item, now);
    media.softDelete(item.id, now);
  }

  return { deleted: true };
});

app.post("/api/v1/uploads", async (request, reply) => {
  const body = request.body;
  const filename = safeFilename(stringField(parseBody(request.query), "filename", "upload.bin"));

  if (!isSupportedMediaPath(filename)) {
    reply.code(400);
    return { error: "unsupported-media-file" };
  }

  if (!isReadable(body)) {
    reply.code(400);
    return { error: "upload-body-required" };
  }

  const now = new Date().toISOString();
  const downloadId = crypto.randomUUID();
  const mediaItemId = crypto.randomUUID();
  const sourcePath = join(uploadDir, `${downloadId}-${filename}`);
  const tempPath = `${sourcePath}.part`;
  const upload = await writeUploadStream(body, tempPath, sourcePath);

  if (upload.sizeBytes <= 0) {
    await removeFileIfExists(sourcePath);
    reply.code(400);
    return { error: "upload-body-required" };
  }

  media.create({
    id: mediaItemId,
    title: titleFromFilename(filename),
    service: "local",
    mediaType: "local-file",
    enabled: true,
    repeatable: true,
    metadata: { upload: { downloadId, filename, sizeBytes: upload.sizeBytes, status: "pending" } },
    createdAt: now,
    updatedAt: now
  });
  downloads.create({
    id: downloadId,
    mediaItemId,
    filename,
    sourcePath,
    status: "pending",
    createdAt: now
  });

  reply.code(201);
  return { downloadId, mediaItemId, sizeBytes: upload.sizeBytes };
});

app.post("/api/v1/queue", (request, reply) => {
  const body = parseBody(request.body);
  const mediaItemId = stringField(body, "mediaItemId", "");

  if (!media.get(mediaItemId)) {
    reply.code(404);
    return { error: "media-not-found" };
  }

  const entry: QueueEntry = {
    id: crypto.randomUUID(),
    mediaItemId,
    position: queue.nextPosition(),
    priority: 0,
    status: "queued",
    attemptCount: 0
  };

  queue.enqueue(entry);
  reply.code(201);
  return entry;
});

app.post("/api/v1/playlists", (request, reply) => {
  const body = parseBody(request.body);
  const mediaItemIds = validMediaItemIds(arrayField(body.mediaItemIds));

  if (mediaItemIds.length === 0) {
    reply.code(400);
    return { error: "playlist-media-required" };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const playlist = {
    id,
    name: stringField(body, "name", "Untitled playlist"),
    items: playlistItems(id, mediaItemIds),
    createdAt: now,
    updatedAt: now
  };

  playlists.create(playlist);
  reply.code(201);
  return playlist;
});

app.put("/api/v1/playlists/:id", (request, reply) => {
  const id = routeParam(request.params, "id");
  const body = parseBody(request.body);
  const mediaItemIds = validMediaItemIds(arrayField(body.mediaItemIds));

  if (mediaItemIds.length === 0) {
    reply.code(400);
    return { error: "playlist-media-required" };
  }

  if (
    !playlists.update(
      id,
      stringField(body, "name", "Untitled playlist"),
      mediaItemIds,
      new Date().toISOString()
    )
  ) {
    reply.code(404);
    return { error: "playlist-not-found" };
  }

  return playlists.get(id);
});

app.delete("/api/v1/playlists/:id", (request, reply) => {
  if (!playlists.delete(routeParam(request.params, "id"))) {
    reply.code(404);
    return { error: "playlist-not-found" };
  }

  return { deleted: true };
});

app.post("/api/v1/playlists/:id/queue", (request, reply) => {
  const playlist = playlists.get(routeParam(request.params, "id"));

  if (!playlist) {
    reply.code(404);
    return { error: "playlist-not-found" };
  }

  const entries: QueueEntry[] = [];

  for (const item of playlist.items) {
    if (!media.get(item.mediaItemId)) {
      continue;
    }

    const entry = createQueueEntry(item.mediaItemId);
    queue.enqueue(entry);
    entries.push(entry);
  }

  if (entries.length === 0) {
    reply.code(409);
    return { error: "playlist-has-no-available-media" };
  }

  reply.code(201);
  return { entries };
});

app.post("/api/v1/queue/clear-completed", () => {
  return { cleared: queue.clearCompleted() };
});
app.post("/api/v1/queue/clear-failed", () => {
  return { cleared: queue.clearFailed() };
});

app.post("/api/v1/queue/clear-errors", () => {
  return { cleared: queue.clearErrors() };
});

app.post("/api/v1/queue/shuffle", () => {
  return { queue: queue.shuffleQueued() };
});

app.delete("/api/v1/queue/:id", (request, reply) => {
  const id = routeParam(request.params, "id");

  if (!queue.remove(id)) {
    reply.code(404);
    return { error: "queue-entry-not-removable" };
  }

  return { removed: true };
});

app.post("/api/v1/queue/:id/play", (request, reply) => {
  clearStaleStartingQueueEntries();

  if (!queue.promoteToNext(routeParam(request.params, "id"))) {
    reply.code(409);
    return { error: "queue-entry-not-playable" };
  }

  const active = queue.active();

  if (active) {
    commands.create(createCommand("skip", active.mediaItemId));
  }

  return setPlaybackSettings({ enabled: true });
});

app.post("/api/v1/queue/:id/move", (request, reply) => {
  const body = parseBody(request.body);
  const direction = stringField(body, "direction", "");

  if (direction !== "up" && direction !== "down") {
    reply.code(400);
    return { error: "unsupported-direction" };
  }

  const moved = queue.move(routeParam(request.params, "id"), direction);

  if (!moved) {
    reply.code(409);
    return { error: "queue-entry-not-movable" };
  }

  return { moved };
});

app.post("/api/v1/fake-queue", (request, reply) => {
  const body = parseBody(request.body);
  const now = new Date().toISOString();
  const item: MediaItem = {
    id: crypto.randomUUID(),
    title: stringField(body, "title", "Untitled fake item"),
    service: "fake",
    mediaType: "video",
    enabled: true,
    repeatable: true,
    expectedDurationSeconds: numberField(body, "durationSeconds", 20),
    metadata: fakeMetadata(body),
    createdAt: now,
    updatedAt: now
  };
  const entry: QueueEntry = {
    id: crypto.randomUUID(),
    mediaItemId: item.id,
    position: queue.nextPosition(),
    priority: 0,
    status: "queued",
    attemptCount: 0
  };

  media.create(item);
  queue.enqueue(entry);
  reply.code(201);
  return { item, entry };
});

app.post("/api/v1/prime-queue", async (request, reply) => {
  const body = parseBody(request.body);
  const url = stringField(body, "url", "");

  if (!isPrimeUrl(url)) {
    reply.code(400);
    return { error: "prime-url-required" };
  }

  const canonicalUrl = canonicalPrimeUrl(url);
  const now = new Date().toISOString();
  const existing = media.getByServiceUrl("prime", canonicalUrl);
  const item =
    existing ??
    ({
      id: crypto.randomUUID(),
      title: await titleForPrimeUrl(canonicalUrl, stringOptional(body.title)),
      service: "prime",
      mediaType: "movie",
      url: canonicalUrl,
      enabled: true,
      repeatable: true,
      expectedDurationSeconds: numberField(body, "durationSeconds", 7200),
      metadata: { sourceUrl: canonicalUrl },
      createdAt: now,
      updatedAt: now
    } satisfies MediaItem);
  const entry = createQueueEntry(item.id);

  if (!existing) {
    media.create(item);
  }

  queue.enqueue(entry);
  reply.code(201);
  return { item, entry, duplicate: Boolean(existing) };
});

app.post("/api/v1/youtube-queue", async (request, reply) => {
  const body = parseBody(request.body);
  const url = stringField(body, "url", "");

  if (!isYouTubeUrl(url)) {
    reply.code(400);
    return { error: "youtube-url-required" };
  }

  const youtubeQueue = await canonicalYouTubeQueueItems(url);

  if (!youtubeQueue.urls.length) {
    reply.code(422);
    return { error: "youtube-episodes-not-found" };
  }

  const now = new Date().toISOString();
  const requestedDurationSeconds = optionalNumberField(body, "durationSeconds");
  const items: MediaItem[] = [];
  const entries: QueueEntry[] = [];
  let duplicateCount = 0;

  for (const canonicalUrl of youtubeQueue.urls) {
    const existing = media.getByServiceUrl("youtube", canonicalUrl);
    const title = await titleForYouTubeUrl(canonicalUrl, stringOptional(body.title));
    const showTitle = youtubeQueue.showTitle
      ? titleForYouTubeShowEpisode(youtubeQueue.showTitle, title)
      : title;
    let item =
      existing ??
      ({
        id: crypto.randomUUID(),
        title: showTitle,
        service: "youtube",
        mediaType: "video",
        url: canonicalUrl,
        enabled: true,
        repeatable: true,
        ...(requestedDurationSeconds ? { expectedDurationSeconds: requestedDurationSeconds } : {}),
        metadata: { sourceUrl: canonicalUrl },
        createdAt: now,
        updatedAt: now
      } satisfies MediaItem);
    const entry = createQueueEntry(item.id);

    if (existing) {
      duplicateCount += 1;
      if (shouldUpdateYouTubeTitle(existing.title, showTitle, youtubeQueue.showTitle)) {
        item = { ...existing, title: showTitle, updatedAt: now };
        media.upsert(item);
      }
    } else {
      media.create(item);
    }

    queue.enqueue(entry);
    items.push(item);
    entries.push(entry);
  }

  reply.code(201);
  return {
    item: items[0],
    entry: entries[0],
    duplicate: duplicateCount > 0,
    items,
    entries,
    queued: entries.length,
    duplicates: duplicateCount
  };
});

app.get("/api/v1/fallback/youtube", () => ({
  playlist: youtubeFallbackPlaylist()
}));

app.put("/api/v1/fallback/youtube", async (request, reply) => {
  const body = parseBody(request.body);
  const items = arrayField(body.items);
  const playlist = ensureYouTubeFallbackPlaylist();
  const now = new Date().toISOString();
  const mediaItemIds: string[] = [];

  for (const itemBody of items) {
    const item = parseBody(itemBody);
    const url = stringField(item, "url", "");

    if (!isYouTubeUrl(url)) {
      reply.code(400);
      return { error: "youtube-url-required" };
    }

    const canonicalUrl = canonicalYouTubeUrl(url);
    const existing = media.getByServiceUrl("youtube", canonicalUrl);
    const mediaItem =
      existing ??
      ({
        id: crypto.randomUUID(),
        title: await titleForYouTubeUrl(canonicalUrl, stringOptional(item.title)),
        service: "youtube",
        mediaType: "video",
        url: canonicalUrl,
        enabled: true,
        repeatable: true,
        expectedDurationSeconds: numberField(item, "durationSeconds", 1800),
        metadata: { fallback: true, sourceUrl: canonicalUrl },
        createdAt: now,
        updatedAt: now
      } satisfies MediaItem);

    if (!existing) {
      media.create(mediaItem);
    }

    if (!mediaItemIds.includes(mediaItem.id)) {
      mediaItemIds.push(mediaItem.id);
    }
  }

  playlists.update(playlist.id, playlist.name, mediaItemIds, now);
  return { playlist: playlists.get(playlist.id) };
});

app.post("/api/v1/fallback/youtube/items", async (request, reply) => {
  const body = parseBody(request.body);
  const url = stringField(body, "url", "");

  if (!isYouTubeUrl(url)) {
    reply.code(400);
    return { error: "youtube-url-required" };
  }

  const playlist = ensureYouTubeFallbackPlaylist();
  const canonicalUrl = canonicalYouTubeUrl(url);
  const now = new Date().toISOString();
  const existing = media.getByServiceUrl("youtube", canonicalUrl);
  const item =
    existing ??
    ({
      id: crypto.randomUUID(),
      title: await titleForYouTubeUrl(canonicalUrl, stringOptional(body.title)),
      service: "youtube",
      mediaType: "video",
      url: canonicalUrl,
      enabled: true,
      repeatable: true,
      expectedDurationSeconds: numberField(body, "durationSeconds", 1800),
      metadata: { fallback: true, sourceUrl: canonicalUrl },
      createdAt: now,
      updatedAt: now
    } satisfies MediaItem);

  if (!existing) {
    media.create(item);
  }

  const mediaItemIds = [
    ...playlist.items.map((playlistItem) => playlistItem.mediaItemId),
    item.id
  ].filter((id, index, ids) => ids.indexOf(id) === index);

  playlists.update(playlist.id, playlist.name, mediaItemIds, now);
  reply.code(201);
  return { item, playlist: playlists.get(playlist.id) };
});

app.delete("/api/v1/fallback/youtube/items/:mediaItemId", (request, reply) => {
  const playlist = youtubeFallbackPlaylist();

  if (!playlist) {
    reply.code(404);
    return { error: "fallback-playlist-not-found" };
  }

  const mediaItemId = routeParam(request.params, "mediaItemId");
  const mediaItemIds = playlist.items
    .map((playlistItem) => playlistItem.mediaItemId)
    .filter((id) => id !== mediaItemId);

  playlists.update(playlist.id, playlist.name, mediaItemIds, new Date().toISOString());
  return { playlist: playlists.get(playlist.id) };
});

app.post("/api/v1/appliance/fallback/youtube", (request, reply) => {
  if (!playbackSettings().fallbackEnabled) {
    return { entries: [], skipped: "fallback-disabled" };
  }

  const fallbackPlaylist = youtubeFallbackPlaylist();
  const fallbackMediaIds = fallbackPlaylist?.items.map((item) => item.mediaItemId) ?? [];

  if (fallbackMediaIds.length === 0) {
    return { entries: [], skipped: "fallback-playlist-empty" };
  }

  const queueEntries = queue.list();
  const existingFallbackMediaIds = new Set(fallbackMediaIds);
  const primaryAlreadyRunnable = queueEntries.some(
    (entry) =>
      isRunnableQueueStatus(entry.status) && !existingFallbackMediaIds.has(entry.mediaItemId)
  );

  if (primaryAlreadyRunnable) {
    return { entries: [], skipped: "primary-queue-runnable" };
  }

  const fallbackAlreadyRunnable = queueEntries.some(
    (entry) =>
      existingFallbackMediaIds.has(entry.mediaItemId) && isRunnableQueueStatus(entry.status)
  );

  if (fallbackAlreadyRunnable) {
    return { entries: [], skipped: "fallback-already-runnable" };
  }

  const entries: QueueEntry[] = [];

  for (const mediaItemId of fallbackMediaIds) {
    if (!media.get(mediaItemId)) continue;

    const terminal = queueEntries.find(
      (entry) =>
        entry.mediaItemId === mediaItemId &&
        (entry.status === "completed" || entry.status === "failed" || entry.status === "skipped")
    );

    if (terminal) {
      if (queue.requeueCompleted(terminal.id)) {
        const requeued = queue.get(terminal.id);
        if (requeued) entries.push(requeued);
      }
      continue;
    }

    const entry = createQueueEntry(mediaItemId);
    queue.enqueue(entry);
    entries.push(entry);
  }

  void notify("YouTube fallback queued", `${entries.length} public fallback video(s) queued.`, {
    count: entries.length
  });
  reply.code(201);
  return { entries };
});

app.post("/api/v1/playback/start", () => {
  const playback = setPlaybackSettings({ enabled: true });
  recoverRunnableQueue(playback);
  return playback;
});
app.post("/api/v1/playback/stop", () => {
  const status = setPlaybackSettings({ enabled: false });
  const active = queue.active();

  if (active) {
    commands.create(createCommand("stop", active.mediaItemId));
  }

  return status;
});
app.post("/api/v1/playback/loop", (request) => {
  const body = parseBody(request.body);
  return setPlaybackSettings({ loopEnabled: booleanField(body, "enabled", false) });
});
app.post("/api/v1/playback/fallback", (request) => {
  const body = parseBody(request.body);
  return setPlaybackSettings({ fallbackEnabled: booleanField(body, "enabled", true) });
});
app.post("/api/v1/lab/reset", async () => {
  const status = setPlaybackSettings({ enabled: false, loopEnabled: false });
  db.exec(`
    DELETE FROM playback_events;
    DELETE FROM playback_commands;
    DELETE FROM playback_sessions;
    DELETE FROM queue_entries;
    DELETE FROM media_deletions;
    DELETE FROM media_downloads;
  `);
  await resetUploadDir();
  return { reset: true, ...status };
});

app.post("/api/v1/commands", (request, reply) => {
  const body = parseBody(request.body);
  const type = stringField(body, "type", "") as PlaybackCommandType;

  if (!["pause", "restart", "resume", "skip", "stop"].includes(type)) {
    reply.code(400);
    return { error: "unsupported-command" };
  }

  const active = queue.active();

  if (!active) {
    reply.code(409);
    return { error: "no-active-playback" };
  }

  const command = createCommand(type, active.mediaItemId);

  commands.create(command);
  reply.code(201);
  return command;
});

app.post("/api/v1/login/:service", (request, reply) => {
  const service = routeParam(request.params, "service");
  const body = parseBody(request.body);
  const mediaItemId = stringOptional(body.mediaItemId);

  if (service !== "youtube" && service !== "prime") {
    reply.code(400);
    return { error: "unsupported-login-service" };
  }

  if (mediaItemId) {
    const item = media.get(mediaItemId);
    if (!item || item.service !== service) {
      reply.code(400);
      return { error: "login-media-service-mismatch" };
    }
  }

  const command = createCommand(
    service === "youtube" ? "login-youtube" : "login-prime",
    mediaItemId
  );
  commands.create(command);
  reply.code(201);
  return command;
});

app.post("/api/v1/appliance/heartbeat", (request) => {
  const body = parseBody(request.body);
  const state = playbackStateField(body.state);
  reconcileQueueWithApplianceState(state);
  recoverRunnableQueue();
  appliances.heartbeat(
    stringField(body, "applianceId", config.values.applianceId),
    stringField(body, "name", config.values.applianceName),
    new Date().toISOString(),
    state
  );

  return { ok: true, playback: playbackSettings() };
});

app.post("/api/v1/appliance/media-inventory", (request) => {
  const body = parseBody(request.body);
  const applianceId = stringField(body, "applianceId", config.values.applianceId);
  const now = new Date().toISOString();
  let synced = 0;

  for (const item of arrayField(body.items)) {
    const record = parseBody(item);
    const localPath = stringOptional(record.localPath);

    if (!localPath || !isSupportedMediaPath(localPath)) {
      continue;
    }

    if (media.deletedLocalPathExists(localPath)) {
      continue;
    }

    media.upsert({
      id: media.getByLocalPath(localPath)?.id ?? localMediaId(applianceId, localPath),
      title: stringField(record, "title", titleFromFilename(localPath)),
      service: "local",
      mediaType: "local-file",
      localPath,
      enabled: true,
      repeatable: true,
      metadata: {
        applianceId,
        sizeBytes: numberField(record, "sizeBytes", 0),
        modifiedAt: stringField(record, "modifiedAt", now)
      },
      createdAt: now,
      updatedAt: now
    });
    synced += 1;
  }

  return { synced };
});

app.get("/api/v1/appliance/downloads", () =>
  downloads.listPending().map((download) => ({
    id: download.id,
    mediaItemId: download.mediaItemId,
    filename: download.filename,
    url: `/api/v1/appliance/downloads/${download.id}/file`
  }))
);

app.get("/api/v1/appliance/media-deletions", () =>
  deletions.listPending().map((deletion) => ({
    id: deletion.id,
    localPath: deletion.localPath
  }))
);

app.post("/api/v1/appliance/media-deletions/:id/complete", (request, reply) => {
  if (!deletions.complete(routeParam(request.params, "id"), new Date().toISOString())) {
    reply.code(404);
    return { error: "deletion-not-found" };
  }

  return { ok: true };
});

app.post("/api/v1/appliance/media-deletions/:id/fail", (request, reply) => {
  const body = parseBody(request.body);

  if (
    !deletions.fail(
      routeParam(request.params, "id"),
      stringField(body, "message", "Deletion failed."),
      new Date().toISOString()
    )
  ) {
    reply.code(404);
    return { error: "deletion-not-found" };
  }

  return { ok: true };
});

app.get("/api/v1/appliance/downloads/:id/file", async (request, reply) => {
  const download = downloads.get(routeParam(request.params, "id"));

  if (!download || download.status !== "pending") {
    reply.code(404);
    return { error: "download-not-found" };
  }

  const source = await stat(download.sourcePath).catch(() => undefined);

  if (!source?.isFile()) {
    reply.code(410);
    return { error: "download-source-missing" };
  }

  reply.header("content-length", String(source.size));
  reply.header(
    "content-disposition",
    `attachment; filename="${headerFilename(download.filename)}"`
  );
  reply.header("content-type", "application/octet-stream");
  return reply.send(createReadStream(download.sourcePath));
});

app.post("/api/v1/appliance/downloads/:id/complete", async (request, reply) => {
  const body = parseBody(request.body);
  const download = downloads.get(routeParam(request.params, "id"));
  const localPath = stringOptional(body.localPath);
  const now = new Date().toISOString();

  if (!download || !localPath || !media.get(download.mediaItemId)) {
    reply.code(404);
    return { error: "download-not-found" };
  }

  if (!isSupportedMediaPath(localPath)) {
    reply.code(400);
    return { error: "unsupported-media-file" };
  }

  downloads.complete(download.id, now);
  media.updateLocalPath(download.mediaItemId, localPath, now);
  await removeFileIfExists(download.sourcePath);
  return { ok: true };
});

app.post("/api/v1/appliance/downloads/:id/fail", (request, reply) => {
  const body = parseBody(request.body);
  const download = downloads.get(routeParam(request.params, "id"));

  if (!download) {
    reply.code(404);
    return { error: "download-not-found" };
  }

  downloads.fail(
    download.id,
    stringField(body, "message", "Download failed."),
    new Date().toISOString()
  );
  return { ok: true };
});

app.get("/api/v1/appliance/playback", () => playbackSettings());

app.get("/api/v1/appliance/media/:id", (request, reply) => {
  const item = media.get(routeParam(request.params, "id"));

  if (!item) {
    reply.code(404);
    return { error: "media-not-found" };
  }

  return item;
});

app.post("/api/v1/appliance/queue/next", () => {
  const now = new Date().toISOString();
  clearStaleStartingQueueEntries();
  const active = queue.active();

  if (active) {
    return active;
  }

  recoverRunnableQueue();
  return queue.selectNextQueued(now) ?? null;
});
app.post("/api/v1/appliance/queue", (request, reply) => {
  const body = parseBody(request.body);
  const mediaItemId = stringField(body, "mediaItemId", "");
  const source = media.get(mediaItemId);

  if (!source) {
    reply.code(404);
    return { error: "media-not-found" };
  }

  const entry: QueueEntry = {
    id: crypto.randomUUID(),
    mediaItemId,
    position: queue.nextPosition(),
    priority: numberField(body, "priority", 0),
    status: "queued",
    attemptCount: 0
  };
  queue.enqueue(entry);
  reply.code(201);
  return entry;
});

app.post("/api/v1/appliance/queue/:id/requeue", (request, reply) => {
  if (!queue.requeueCompleted(routeParam(request.params, "id"))) {
    reply.code(409);
    return { error: "queue-entry-not-requeueable" };
  }

  return { requeued: true };
});

app.post("/api/v1/appliance/queue/:id/status", (request, reply) => {
  const body = parseBody(request.body);
  const id = routeParam(request.params, "id");
  const status = stringField(body, "status", "") as QueueEntryStatus;

  if (
    ![
      "queued",
      "starting",
      "playing",
      "paused",
      "completed",
      "failed",
      "skipped",
      "cancelled"
    ].includes(status)
  ) {
    reply.code(400);
    return { error: "unsupported-status" };
  }

  const updated = queue.updateStatus(id, status, optionalStrings(body));

  if (!updated) {
    const current = queue.get(id);
    if (current && isTerminalQueueStatus(current.status)) {
      return { ignored: "queue-entry-terminal", ok: true, status: current.status };
    }

    reply.code(409);
    return { error: "queue-entry-status-conflict" };
  }

  return { ok: true };
});

app.post("/api/v1/appliance/media/:id/duration", (request, reply) => {
  const body = parseBody(request.body);
  const durationSeconds = optionalNumberField(body, "durationSeconds");

  if (!durationSeconds || durationSeconds < 1) {
    reply.code(400);
    return { error: "duration-seconds-required" };
  }

  if (
    !media.updateExpectedDuration(
      routeParam(request.params, "id"),
      durationSeconds,
      new Date().toISOString()
    )
  ) {
    reply.code(404);
    return { error: "media-not-found" };
  }

  return { ok: true };
});

app.post("/api/v1/appliance/playback/complete-run", () => {
  const playback = playbackSettings();

  if (queue.runnableCount() === 0) {
    if (recoverRunnableQueue(playback) > 0) {
      return playback;
    }

    return playback.loopEnabled ? playback : setPlaybackSettings({ enabled: false });
  }

  return playback;
});

app.get("/api/v1/appliance/commands", () => commands.listByStatus("pending"));
app.post("/api/v1/appliance/commands/:id/status", (request, reply) => {
  const body = parseBody(request.body);
  const status = stringField(body, "status", "") as PlaybackCommandStatus;

  if (!["pending", "accepted", "completed", "failed"].includes(status)) {
    reply.code(400);
    return { error: "unsupported-status" };
  }

  commands.updateStatus(routeParam(request.params, "id"), status);
  return { ok: true };
});

app.post("/api/v1/appliance/events", (request, reply) => {
  const body = parseBody(request.body);
  const type = stringField(body, "type", "");

  if (!type) {
    reply.code(400);
    return { error: "event-type-required" };
  }

  const queueEntryId = stringOptional(body.queueEntryId);
  const mediaItemId = stringOptional(body.mediaItemId);
  const event = {
    id: stringField(body, "id", crypto.randomUUID()),
    ...(queueEntryId ? { queueEntryId } : {}),
    ...(mediaItemId ? { mediaItemId } : {}),
    type,
    details: objectField(body.details),
    createdAt: stringField(body, "createdAt", new Date().toISOString())
  };
  events.append(event);

  if (type === "FAILED") {
    void notify("Playback failed", notificationMessage(event), event);
  }

  return { ok: true };
});

try {
  enablePlaybackOnStartup();
  app.log.warn({ config: config.redacted }, "Loaded CareTV configuration");
  await app.listen({ host: config.values.host, port: config.values.serverPort });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

interface PlaybackLogEntry {
  id: string;
  createdAt: string;
  severity: "info" | "warning" | "error";
  source: "appliance" | "dashboard";
  type: string;
  title: string;
  mediaTitle?: string;
  description: string;
  details: Record<string, unknown>;
}

function playbackLogs(since: Date): { since: string; entries: PlaybackLogEntry[] } {
  const sinceIso = since.toISOString();
  const entries = [
    ...events.listSince(sinceIso).flatMap(logEntryForEvent),
    ...commands.listSince(sinceIso).map(logEntryForCommand)
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { since: sinceIso, entries };
}

function logEntryForEvent(event: PlaybackEvent): PlaybackLogEntry[] {
  if (event.type === "PLAYING" || event.type === "HEARTBEAT") {
    return [];
  }

  const item = event.mediaItemId ? media.get(event.mediaItemId) : undefined;
  const mediaTitle = item?.title;
  const description = eventDescription(event, mediaTitle);
  return [
    {
      id: `event-${event.id}`,
      createdAt: event.createdAt,
      severity: event.type === "FAILED" ? "error" : event.type === "BUFFERING" ? "warning" : "info",
      source: "appliance",
      type: event.type,
      title: event.type === "FAILED" ? "Playback failed" : eventTitle(event.type),
      ...(mediaTitle ? { mediaTitle } : {}),
      description,
      details: event.details
    }
  ];
}

function logEntryForCommand(command: PlaybackCommand): PlaybackLogEntry {
  const item = command.mediaItemId ? media.get(command.mediaItemId) : undefined;
  const mediaTitle = item?.title;
  return {
    id: `command-${command.id}`,
    createdAt: command.issuedAt,
    severity:
      command.status === "failed"
        ? "error"
        : command.type === "skip" || command.type === "stop"
          ? "warning"
          : "info",
    source: "dashboard",
    type: command.type,
    title: `Command ${command.status}`,
    ...(mediaTitle ? { mediaTitle } : {}),
    description: `${commandLabel(command.type)} ${command.status}${mediaTitle ? ` for ${mediaTitle}` : ""}.`,
    details: {
      issuedBy: command.issuedBy,
      status: command.status
    }
  };
}

function eventDescription(event: PlaybackEvent, mediaTitle: string | undefined): string {
  const name = mediaTitle ?? "Playback item";
  const code = stringOptional(event.details.code);
  const message = stringOptional(event.details.message);

  if (event.type === "FAILED") {
    return `${name} failed${code ? ` with ${friendlyIssueCode(code)}` : ""}${message ? `: ${message}` : "."}`;
  }

  if (event.type === "QUEUE_SELECTED") return `${name} was selected for playback.`;
  if (event.type === "BROWSER_LAUNCHED") return `Browser launched for ${name}.`;
  if (event.type === "READY") return `${name} loaded and is ready to play.`;
  if (event.type === "BUFFERING") return `${name} is buffering.`;
  if (event.type === "PAUSED") return `${name} paused.`;
  if (event.type === "COMPLETED") return `${name} completed.`;
  if (event.type === "STOPPED") return "Playback stopped and the appliance returned to idle.";
  if (event.type === "RECOVERING") return `${name} entered recovery mode.`;

  return `${eventTitle(event.type)}${mediaTitle ? `: ${mediaTitle}` : ""}.`;
}

function eventTitle(type: string): string {
  return type
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function commandLabel(type: PlaybackCommandType): string {
  switch (type) {
    case "login-prime":
      return "Prime login";
    case "login-youtube":
      return "YouTube login";
    case "play-now":
      return "Play now";
    case "restart-agent":
      return "Restart agent";
    case "restart-browser":
      return "Restart browser";
    default:
      return eventTitle(type);
  }
}

function friendlyIssueCode(code: string): string {
  switch (code) {
    case "youtube-signin-required":
      return "YouTube signed out";
    case "youtube-age-verification-required":
      return "YouTube age verification required";
    case "youtube-verification-required":
      return "Google account verification required";
    case "youtube-consent-required":
      return "YouTube consent prompt";
    case "youtube-buffering-timeout":
      return "YouTube buffering timeout";
    case "agent-error":
      return "appliance agent error";
    case "browser-recovery-failed":
      return "browser recovery failed";
    case "observation-limit":
      return "playback observation limit";
    default:
      return code;
  }
}

function parseBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function isAuthorized(
  url: string,
  headers: Record<string, string | string[] | undefined>
): boolean {
  const token = config.values.authToken;
  if (!token || !url.startsWith("/api/")) return true;

  const supplied = bearerToken(headers.authorization) ?? stringHeader(headers["x-caretv-token"]);
  return Boolean(supplied && safeStringEqual(supplied, token));
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = stringHeader(header);
  return value?.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : undefined;
}

function stringHeader(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createCommand(type: PlaybackCommandType, mediaItemId?: string): PlaybackCommand {
  return {
    id: crypto.randomUUID(),
    type,
    ...(mediaItemId ? { mediaItemId } : {}),
    issuedAt: new Date().toISOString(),
    issuedBy: "dashboard",
    status: "pending"
  };
}

function youtubeFallbackPlaylist() {
  const playlistId = stringOptional(settings.get(youtubeFallbackSettingKey)?.playlistId);
  return playlistId ? playlists.get(playlistId) : undefined;
}

function ensureYouTubeFallbackPlaylist() {
  const existing = youtubeFallbackPlaylist();

  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const playlist = {
    id: crypto.randomUUID(),
    name: "YouTube fallback queue",
    items: [],
    createdAt: now,
    updatedAt: now
  };

  playlists.create(playlist);
  settings.set(youtubeFallbackSettingKey, { playlistId: playlist.id }, now);
  return playlist;
}

function createQueueEntry(mediaItemId: string): QueueEntry {
  return {
    id: crypto.randomUUID(),
    mediaItemId,
    position: queue.nextPosition(),
    priority: 0,
    status: "queued",
    attemptCount: 0
  };
}

interface PlaybackSettings {
  enabled: boolean;
  fallbackEnabled: boolean;
  loopEnabled: boolean;
}

function playbackSettings(): PlaybackSettings {
  const stored = settings.get("playback") ?? {};
  return {
    enabled: booleanField(stored, "enabled", true),
    fallbackEnabled: booleanField(stored, "fallbackEnabled", true),
    loopEnabled: booleanField(stored, "loopEnabled", true)
  };
}

function setPlaybackSettings(patch: Partial<PlaybackSettings>): PlaybackSettings {
  const next = { ...playbackSettings(), ...patch };
  settings.set("playback", next, new Date().toISOString());
  return next;
}

function enablePlaybackOnStartup(): PlaybackSettings {
  const playback = setPlaybackSettings({ enabled: true, loopEnabled: true });
  recoverRunnableQueue(playback);
  return playback;
}

function recoverRunnableQueue(playback = playbackSettings()): number {
  if (!playback.enabled) {
    return 0;
  }

  const recovered = queue.requeueRecoverableFailures();

  if (recovered > 0) {
    app.log.warn({ requeued: recovered }, "Requeued recoverable failed queue entries");
  }

  if (queue.runnableCount() > 0 || !playback.loopEnabled) {
    return recovered;
  }

  const looped = queue.requeueCompletedEntries();

  if (looped > 0) {
    app.log.warn({ requeued: looped }, "Requeued terminal queue entries for looped playback");
  }

  return recovered + looped;
}

function isRunnableQueueStatus(status: QueueEntryStatus): boolean {
  return (
    status === "queued" || status === "starting" || status === "playing" || status === "paused"
  );
}

function isTerminalQueueStatus(status: QueueEntryStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "skipped" || status === "cancelled"
  );
}

function reconcileQueueWithApplianceState(state: PlaybackState | undefined): void {
  if (!state || (state.phase !== "idle" && state.phase !== "failed")) {
    return;
  }

  if (state.phase === "failed") {
    const active = queue.active();

    if (state.queueEntryId && active?.id === state.queueEntryId) {
      queue.updateStatus(state.queueEntryId, "failed", { lastErrorCode: "appliance-failed" });
    }

    return;
  }

  clearStaleStartingQueueEntries();

  const idleStaleMs = Math.max(config.values.applianceHeartbeatMs * 12, 10 * 60_000);
  const startedBefore = new Date(Date.now() - idleStaleMs).toISOString();
  const reconciled = queue.reconcileStaleActive("skipped", "appliance-idle", startedBefore);

  if (reconciled > 0) {
    app.log.warn({ reconciled, phase: state.phase }, "Reconciled stale active queue entries");
  }
}

function clearStaleStartingQueueEntries(): void {
  const staleStartingMs = Math.max(
    config.values.applianceRequestTimeoutMs * 2,
    config.values.applianceHeartbeatMs * 2
  );
  const startedBefore = new Date(Date.now() - staleStartingMs).toISOString();
  const reconciled = queue.reconcileStaleStarting("skipped", startedBefore);

  if (reconciled > 0) {
    app.log.warn({ reconciled }, "Reconciled stale starting queue entries");
  }
}

async function notify(
  title: string,
  message: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  const url = config.values.notificationWebhookUrl;
  if (!url) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const isNtfy = config.values.notificationFormat === "ntfy";
    const response = await fetch(url, {
      body: isNtfy ? message : JSON.stringify({ details, message, title }),
      headers: isNtfy ? { title } : { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      app.log.warn({ status: response.status }, "Notification webhook failed");
    }
  } catch (error) {
    app.log.warn(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Notification webhook failed"
    );
  }
}

function notificationMessage(event: { details: Record<string, unknown>; mediaItemId?: string }) {
  const item = event.mediaItemId ? media.get(event.mediaItemId) : undefined;
  const code = stringOptional(event.details.code) ?? "unknown";
  return `${item?.title ?? "Playback item"} failed: ${code}`;
}

function routeParam(params: unknown, key: string): string {
  return parseBody(params)[key]?.toString() ?? "";
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function validMediaItemIds(values: unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const value of values) {
    const id = stringOptional(value);

    if (!id || seen.has(id) || !media.get(id)) {
      continue;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function optionalStrings(body: Record<string, unknown>): {
  completedAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
} {
  const completedAt = stringOptional(body.completedAt);
  const lastErrorCode = stringOptional(body.lastErrorCode);
  const lastErrorMessage = stringOptional(body.lastErrorMessage);
  return {
    ...(completedAt ? { completedAt } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
    ...(lastErrorMessage ? { lastErrorMessage } : {})
  };
}

function playbackStateField(value: unknown): PlaybackState | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as PlaybackState)
    : undefined;
}

function fakeMetadata(body: Record<string, unknown>): Record<string, unknown> {
  return {
    scenario: stringField(body, "scenario", "normal"),
    durationSeconds: numberField(body, "durationSeconds", 20),
    interruptAtSeconds: numberField(body, "interruptAtSeconds", 5),
    recoverySucceedsOnAttempt: numberField(body, "recoverySucceedsOnAttempt", 1)
  };
}

function numberField(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function booleanField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringField(body: Record<string, unknown>, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeFilename(input: string): string {
  return (
    basename(input)
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .trim() || "upload.bin"
  );
}

function headerFilename(input: string): string {
  return safeFilename(input).replace(/["\\]/g, "_");
}

function isReadable(input: unknown): input is Readable {
  return Boolean(
    input &&
    typeof input === "object" &&
    "pipe" in input &&
    typeof (input as { pipe?: unknown }).pipe === "function"
  );
}

async function writeUploadStream(
  source: Readable,
  tempPath: string,
  destinationPath: string
): Promise<{ sizeBytes: number }> {
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.byteLength;

      if (sizeBytes > maxUploadBytes) {
        callback(new Error("Upload exceeded maximum supported size."));
        return;
      }

      callback(null, chunk);
    }
  });

  try {
    await pipeline(source, counter, createWriteStream(tempPath, { flags: "wx" }));
    await rename(tempPath, destinationPath);
    return { sizeBytes };
  } catch (error) {
    await removeFileIfExists(tempPath);
    throw error;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFileError(error)) {
      app.log.warn(
        { error: error instanceof Error ? error.message : "Unknown error", path },
        "File cleanup failed"
      );
    }
  }
}

async function cancelPendingUpload(item: MediaItem, now: string): Promise<void> {
  const downloadId = uploadDownloadId(item);
  const download = downloadId ? downloads.get(downloadId) : undefined;

  if (!download || download.status !== "pending") {
    return;
  }

  downloads.fail(download.id, "Media was deleted before appliance download.", now);
  await removeFileIfExists(download.sourcePath);
}

function uploadDownloadId(item: MediaItem): string | undefined {
  const upload = item.metadata.upload;
  if (!upload || typeof upload !== "object" || Array.isArray(upload)) {
    return undefined;
  }

  return stringOptional((upload as Record<string, unknown>).downloadId);
}

async function resetUploadDir(): Promise<void> {
  await rm(uploadDir, { force: true, recursive: true });
  await mkdir(uploadDir, { recursive: true });
}

function titleFromFilename(input: string): string {
  return basename(input, extname(input)).replace(/[_-]+/g, " ").trim() || "Untitled media";
}

function localMediaId(applianceId: string, localPath: string): string {
  return `local-${createHash("sha256").update(`${applianceId}:${localPath}`).digest("hex").slice(0, 24)}`;
}

function isSupportedMediaPath(localPath: string): boolean {
  return extname(localPath).toLowerCase() === ".mp4";
}

function isPrimeUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname;
    return host.includes("amazon.") || host.endsWith("primevideo.com");
  } catch {
    return false;
  }
}

function canonicalPrimeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  return url.href;
}

async function titleForPrimeUrl(url: string, fallback?: string): Promise<string> {
  const remoteTitle = await fetchStreamingTitle(url);
  return remoteTitle ?? fallback ?? titleFromPrimeUrl(url);
}

async function titleForStreamingUrl(
  url: string,
  fallback: string | undefined,
  defaultTitle: string
): Promise<string> {
  const remoteTitle = await fetchStreamingTitle(url);
  return remoteTitle ?? fallback ?? defaultTitle;
}

async function titleForYouTubeUrl(url: string, fallback?: string): Promise<string> {
  return (
    (await fetchYouTubeTitle(url)) ?? (await titleForStreamingUrl(url, fallback, "YouTube Video"))
  );
}

interface YouTubeQueueItems {
  showTitle?: string;
  urls: string[];
}

async function canonicalYouTubeQueueItems(input: string): Promise<YouTubeQueueItems> {
  const canonicalUrl = canonicalYouTubeUrl(input);

  if (youTubeVideoId(canonicalUrl)) {
    return { urls: [canonicalUrl] };
  }

  return isYouTubeShowUrl(input) ? fetchYouTubeShowEpisodeItems(input) : { urls: [canonicalUrl] };
}

async function fetchYouTubeShowEpisodeItems(input: string): Promise<YouTubeQueueItems> {
  try {
    const response = await fetch(input, {
      headers: {
        accept: "text/html",
        "user-agent": "Mozilla/5.0 CareTV title resolver"
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return { urls: [] };
    }

    const html = await response.text();
    const showTitle = youtubeShowTitle(input, html);
    const urls = youTubeWatchUrlsFromHtml(html);
    return { ...(showTitle ? { showTitle } : {}), urls };
  } catch {
    return { urls: [] };
  }
}

function youTubeWatchUrlsFromHtml(html: string): string[] {
  const urls = [
    ...html.matchAll(/"url"\s*:\s*"(\/watch\?[^"]*?v=[\w-]{11}[^"]*)"/g),
    ...html.matchAll(/href=["'](\/watch\?[^"']*?v=[\w-]{11}[^"']*)["']/g)
  ]
    .map((match) => match[1])
    .filter((url): url is string => Boolean(url))
    .map((url) => decodeJsonString(decodeHtml(url)))
    .filter((url): url is string => Boolean(url))
    .map((url) => canonicalYouTubePlaybackUrl(`https://www.youtube.com${url}`));

  if (urls.length) {
    return uniqueYouTubeUrlsByVideoId(urls);
  }

  return youTubeVideoIdsFromHtml(html).map(
    (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`
  );
}

function youTubeVideoIdsFromHtml(html: string): string[] {
  const ids = [...html.matchAll(/"videoId":"([\w-]{11})"|[?&]v=([\w-]{11})/g)]
    .map((match) => match[1] ?? match[2])
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

function uniqueYouTubeUrlsByVideoId(urls: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const url of urls) {
    const id = youTubeVideoId(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(url);
  }

  return unique;
}

function titleForYouTubeShowEpisode(showTitle: string, episodeTitle: string): string {
  const cleanShowTitle = showTitle.trim();
  const cleanEpisodeTitle = episodeTitle.trim();

  if (
    !cleanShowTitle ||
    cleanEpisodeTitle.toLowerCase().startsWith(`${cleanShowTitle.toLowerCase()}:`) ||
    cleanEpisodeTitle.toLowerCase().startsWith(`${cleanShowTitle.toLowerCase()} -`)
  ) {
    return cleanEpisodeTitle;
  }

  return `${cleanShowTitle}: ${cleanEpisodeTitle}`;
}

function youtubeShowTitle(input: string, html: string): string | undefined {
  return (
    cleanStreamingTitle(
      matchMeta(html, "og:title") ??
        matchMeta(html, "twitter:title") ??
        matchYouTubeShowTitle(html) ??
        matchTitle(html)
    ) ?? knownYouTubeShowTitle(input)
  );
}

function matchYouTubeShowTitle(html: string): string | undefined {
  const patterns = [
    /"showMetadataRenderer"\s*:\s*\{[\s\S]{0,2000}?"title"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/,
    /"metadata"\s*:\s*\{[\s\S]{0,2000}?"title"\s*:\s*"([^"]+)"/,
    /"title"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"\s*\}\s*,\s*"subtitle"\s*:\s*\{\s*"simpleText"\s*:\s*"(?:TV show|Show)"/i
  ];

  for (const pattern of patterns) {
    const title = decodeJsonString(pattern.exec(html)?.[1]);
    if (title && !/^youtube$/i.test(title)) return title;
  }

  return undefined;
}

function knownYouTubeShowTitle(input: string): string | undefined {
  try {
    const id = new URL(input).pathname.split("/").filter(Boolean)[1];
    return id === "SCt7aU7h0c6VZHA0s2efPalg" ? "Castle" : undefined;
  } catch {
    return undefined;
  }
}

async function fetchYouTubeTitle(url: string): Promise<string | undefined> {
  try {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("format", "json");
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as { title?: unknown };
    return typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function fetchStreamingTitle(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html",
        "user-agent": "Mozilla/5.0 CareTV title resolver"
      },
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return undefined;
    }

    const html = await response.text();
    return cleanStreamingTitle(
      matchMeta(html, "og:title") ?? matchMeta(html, "twitter:title") ?? matchTitle(html)
    );
  } catch {
    return undefined;
  }
}

function matchMeta(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  ).exec(html);
  return match?.[1];
}

function matchTitle(html: string): string | undefined {
  return /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
}

function cleanStreamingTitle(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  const decoded = decodeHtml(input)
    .replace(/\s*-\s*(Prime Video|Amazon\.com|YouTube).*$/i, "")
    .replace(/\s*\|\s*(Prime Video|Amazon\.com|YouTube).*$/i, "")
    .trim();
  if (/^before you continue/i.test(decoded)) {
    return undefined;
  }

  return decoded || undefined;
}

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeJsonString(input: string | undefined): string | undefined {
  if (!input) return undefined;

  try {
    return JSON.parse(`"${input.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return input;
  }
}

function titleFromPrimeUrl(input: string): string {
  try {
    const url = new URL(input);
    const pathTitle = url.pathname
      .split("/")
      .filter(Boolean)
      .find((part) => !["gp", "video", "detail", "dp"].includes(part.toLowerCase()));
    return pathTitle ? titleFromFilename(pathTitle.replace(/[-_]+/g, " ")) : "Prime Video";
  } catch {
    return "Prime Video";
  }
}

function isGenericYouTubeTitle(title: string): boolean {
  return /^youtube video$/i.test(title.trim());
}

function shouldUpdateYouTubeTitle(
  currentTitle: string,
  nextTitle: string,
  showTitle: string | undefined
): boolean {
  if (isGenericYouTubeTitle(currentTitle)) {
    return !isGenericYouTubeTitle(nextTitle);
  }

  return Boolean(
    showTitle &&
    currentTitle.trim() !== nextTitle.trim() &&
    !currentTitle.toLowerCase().startsWith(`${showTitle.toLowerCase()}:`) &&
    !currentTitle.toLowerCase().startsWith(`${showTitle.toLowerCase()} -`)
  );
}

function isYouTubeUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

function canonicalYouTubeUrl(input: string): string {
  const url = new URL(input);
  const videoId = youTubeVideoId(input);

  if (!videoId) {
    url.hash = "";
    return url.href;
  }

  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function canonicalYouTubePlaybackUrl(input: string): string {
  const url = new URL(input);
  const videoId = youTubeVideoId(input);

  if (!videoId) {
    url.hash = "";
    return url.href;
  }

  url.hostname = "www.youtube.com";
  url.pathname = "/watch";
  url.searchParams.set("v", videoId);
  url.searchParams.delete("t");
  url.searchParams.delete("start");
  url.searchParams.delete("time_continue");
  url.hash = "";
  return url.href;
}

function youTubeVideoId(input: string): string | undefined {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    const pathParts = url.pathname.split("/").filter(Boolean);
    const id =
      host === "youtu.be"
        ? pathParts[0]
        : pathParts[0] === "shorts" || pathParts[0] === "embed"
          ? pathParts[1]
          : url.searchParams.get("v");
    return id && /^[\w-]{11}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function isYouTubeShowUrl(input: string): boolean {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    return (
      (host === "youtube.com" || host === "m.youtube.com") && url.pathname.startsWith("/show/")
    );
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
