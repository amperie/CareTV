import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import Fastify from "fastify";

import { loadConfig } from "@caretv/config";
import type {
  MediaItem,
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
const settings = new SettingsRepository(db);

const app = Fastify({ bodyLimit: 1024 * 1024 * 1024, logger: true });
const uploadDir = join(config.values.runtimeDir, "uploads");

await mkdir(uploadDir, { recursive: true });

app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer" },
  (_request, body, done) => {
    done(null, body);
  }
);

app.addHook("onRequest", (request, reply, done) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Headers", "content-type");
  reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");

  if (request.method === "OPTIONS") {
    reply.send();
    return;
  }

  done();
});

app.get("/health", () => createHealthStatus("server"));
app.get("/api/v1/media", () => media.list());
app.get("/api/v1/downloads", () => downloads.listPending());
app.get("/api/v1/queue", () => queue.list());
app.get("/api/v1/appliances", () => appliances.list(new Date()));
app.get("/api/v1/playback/status", () => {
  const appliance = appliances.latest(new Date());
  return {
    appliance,
    events: events.listRecent(25),
    loopEnabled: playbackSettings().loopEnabled,
    queue: queue.list(),
    running: playbackSettings().enabled,
    ...(appliance?.playbackState ? { state: appliance.playbackState } : {})
  };
});

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

app.delete("/api/v1/media/:id", (request, reply) => {
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
    media.softDelete(item.id, now);
  }

  return { deleted: true };
});

app.post("/api/v1/uploads", async (request, reply) => {
  const body = Buffer.isBuffer(request.body) ? request.body : undefined;
  const filename = safeFilename(stringField(parseBody(request.query), "filename", "upload.bin"));

  if (!body?.length) {
    reply.code(400);
    return { error: "upload-body-required" };
  }

  const now = new Date().toISOString();
  const downloadId = crypto.randomUUID();
  const mediaItemId = crypto.randomUUID();
  const sourcePath = join(uploadDir, `${downloadId}-${filename}`);

  await writeFile(sourcePath, body);

  media.create({
    id: mediaItemId,
    title: titleFromFilename(filename),
    service: "local",
    mediaType: "local-file",
    enabled: true,
    repeatable: true,
    metadata: { upload: { downloadId, filename, status: "pending" } },
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
  return { downloadId, mediaItemId };
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

app.post("/api/v1/queue/clear-completed", () => {
  db.exec("DELETE FROM playback_events;");
  return { cleared: queue.clearCompleted() };
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

  const now = new Date().toISOString();
  const title = await titleForPrimeUrl(url, stringOptional(body.title));
  const item: MediaItem = {
    id: crypto.randomUUID(),
    title,
    service: "prime",
    mediaType: "movie",
    url,
    enabled: true,
    repeatable: true,
    expectedDurationSeconds: numberField(body, "durationSeconds", 7200),
    metadata: { sourceUrl: url },
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

app.post("/api/v1/youtube-queue", async (request, reply) => {
  const body = parseBody(request.body);
  const url = stringField(body, "url", "");

  if (!isYouTubeUrl(url)) {
    reply.code(400);
    return { error: "youtube-url-required" };
  }

  const now = new Date().toISOString();
  const title = await titleForYouTubeUrl(url, stringOptional(body.title));
  const item: MediaItem = {
    id: crypto.randomUUID(),
    title,
    service: "youtube",
    mediaType: "video",
    url,
    enabled: true,
    repeatable: true,
    expectedDurationSeconds: numberField(body, "durationSeconds", 900),
    metadata: { sourceUrl: url },
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

app.post("/api/v1/playback/start", () => {
  if (queue.runnableCount() === 0) {
    queue.requeueCompletedEntries();
  }

  return setPlaybackSettings({ enabled: true });
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
app.post("/api/v1/lab/reset", () => {
  const status = setPlaybackSettings({ enabled: false, loopEnabled: false });
  db.exec(`
    DELETE FROM playback_events;
    DELETE FROM playback_commands;
    DELETE FROM playback_sessions;
    DELETE FROM queue_entries;
    DELETE FROM media_deletions;
    DELETE FROM media_downloads;
    DELETE FROM media_items;
  `);
  return { reset: true, ...status };
});

app.post("/api/v1/commands", (request, reply) => {
  const body = parseBody(request.body);
  const type = stringField(body, "type", "") as PlaybackCommandType;

  if (!["pause", "resume", "skip", "stop"].includes(type)) {
    reply.code(400);
    return { error: "unsupported-command" };
  }

  const command = createCommand(type);

  commands.create(command);
  reply.code(201);
  return command;
});

app.post("/api/v1/appliance/heartbeat", (request) => {
  const body = parseBody(request.body);
  const state = playbackStateField(body.state);
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

app.get("/api/v1/appliance/downloads/:id/file", (request, reply) => {
  const download = downloads.get(routeParam(request.params, "id"));

  if (!download || download.status !== "pending") {
    reply.code(404);
    return { error: "download-not-found" };
  }

  reply.header("content-type", "application/octet-stream");
  return reply.send(createReadStream(download.sourcePath));
});

app.post("/api/v1/appliance/downloads/:id/complete", (request, reply) => {
  const body = parseBody(request.body);
  const download = downloads.get(routeParam(request.params, "id"));
  const localPath = stringOptional(body.localPath);
  const now = new Date().toISOString();

  if (!download || !localPath) {
    reply.code(404);
    return { error: "download-not-found" };
  }

  downloads.complete(download.id, now);
  media.updateLocalPath(download.mediaItemId, localPath, now);
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
  const next = queue.selectNextQueued(now);

  if (next || !playbackSettings().loopEnabled || queue.runnableCount() > 0) {
    return next ?? null;
  }

  if (queue.requeueCompletedEntries() === 0) {
    return null;
  }

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

  const updated = queue.updateStatus(
    routeParam(request.params, "id"),
    status,
    optionalStrings(body)
  );

  if (!updated) {
    reply.code(409);
    return { error: "queue-entry-status-conflict" };
  }

  return { ok: true };
});

app.post("/api/v1/appliance/playback/complete-run", () => {
  const playback = playbackSettings();

  if (queue.runnableCount() === 0) {
    if (playback.loopEnabled && queue.requeueCompletedEntries() > 0) {
      return playback;
    }

    return setPlaybackSettings({ enabled: false });
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
  events.append({
    id: stringField(body, "id", crypto.randomUUID()),
    ...(queueEntryId ? { queueEntryId } : {}),
    ...(mediaItemId ? { mediaItemId } : {}),
    type,
    details: objectField(body.details),
    createdAt: stringField(body, "createdAt", new Date().toISOString())
  });
  return { ok: true };
});

try {
  app.log.info({ config: config.redacted }, "Loaded CareTV configuration");
  await app.listen({ host: config.values.host, port: config.values.serverPort });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

function parseBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
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

function playbackSettings(): { enabled: boolean; loopEnabled: boolean } {
  const stored = settings.get("playback") ?? {};
  return {
    enabled: booleanField(stored, "enabled", false),
    loopEnabled: booleanField(stored, "loopEnabled", false)
  };
}

function setPlaybackSettings(patch: Partial<{ enabled: boolean; loopEnabled: boolean }>): {
  enabled: boolean;
  loopEnabled: boolean;
} {
  const next = { ...playbackSettings(), ...patch };
  settings.set("playback", next, new Date().toISOString());
  return next;
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

function titleFromFilename(input: string): string {
  return basename(input, extname(input)).replace(/[_-]+/g, " ").trim() || "Untitled media";
}

function localMediaId(applianceId: string, localPath: string): string {
  return `local-${createHash("sha256").update(`${applianceId}:${localPath}`).digest("hex").slice(0, 24)}`;
}

function isSupportedMediaPath(localPath: string): boolean {
  return [".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi"].includes(
    extname(localPath).toLowerCase()
  );
}

function isPrimeUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname;
    return host.includes("amazon.") || host.endsWith("primevideo.com");
  } catch {
    return false;
  }
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
  return (await fetchYouTubeTitle(url)) ?? (await titleForStreamingUrl(url, fallback, "YouTube Video"));
}

async function fetchYouTubeTitle(url: string): Promise<string | undefined> {
  try {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", url);
    endpoint.searchParams.set("format", "json");
    const response = await fetch(endpoint, {
      headers: { "accept": "application/json" },
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
        "accept": "text/html",
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

function isYouTubeUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}
