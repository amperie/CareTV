import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MediaItem, QueueEntry } from "@caretv/core";

import { ApplianceRepository } from "./applianceRepository.js";
import { CommandRepository } from "./commandRepository.js";
import { migrate, openDatabase } from "./database.js";
import { MediaRepository } from "./mediaRepository.js";
import { MediaDownloadRepository } from "./mediaDownloadRepository.js";
import { MediaDeletionRepository } from "./mediaDeletionRepository.js";
import { PlaybackEventRepository } from "./playbackEventRepository.js";
import { PlaylistRepository, playlistItems } from "./playlistRepository.js";
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

  it("persists playlists across reopen", () => {
    withDatabase((filename) => {
      let db = openDatabase(filename);
      migrate(db);
      const media = new MediaRepository(db);
      const playlists = new PlaylistRepository(db);

      media.create(fakeMedia("media-1"));
      media.create(fakeMedia("media-2"));
      playlists.create({
        id: "playlist-1",
        name: "Morning",
        items: playlistItems("playlist-1", ["media-1", "media-2"]),
        createdAt: now,
        updatedAt: now
      });
      db.close();

      db = openDatabase(filename);
      migrate(db);
      expect(new PlaylistRepository(db).get("playlist-1")).toMatchObject({
        name: "Morning",
        items: [
          { mediaItemId: "media-1", position: 1 },
          { mediaItemId: "media-2", position: 2 }
        ]
      });
      db.close();
    });
  });

  it("updates playlist names and ordered items", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const playlists = new PlaylistRepository(db);

      media.create(fakeMedia("media-1"));
      media.create(fakeMedia("media-2"));
      media.create(fakeMedia("media-3"));
      playlists.create({
        id: "playlist-1",
        name: "Old",
        items: playlistItems("playlist-1", ["media-1"]),
        createdAt: now,
        updatedAt: now
      });

      expect(playlists.update("playlist-1", "Updated", ["media-3", "media-2"], now)).toBe(true);
      expect(playlists.get("playlist-1")).toMatchObject({
        name: "Updated",
        items: [
          { mediaItemId: "media-3", position: 1 },
          { mediaItemId: "media-2", position: 2 }
        ]
      });
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
      expect(queue.selectNextQueued(now)).toBeUndefined();
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

  it("only reconciles active queue state older than the threshold", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({
        ...fakeQueueEntry("entry-1", "media-1", 1),
        startedAt: now,
        status: "playing"
      });

      expect(
        queue.reconcileStaleActive("skipped", "appliance-idle", "2025-12-31T23:59:59.000Z")
      ).toBe(0);
      expect(queue.get("entry-1")).toMatchObject({ status: "playing" });
      expect(
        queue.reconcileStaleActive("skipped", "appliance-idle", "2026-01-01T00:00:01.000Z")
      ).toBe(1);
      expect(queue.get("entry-1")).toMatchObject({
        status: "skipped",
        lastErrorCode: "appliance-idle"
      });
    });
  });
  it("rejects competing active playback updates", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({ ...fakeQueueEntry("active", "media-1", 1), status: "playing" });
      queue.enqueue(fakeQueueEntry("current", "media-1", 2));

      expect(queue.updateStatus("current", "playing")).toBe(false);
      expect(queue.get("active")).toMatchObject({ status: "playing" });
      expect(queue.get("current")).toMatchObject({ status: "queued" });
    });
  });

  it("returns the current active queue entry", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue(fakeQueueEntry("queued", "media-1", 1));
      queue.enqueue({ ...fakeQueueEntry("active", "media-1", 2), status: "playing" });

      expect(queue.active()).toMatchObject({ id: "active", mediaItemId: "media-1" });
    });
  });

  it("does not overwrite terminal queue status", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({
        ...fakeQueueEntry("failed", "media-1", 1),
        status: "failed",
        lastErrorCode: "agent-error"
      });

      expect(queue.updateStatus("failed", "completed")).toBe(false);
      expect(queue.get("failed")).toMatchObject({
        status: "failed",
        lastErrorCode: "agent-error"
      });
    });
  });

  it("requeues terminal entries without creating duplicates", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({
        ...fakeQueueEntry("completed", "media-1", 1),
        status: "completed",
        completedAt: now
      });

      expect(queue.runnableCount()).toBe(0);
      expect(queue.requeueCompleted("completed")).toBe(true);
      expect(queue.list()).toHaveLength(1);
      expect(queue.get("completed")).toMatchObject({
        status: "queued",
        position: 1
      });
      expect(queue.get("completed")?.completedAt).toBeUndefined();
      expect(queue.runnableCount()).toBe(1);
    });
  });

  it("removes terminal queue entries", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);
      const events = new PlaybackEventRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({
        ...fakeQueueEntry("skipped", "media-1", 1),
        status: "skipped",
        completedAt: now
      });
      events.append({
        id: "event-1",
        queueEntryId: "skipped",
        mediaItemId: "media-1",
        type: "playback-state",
        details: {},
        createdAt: now
      });

      expect(queue.remove("skipped")).toBe(true);
      expect(queue.get("skipped")).toBeUndefined();
      expect(events.listRecent(1)[0]?.queueEntryId).toBeUndefined();
    });
  });

  it("clears only failed queue entries", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({ ...fakeQueueEntry("failed", "media-1", 1), status: "failed" });
      queue.enqueue({ ...fakeQueueEntry("completed", "media-1", 2), status: "completed" });
      queue.enqueue({ ...fakeQueueEntry("skipped", "media-1", 3), status: "skipped" });
      queue.enqueue(fakeQueueEntry("queued", "media-1", 4));

      expect(queue.clearFailed()).toBe(1);
      expect(queue.list().map((entry) => entry.id)).toEqual(["completed", "skipped", "queued"]);
    });
  });

  it("requeues all completed entries in their original order", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue({
        ...fakeQueueEntry("completed", "media-1", 1),
        status: "completed",
        completedAt: now
      });
      queue.enqueue({
        ...fakeQueueEntry("skipped", "media-1", 2),
        status: "skipped",
        completedAt: now
      });

      expect(queue.requeueCompletedEntries()).toBe(2);
      expect(queue.list()).toMatchObject([
        { id: "completed", status: "queued", position: 1 },
        { id: "skipped", status: "queued", position: 2 }
      ]);
      expect(queue.runnableCount()).toBe(2);
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

  it("promotes queued and completed entries to play next", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const queue = new QueueRepository(db);

      media.create(fakeMedia("media-1"));
      queue.enqueue(fakeQueueEntry("first", "media-1", 1));
      queue.enqueue(fakeQueueEntry("second", "media-1", 2));
      queue.enqueue({ ...fakeQueueEntry("done", "media-1", 3), status: "completed" });

      expect(queue.promoteToNext("second")).toBe(true);
      expect(queue.selectNextQueued(now)?.id).toBe("second");
      expect(queue.promoteToNext("done")).toBe(true);
      expect(queue.get("done")).toMatchObject({ status: "queued" });
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

  it("can tombstone a deleted local media path", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);
      const localPath = "C:\\CareTV\\media\\movie.mov";

      media.upsert({
        ...fakeMedia("local-1"),
        service: "local",
        mediaType: "local-file",
        localPath
      });

      expect(media.deletedLocalPathExists(localPath)).toBe(false);
      expect(media.softDeleteLocalPath(localPath, now)).toBe(1);
      expect(media.deletedLocalPathExists(localPath)).toBe(true);
    });
  });

  it("finds active streaming media by service URL", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);

      media.create({
        ...fakeMedia("youtube-1"),
        service: "youtube",
        mediaType: "video",
        url: "https://www.youtube.com/watch?v=abc123"
      });

      expect(
        media.getByServiceUrl("youtube", "https://www.youtube.com/watch?v=abc123")
      ).toMatchObject({
        id: "youtube-1",
        title: "Fake youtube-1"
      });
      media.softDelete("youtube-1", now);
      expect(
        media.getByServiceUrl("youtube", "https://www.youtube.com/watch?v=abc123")
      ).toBeUndefined();
    });
  });

  it("updates observed media duration", () => {
    withMigratedDatabase((db) => {
      const media = new MediaRepository(db);

      media.create({
        ...fakeMedia("youtube-1"),
        service: "youtube",
        mediaType: "video",
        url: "https://www.youtube.com/watch?v=abc123"
      });

      expect(media.updateExpectedDuration("youtube-1", 7212, now)).toBe(true);
      expect(media.get("youtube-1")).toMatchObject({
        expectedDurationSeconds: 7212,
        metadata: { durationObserved: 1 }
      });
    });
  });

  it("upserts local media and tracks appliance downloads", () => {
    withMigratedDatabase((db) => {
      const downloads = new MediaDownloadRepository(db);
      const media = new MediaRepository(db);

      media.upsert({
        ...fakeMedia("local-1"),
        service: "local",
        mediaType: "local-file",
        localPath: "C:\\CareTV\\media\\movie.mp4",
        metadata: { sizeBytes: 100 }
      });
      downloads.create({
        id: "download-1",
        mediaItemId: "local-1",
        filename: "movie.mp4",
        sourcePath: "C:\\CareTV\\runtime\\uploads\\movie.mp4",
        status: "pending",
        createdAt: now
      });

      expect(media.get("local-1")).toMatchObject({
        service: "local",
        localPath: "C:\\CareTV\\media\\movie.mp4"
      });
      expect(downloads.listPending()).toMatchObject([{ id: "download-1" }]);
      expect(downloads.complete("download-1", now)).toBe(true);
      expect(downloads.listPending()).toEqual([]);
    });
  });

  it("tracks appliance media deletions", () => {
    withMigratedDatabase((db) => {
      const deletions = new MediaDeletionRepository(db);

      deletions.create({
        id: "deletion-1",
        localPath: "C:\\CareTV\\media\\movie.mov",
        status: "pending",
        createdAt: now
      });

      expect(deletions.listPending()).toMatchObject([{ id: "deletion-1" }]);
      expect(deletions.complete("deletion-1", now)).toBe(true);
      expect(deletions.listPending()).toEqual([]);
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
