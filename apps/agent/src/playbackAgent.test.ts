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
import { describe, expect, it } from "vitest";

import { PlaybackAgent } from "./playbackAgent.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe("PlaybackAgent", () => {
  it("plays one fake queue entry to completion", async () => {
    await withHarness(async (harness) => {
      harness.media.create(fakeMedia({ durationSeconds: 2 }));
      harness.queue.enqueue(fakeQueueEntry());

      const result = await harness.agent.runOnce();

      expect(result).toEqual({ status: "completed", queueEntryId: "queue-1" });
      expect(harness.queue.get("queue-1")).toMatchObject({
        status: "completed"
      });
      expect(harness.events.listRecent(20).map((event) => event.type)).toContain("COMPLETED");
    });
  });

  it("fails cleanly when no adapter supports the media item", async () => {
    await withHarness(async (harness) => {
      harness.media.create({ ...fakeMedia({}), service: "prime" });
      harness.queue.enqueue(fakeQueueEntry());

      expect(await harness.agent.runOnce()).toEqual({
        status: "failed",
        queueEntryId: "queue-1",
        errorCode: "adapter-not-found"
      });
    });
  });

  it("applies a pending skip command", async () => {
    await withHarness(async (harness) => {
      harness.media.create(fakeMedia({ durationSeconds: 30 }));
      harness.queue.enqueue(fakeQueueEntry());
      harness.commands.create(fakeCommand("skip"));

      expect(await harness.agent.runOnce()).toEqual({ status: "skipped", queueEntryId: "queue-1" });
      expect(harness.queue.get("queue-1")).toMatchObject({ status: "skipped" });
    });
  });
});

async function withHarness(test: (harness: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "caretv-agent-"));
  const db = openDatabase(join(root, "caretv.sqlite"));

  try {
    migrate(db);
    const harness = new Harness(db);
    await test(harness);
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
      maxObservations: 5,
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
    return new Date(Date.parse("2026-01-01T00:00:00.000Z") + this.seconds * 1000);
  }
}

function fakeMedia(metadata: Record<string, unknown>): MediaItem {
  return {
    id: "media-1",
    title: "Fake media",
    service: "fake",
    mediaType: "video",
    enabled: true,
    repeatable: true,
    metadata,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function fakeQueueEntry(): QueueEntry {
  return {
    id: "queue-1",
    mediaItemId: "media-1",
    position: 1,
    status: "queued",
    priority: 0,
    attemptCount: 0
  };
}

function fakeCommand(type: PlaybackCommand["type"]): PlaybackCommand {
  return {
    id: "command-1",
    type,
    issuedAt: "2026-01-01T00:00:00.000Z",
    issuedBy: "test",
    status: "pending"
  };
}
