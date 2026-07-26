import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeStreamingAdapter } from "@caretv/adapters";
import type { MediaItem, PlaybackCommand, QueueEntry } from "@caretv/core";
import {
  CommandRepository,
  MediaRepository,
  migrate,
  openDatabase,
  PlaybackEventRepository,
  QueueRepository
} from "@caretv/database";
import { PlaybackAgent } from "@caretv/playback-agent";
import { describe, expect, it } from "vitest";

const baseTime = "2026-01-01T00:00:00.000Z";
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe("playback e2e", () => {
  it("plays queued items sequentially through persisted media, queue, and events", async () => {
    await withHarness(async (harness) => {
      harness.media.create(fakeMedia("media-1", { durationSeconds: 2 }));
      harness.media.create(fakeMedia("media-2", { durationSeconds: 2 }));
      harness.queue.enqueue(fakeQueueEntry("queue-1", "media-1", 1));
      harness.queue.enqueue(fakeQueueEntry("queue-2", "media-2", 2));

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-1"
      });
      expect(harness.queue.get("queue-1")).toMatchObject({ status: "completed" });
      expect(harness.queue.get("queue-2")).toMatchObject({ status: "queued" });

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-2"
      });
      expect(harness.queue.list()).toMatchObject([
        { id: "queue-1", status: "completed" },
        { id: "queue-2", status: "completed" }
      ]);
      expect(
        harness.events.listRecent(20).filter((event) => event.type === "COMPLETED")
      ).toHaveLength(2);
    });
  });

  it("does not claim a second item while another queue entry is active", async () => {
    await withHarness(async (harness) => {
      harness.media.create(fakeMedia("media-1", { durationSeconds: 2 }));
      harness.media.create(fakeMedia("media-2", { durationSeconds: 2 }));
      harness.queue.enqueue({ ...fakeQueueEntry("active", "media-1", 1), status: "playing" });
      harness.queue.enqueue(fakeQueueEntry("queued", "media-2", 2));

      expect(await harness.agent.runOnce()).toEqual({ status: "idle" });
      expect(harness.queue.get("queued")).toMatchObject({ status: "queued" });
    });
  });

  it("fails a targeted command for a different media item instead of leaking it forward", async () => {
    await withHarness(async (harness) => {
      harness.media.create(fakeMedia("media-1", { durationSeconds: 2 }));
      harness.media.create(fakeMedia("media-2", { durationSeconds: 2 }));
      harness.queue.enqueue(fakeQueueEntry("queue-1", "media-1", 1));
      harness.queue.enqueue(fakeQueueEntry("queue-2", "media-2", 2));
      harness.commands.create(fakeCommand("stop", "media-2"));

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-1"
      });
      expect(harness.commands.listByStatus("failed")).toMatchObject([{ id: "command-1" }]);
      expect(harness.commands.listPending()).toEqual([]);

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-2"
      });
      expect(harness.queue.get("queue-2")).toMatchObject({ status: "completed" });
    });
  });

  it("scopes active control commands to the current media item", async () => {
    await withHarness((harness) => {
      harness.media.create(fakeMedia("media-1", { durationSeconds: 20 }));
      harness.queue.enqueue(fakeQueueEntry("queue-1", "media-1", 1));
      const selected = harness.queue.selectNextQueued(baseTime);

      expect(selected).toMatchObject({ id: "queue-1", mediaItemId: "media-1" });
      expect(harness.queue.active()).toMatchObject({ id: "queue-1", mediaItemId: "media-1" });

      harness.commands.create(fakeCommand("skip", harness.queue.active()?.mediaItemId));
      expect(harness.commands.listPending()).toMatchObject([
        { type: "skip", mediaItemId: "media-1" }
      ]);
    });
  });
});

async function withHarness(test: (harness: Harness) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "caretv-e2e-"));
  const db = openDatabase(join(root, "caretv.sqlite"));

  try {
    migrate(db);
    await Promise.resolve(test(new Harness(db)));
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

class Harness {
  public readonly agent: PlaybackAgent;
  public readonly commands: CommandRepository;
  public readonly events: PlaybackEventRepository;
  public readonly media: MediaRepository;
  public readonly queue: QueueRepository;

  private id = 0;
  private seconds = 0;

  public constructor(db: ReturnType<typeof openDatabase>) {
    this.commands = new CommandRepository(db);
    this.events = new PlaybackEventRepository(db);
    this.media = new MediaRepository(db);
    this.queue = new QueueRepository(db);
    this.agent = new PlaybackAgent({
      adapters: [new FakeStreamingAdapter()],
      commands: this.commands,
      createId: () => this.nextId(),
      events: this.events,
      logger,
      maxObservations: 8,
      media: this.media,
      now: () => this.nextDate(),
      queue: this.queue
    });
  }

  private nextId(): string {
    this.id += 1;
    return `event-${this.id}`;
  }

  private nextDate(): Date {
    this.seconds += 1;
    return new Date(Date.parse(baseTime) + this.seconds * 1000);
  }
}

function fakeMedia(id: string, metadata: Record<string, unknown>): MediaItem {
  return {
    id,
    title: `Fake ${id}`,
    service: "fake",
    mediaType: "video",
    enabled: true,
    repeatable: true,
    metadata,
    createdAt: baseTime,
    updatedAt: baseTime
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

function fakeCommand(type: PlaybackCommand["type"], mediaItemId?: string): PlaybackCommand {
  return {
    id: "command-1",
    type,
    ...(mediaItemId ? { mediaItemId } : {}),
    issuedAt: baseTime,
    issuedBy: "test",
    status: "pending"
  };
}
