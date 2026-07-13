import { join } from "node:path";

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
const queue = new QueueRepository(db);
const commands = new CommandRepository(db);
const events = new PlaybackEventRepository(db);
const settings = new SettingsRepository(db);

const app = Fastify({ logger: true });

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

app.delete("/api/v1/queue/:id", (request, reply) => {
  const id = routeParam(request.params, "id");

  if (!queue.remove(id)) {
    reply.code(404);
    return { error: "queue-entry-not-removable" };
  }

  return { removed: true };
});

app.post("/api/v1/queue/:id/move", (request, reply) => {
  const body = parseBody(request.body);
  const direction = stringField(body, "direction", "");

  if (direction !== "up" && direction !== "down") {
    reply.code(400);
    return { error: "unsupported-direction" };
  }

  return { moved: queue.move(routeParam(request.params, "id"), direction) };
});

app.post("/api/v1/queue/clear-completed", () => {
  db.exec("DELETE FROM playback_events;");
  return { cleared: queue.clearCompleted() };
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

app.post("/api/v1/playback/start", () => setPlaybackSettings({ enabled: true }));
app.post("/api/v1/playback/stop", () => {
  const status = setPlaybackSettings({ enabled: false });
  commands.create(createCommand("stop"));
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
  appliances.heartbeat(
    stringField(body, "applianceId", config.values.applianceId),
    stringField(body, "name", config.values.applianceName),
    new Date().toISOString(),
    playbackStateField(body.state)
  );
  return { ok: true, playback: playbackSettings() };
});

app.get("/api/v1/appliance/media/:id", (request, reply) => {
  const item = media.get(routeParam(request.params, "id"));

  if (!item) {
    reply.code(404);
    return { error: "media-not-found" };
  }

  return item;
});

app.post("/api/v1/appliance/queue/next", () => queue.selectNextQueued(new Date().toISOString()));
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

  queue.updateStatus(routeParam(request.params, "id"), status, optionalStrings(body));
  return { ok: true };
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

function createCommand(type: PlaybackCommandType): PlaybackCommand {
  return {
    id: crypto.randomUUID(),
    type,
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
