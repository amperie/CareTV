import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserPageClosedCode, FakeStreamingAdapter } from "@caretv/adapters";
import type { PlaybackObservation, RecoveryResult, StreamingAdapter } from "@caretv/adapters";
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
      expect(harness.queue.get("queue-1")).toMatchObject({ status: "completed" });
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

  it("rejects a stale pause command before playback starts", async () => {
    await withHarness(async (harness) => {
      harness.media.create(fakeMedia({ durationSeconds: 2 }));
      harness.queue.enqueue(fakeQueueEntry());
      harness.commands.create(fakeCommand("pause"));

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-1"
      });
      expect(harness.commands.listPending()).toEqual([]);
      expect(harness.queue.get("queue-1")).toMatchObject({ status: "completed" });
    });
  });

  it("resumes an unintentionally paused adapter instead of leaving playback paused", async () => {
    const adapter = new PausedThenPlayingAdapter();

    await withHarness(async (harness) => {
      harness.agent = harness.createAgent([adapter]);
      harness.media.create(fakeMedia({ durationSeconds: 2 }));
      harness.queue.enqueue(fakeQueueEntry());

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-1"
      });
      expect(adapter.resumeCount).toBeGreaterThan(0);
      expect(harness.queue.get("queue-1")).toMatchObject({ status: "completed" });
    });
  });

  it("re-enters fullscreen when active playback reports windowed video", async () => {
    const adapter = new WindowedThenCompletedAdapter();

    await withHarness(async (harness) => {
      harness.agent = harness.createAgent([adapter]);
      harness.media.create(fakeMedia({ durationSeconds: 2 }));
      harness.queue.enqueue(fakeQueueEntry());

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-1"
      });
      expect(adapter.fullscreenCount).toBeGreaterThan(1);
    });
  });

  it("recovers the current queue item when the browser page closes", async () => {
    const adapter = new BrowserClosedThenCompletedAdapter();

    await withHarness(async (harness) => {
      harness.agent = harness.createAgent([adapter]);
      harness.media.create(fakeMedia({ durationSeconds: 2 }));
      harness.queue.enqueue(fakeQueueEntry());

      expect(await harness.agent.runOnce()).toEqual({
        status: "completed",
        queueEntryId: "queue-1"
      });
      expect(adapter.recoverCount).toBe(1);
      expect(harness.queue.get("queue-1")).toMatchObject({ status: "completed" });
      expect(harness.events.listRecent(20).map((event) => event.type)).toContain("RECOVERING");
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
  public agent: PlaybackAgent;
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
    this.agent = this.createAgent([new FakeStreamingAdapter()]);
  }

  public createAgent(adapters: StreamingAdapter[]): PlaybackAgent {
    return new PlaybackAgent({
      adapters,
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

class PausedThenPlayingAdapter implements StreamingAdapter {
  public readonly id = "paused-then-playing";
  public readonly version = "0.1.0";
  public resumeCount = 0;
  private observations = 0;

  public supports(): boolean {
    return true;
  }

  public prepare(): Promise<void> {
    return Promise.resolve();
  }

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public pause(): Promise<void> {
    return Promise.resolve();
  }

  public restart(): Promise<void> {
    return Promise.resolve();
  }

  public resume(): Promise<void> {
    this.resumeCount += 1;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public enterFullscreen(): Promise<void> {
    return Promise.resolve();
  }

  public observe(): Promise<PlaybackObservation> {
    this.observations += 1;

    if (this.observations === 1) {
      return Promise.resolve({ status: "paused", positionSeconds: 0 });
    }

    return Promise.resolve({ status: "completed", positionSeconds: 2 });
  }

  public dismissKnownInterruptions(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public recover(): Promise<RecoveryResult> {
    return Promise.resolve({ recovered: false, message: "not implemented" });
  }

  public cleanup(): Promise<void> {
    return Promise.resolve();
  }
}

class WindowedThenCompletedAdapter implements StreamingAdapter {
  public readonly id = "windowed-then-completed";
  public readonly version = "0.1.0";
  public fullscreenCount = 0;
  private observations = 0;

  public supports(): boolean {
    return true;
  }

  public prepare(): Promise<void> {
    return Promise.resolve();
  }

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public pause(): Promise<void> {
    return Promise.resolve();
  }

  public restart(): Promise<void> {
    return Promise.resolve();
  }

  public resume(): Promise<void> {
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public enterFullscreen(): Promise<void> {
    this.fullscreenCount += 1;
    return Promise.resolve();
  }

  public observe(): Promise<PlaybackObservation> {
    this.observations += 1;

    if (this.observations === 1) {
      return Promise.resolve({ fullscreen: false, status: "playing", positionSeconds: 1 });
    }

    return Promise.resolve({ status: "completed", positionSeconds: 2 });
  }

  public dismissKnownInterruptions(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public recover(): Promise<RecoveryResult> {
    return Promise.resolve({ recovered: false, message: "not implemented" });
  }

  public cleanup(): Promise<void> {
    return Promise.resolve();
  }
}

class BrowserClosedThenCompletedAdapter implements StreamingAdapter {
  public readonly id = "browser-closed-then-completed";
  public readonly version = "0.1.0";
  public recoverCount = 0;
  private observations = 0;

  public supports(): boolean {
    return true;
  }

  public prepare(): Promise<void> {
    return Promise.resolve();
  }

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public pause(): Promise<void> {
    return Promise.resolve();
  }

  public restart(): Promise<void> {
    return Promise.resolve();
  }

  public resume(): Promise<void> {
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public enterFullscreen(): Promise<void> {
    return Promise.resolve();
  }

  public observe(): Promise<PlaybackObservation> {
    this.observations += 1;

    if (this.observations === 1) {
      return Promise.reject(new Error(browserPageClosedCode));
    }

    return Promise.resolve({ status: "completed", positionSeconds: 2 });
  }

  public dismissKnownInterruptions(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public recover(): Promise<RecoveryResult> {
    this.recoverCount += 1;
    return Promise.resolve({ recovered: true, message: "recovered" });
  }

  public cleanup(): Promise<void> {
    return Promise.resolve();
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
