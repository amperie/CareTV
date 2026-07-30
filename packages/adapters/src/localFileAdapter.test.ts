import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MediaItem } from "@caretv/core";

import type { AdapterContext, AdapterLogger } from "./contract.js";
import { LocalFileAdapter, type PlayerPage } from "./localFileAdapter.js";

const logger: AdapterLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe("local file adapter", () => {
  it("controls a browser player and observes real player state", async () => {
    await withMediaFile(async (localPath) => {
      const page = new FakePlayerPage(5);
      let openedPath = "";
      const adapter = new LocalFileAdapter({
        openPlayer: (path) => {
          openedPath = path;
          return Promise.resolve(page);
        }
      });
      const context = localContext(localMedia(localPath, 60));

      expect(adapter.supports(context.mediaItem)).toBe(true);
      await adapter.prepare(context);
      expect(await adapter.observe(context)).toMatchObject({ status: "ready" });

      await adapter.start(context);
      await adapter.enterFullscreen(context);
      page.currentTime = 3;

      expect(await adapter.observe(context)).toMatchObject({
        status: "playing",
        positionSeconds: 3,
        durationSeconds: 5,
        fullscreen: true
      });
      expect(openedPath).toBe(localPath);
      expect(page.playCount).toBe(1);
    });
  });

  it("passes pause, resume, and stop through to the browser player", async () => {
    await withMediaFile(async (localPath) => {
      const page = new FakePlayerPage(10);
      const adapter = new LocalFileAdapter({ openPlayer: () => Promise.resolve(page) });
      const context = localContext(localMedia(localPath, 10));

      await adapter.prepare(context);
      await adapter.start(context);
      await adapter.pause(context);
      expect(await adapter.observe(context)).toMatchObject({ status: "paused" });

      await adapter.resume(context);
      expect(await adapter.observe(context)).toMatchObject({ status: "playing" });

      page.currentTime = 8;
      await adapter.restart(context);
      expect(await adapter.observe(context)).toMatchObject({
        positionSeconds: 0,
        status: "playing"
      });

      await adapter.stop(context);
      expect(await adapter.observe(context)).toMatchObject({ status: "completed" });

      await adapter.cleanup(context);
      expect(page.closed).toBe(true);
    });
  });

  it("rejects missing local files during preparation", async () => {
    const adapter = new LocalFileAdapter({
      openPlayer: () => Promise.resolve(new FakePlayerPage(1))
    });
    const context = localContext(localMedia("Z:\\missing.mp4", 10));

    await expect(adapter.prepare(context)).rejects.toThrow();
  });

  it("rejects directories and empty files during preparation", async () => {
    const root = mkdtempSync(join(tmpdir(), "caretv-local-adapter-"));
    const emptyPath = join(root, "empty.mp4");
    const directoryPath = join(root, "directory.mp4");
    writeFileSync(emptyPath, "");
    mkdirSync(directoryPath);

    try {
      const adapter = new LocalFileAdapter({
        openPlayer: () => Promise.resolve(new FakePlayerPage(1))
      });

      await expect(adapter.prepare(localContext(localMedia(emptyPath, 10)))).rejects.toThrow(
        /empty/
      );
      await expect(adapter.prepare(localContext(localMedia(directoryPath, 10)))).rejects.toThrow(
        /not a file/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when Chrome plays audio without decoded video frames", async () => {
    await withMediaFile(async (localPath) => {
      const page = new FakePlayerPage(10);
      const adapter = new LocalFileAdapter({ openPlayer: () => Promise.resolve(page) });
      const context = localContext(localMedia(localPath, 10));

      await adapter.prepare(context);
      await adapter.start(context);
      page.currentTime = 3;
      page.videoWidth = 0;
      page.videoHeight = 0;

      expect(await adapter.observe(context)).toMatchObject({
        errorCode: "local-file-video-track-unavailable",
        status: "error"
      });
    });
  });

  it("does not complete from fallback duration before the browser observes real duration", async () => {
    await withMediaFile(async (localPath) => {
      const page = new FakePlayerPage(undefined);
      const adapter = new LocalFileAdapter({ openPlayer: () => Promise.resolve(page) });
      const context = localContext(localMedia(localPath, 5));

      await adapter.prepare(context);
      await adapter.start(context);
      page.currentTime = 6;

      expect(await adapter.observe(context)).toMatchObject({
        details: { durationObserved: false },
        durationSeconds: 5,
        positionSeconds: 6,
        status: "playing"
      });

      page.ended = true;
      expect(await adapter.observe(context)).toMatchObject({ status: "completed" });
    });
  });

  it("returns useful player diagnostics when playback errors", async () => {
    await withMediaFile(async (localPath) => {
      const page = new FakePlayerPage(10);
      const adapter = new LocalFileAdapter({ openPlayer: () => Promise.resolve(page) });
      const context = localContext(localMedia(localPath, 10));

      await adapter.prepare(context);
      await adapter.start(context);
      page.error = "media-error-4";
      page.lastEvent = "error";
      page.networkState = 3;

      expect(await adapter.observe(context)).toMatchObject({
        details: {
          durationObserved: true,
          error: "media-error-4",
          lastEvent: "error",
          networkState: 3
        },
        errorCode: "local-file-playback-error",
        status: "error"
      });
    });
  });
});

class FakePlayerPage implements PlayerPage {
  public closed = false;
  public currentTime = 0;
  public fullscreen = false;
  public error: string | undefined;
  public lastEvent = "playing";
  public networkState = 1;
  public paused = true;
  public playCount = 0;
  public videoHeight = 720;
  public videoWidth = 1280;
  public ended = false;

  public constructor(private readonly duration: number | undefined) {}

  public close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  public enterFullscreen(): Promise<void> {
    this.fullscreen = true;
    return Promise.resolve();
  }

  public pause(): Promise<void> {
    this.paused = true;
    return Promise.resolve();
  }

  public play(): Promise<void> {
    this.paused = false;
    this.playCount += 1;
    return Promise.resolve();
  }

  public restart(): Promise<void> {
    this.currentTime = 0;
    this.ended = false;
    this.paused = false;
    return Promise.resolve();
  }

  public state(): Promise<Awaited<ReturnType<PlayerPage["state"]>>> {
    return Promise.resolve({
      currentTime: this.currentTime,
      ended: this.ended,
      fullscreen: this.fullscreen,
      lastEvent: this.lastEvent,
      networkState: this.networkState,
      paused: this.paused,
      readyState: 4,
      videoHeight: this.videoHeight,
      videoWidth: this.videoWidth,
      ...(this.duration !== undefined ? { duration: this.duration } : {}),
      ...(this.error !== undefined ? { error: this.error } : {})
    });
  }

  public stop(): Promise<void> {
    this.ended = true;
    this.currentTime = this.duration ?? this.currentTime;
    this.paused = true;
    return Promise.resolve();
  }
}

async function withMediaFile(test: (localPath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "caretv-local-adapter-"));
  const localPath = join(root, "sample.mp4");
  writeFileSync(localPath, "not a real video, but enough for file validation");

  try {
    await test(localPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function localContext(mediaItem: MediaItem): AdapterContext {
  return {
    logger,
    mediaItem,
    signal: new AbortController().signal,
    now: () => new Date()
  };
}

function localMedia(localPath: string, durationSeconds: number): MediaItem {
  return {
    id: "media-1",
    title: "Local media",
    service: "local",
    mediaType: "local-file",
    localPath,
    expectedDurationSeconds: durationSeconds,
    enabled: true,
    repeatable: true,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
