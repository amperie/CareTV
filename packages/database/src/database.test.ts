import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MediaItem, QueueEntry } from "@caretv/core";

import { ApplianceRepository } from "./applianceRepository.js";
import { CommandRepository } from "./commandRepository.js";
import { migrate, openDatabase } from "./database.js";
import { MediaRepository } from "./mediaRepository.js";
import { PlaybackEventRepository } from "./playbackEventRepository.js";
import { QueueRepository } from "./queueRepository.js";
import { SettingsRepository } from "./settingsRepository.js";

const now = "2026-01-01T00:00:00.000Z";

describe("database repositories", () => {
  it("persists media items across reopen", () => {
    withDatabase((filename) => {
      let db = openDatabase(filename);
      migrate(db);
      new MediaRepository(db).create(fakeMedia("media-1"));
      db.close();

      db = openDatabase(filename);
      migrate(db);
      expect(new MediaRepository(db).get("media-1")?.title).toBe("Fake media-1");
      db.close();
    });
  });

  it("selects one active queued item transactionally", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue(fakeQueueEntry("entry-1", "media-1", 2));
      queue.enqueue(fakeQueueEntry("entry-2", "media-1", 1));

      expect(queue.nextPosition()).toBe(3);
      expect(queue.list().map((entry) => entry.id)).toEqual(["entry-2", "entry-1"]);
      expect(queue.selectNextQueued(now)?.id).toBe("entry-2");
      expect(queue.get("entry-2")?.status).toBe("starting");
      expect(() => queue.selectNextQueued(now)).toThrow();
    });
  });

  it("reconciles stale active queue state", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({ ...fakeQueueEntry("entry-1", "media-1", 1), status: "playing" });

      expect(queue.reconcileStaleActive("failed", "agent-restarted")).toBe(1);
      expect(queue.get("entry-1")).toMatchObject({
        status: "failed",
        lastErrorCode: "agent-restarted"
      });
    });
  });

  it("moves queued entries within the queued subset", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({ ...fakeQueueEntry("active", "media-1", 1), status: "playing" });
      queue.enqueue(fakeQueueEntry("first", "media-1", 2));
      queue.enqueue(fakeQueueEntry("second", "media-1", 3));
      queue.enqueue({ ...fakeQueueEntry("done", "media-1", 4), status: "completed" });

      expect(queue.move("first", "up")).toBe(false);
      expect(queue.move("first", "down")).toBe(true);
      expect(queue.list().map((entry) => entry.id)).toEqual(["active", "second", "first", "done"]);
      expect(queue.move("first", "up")).toBe(true);
      expect(queue.list().map((entry) => entry.id)).toEqual(["active", "first", "second", "done"]);
    });
  });

  it("stores commands, events, settings, and soft deletes", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const commands = new CommandRepository(db);
      const events = new PlaybackEventRepository(db);
      const settings = new SettingsRepository(db);

      media.create(fakeMedia("media-1"));
      commands.create({
        id: "command-1",
        type: "play",
        issuedAt: now,
        issuedBy: "test",
        status: "pending"
      });
      events.append({
        id: "event-1",
        mediaItemId: "media-1",
        type: "test-event",
        details: { ok: true },
        createdAt: now
      });
      settings.set("timezone", { value: "UTC" }, now);
      media.softDelete("media-1", now);

      expect(commands.listPending()).toHaveLength(1);
      expect(events.listRecent(5)[0]?.details).toEqual({ ok: true });
      expect(settings.get("timezone")).toEqual({ value: "UTC" });
      expect(media.get("media-1")).toBeUndefined();
    });
  });

  it("stores appliance heartbeat status", () => {
    withMigratedDatabase((db) => {
      const appliances = new ApplianceRepository(db);

      appliances.heartbeat("appliance-1", "Living Room", now, {
        phase: "idle",
        lastHeartbeatAt: now,
        recoveryAttempt: 0
      });

      expect(appliances.latest(new Date(now))).toMatchObject({
        applianceId: "appliance-1",
        name: "Living Room",
        connected: true,
        playbackState: { phase: "idle" }
      });
    });
  });
});

function withMigratedDatabase(
  test: (db: ReturnType<typeof openDatabase>, filename: string) => void
): void {
  withDatabase((filename) => {
    const db = openDatabase(filename);
    try {
      migrate(db);
      test(db, filename);
    } finally {
      db.close();
    }
  });
}

function withDatabase(test: (filename: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "caretv-db-"));
  try {
    test(join(root, "caretv.sqlite"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fakeMedia(id: string): MediaItem {
  return {
    id,
    title: `Fake ${id}`,
    service: "fake",
    mediaType: "video",
    enabled: true,
    repeatable: true,
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
}

function fakeQueueEntry(id: string, mediaItemId: string, position: number): QueueEntry {
  return {
    id,
    mediaItemId,
    position,
    status: "queued",
    priority: 0,
    attemptCount: 0
  };
}
