import { join } from "node:path";

import Fastify from "fastify";

import { loadConfig } from "@caretv/config";
import type { MediaItem, PlaybackCommand, PlaybackCommandType, QueueEntry } from "@caretv/core";
import { createHealthStatus } from "@caretv/core";
import {
  CommandRepository,
  MediaRepository,
  migrate,
  openDatabase,
  PlaybackEventRepository,
  QueueRepository
} from "@caretv/database";

import { FakePlaybackService } from "./fakePlaybackService.js";

const config = loadConfig();
const db = openDatabase(join(config.values.runtimeDir, "caretv.sqlite"));
migrate(db);

const media = new MediaRepository(db);
const queue = new QueueRepository(db);
const commands = new CommandRepository(db);
const events = new PlaybackEventRepository(db);
const playback = new FakePlaybackService({ commands, events, logger: console, media, queue });

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
app.get("/api/v1/playback/status", () => ({
  ...playback.status(),
  events: events.listRecent(25),
  queue: queue.list()
}));

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

app.post("/api/v1/playback/start", () => playback.start());
app.post("/api/v1/playback/stop", () => playback.stop());

app.post("/api/v1/commands", (request, reply) => {
  const body = parseBody(request.body);
  const type = stringField(body, "type", "") as PlaybackCommandType;

  if (!["pause", "resume", "skip", "stop"].includes(type)) {
    reply.code(400);
    return { error: "unsupported-command" };
  }

  const command: PlaybackCommand = {
    id: crypto.randomUUID(),
    type,
    issuedAt: new Date().toISOString(),
    issuedBy: "dashboard",
    status: "pending"
  };

  commands.create(command);
  reply.code(201);
  return command;
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

function stringField(body: Record<string, unknown>, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
