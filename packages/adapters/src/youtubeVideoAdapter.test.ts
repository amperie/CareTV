import { describe, expect, it } from "vitest";

import type { MediaItem } from "@caretv/core";

import type { AdapterContext, AdapterLogger } from "./contract.js";
import { YouTubeVideoAdapter } from "./youtubeVideoAdapter.js";
import type { BrowserPage } from "./browserPage.js";

const logger: AdapterLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

describe("youtube video adapter", () => {
  it("opens a canonical watch URL and starts from the beginning", async () => {
    const page = new FakeBrowserPage();
    let openedUrl = "";
    const adapter = new YouTubeVideoAdapter({
      openPage: (url) => {
        openedUrl = url;
        return Promise.resolve(page);
      }
    });
    const context = youtubeContext("https://youtu.be/abc123?t=85");

    await adapter.prepare(context);
    await adapter.start(context);

    expect(openedUrl).toBe("https://www.youtube.com/watch?v=abc123");
    expect(page.evaluations.some((expression) => expression.includes("currentTime = 0"))).toBe(
      true
    );
    expect(
      page.evaluations.some((expression) => expression.includes("caretv-youtube-full-window"))
    ).toBe(true);
    expect(page.centerClickSelectors).toHaveLength(0);
    expect(page.pressKeyCount).toBe(0);
  });

  it("does not toggle fullscreen off when called repeatedly", async () => {
    const page = new FakeBrowserPage();
    const adapter = new YouTubeVideoAdapter({
      openPage: () => Promise.resolve(page)
    });
    const context = youtubeContext("https://youtu.be/abc123");

    await adapter.prepare(context);
    await adapter.start(context);
    await adapter.enterFullscreen(context);

    expect(page.centerClickSelectors).toHaveLength(0);
    expect(page.pressKeyCount).toBe(0);
  });
});

class FakeBrowserPage implements BrowserPage {
  public readonly evaluations: string[] = [];
  public readonly centerClickSelectors: string[] = [];
  public pressKeyCount = 0;
  private fullscreen = false;

  public bringToFront(): Promise<void> {
    return Promise.resolve();
  }

  public clickByText(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public clickCenterFirst(selectors: string[]): Promise<boolean> {
    this.centerClickSelectors.push(...selectors);
    this.fullscreen = true;
    return Promise.resolve(true);
  }

  public clickFirst(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  public evaluate<T>(expression: string): Promise<T> {
    this.evaluations.push(expression);
    if (expression.includes("caretv-youtube-full-window")) {
      this.fullscreen = true;
    }
    if (expression.includes("ytp-fullscreen")) {
      return Promise.resolve(this.fullscreen as T);
    }
    return Promise.resolve(undefined as T);
  }

  public pressKey(): Promise<void> {
    this.pressKeyCount += 1;
    this.fullscreen = !this.fullscreen;
    return Promise.resolve();
  }

  public waitForSelector(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function youtubeContext(url: string): AdapterContext {
  return {
    logger,
    mediaItem: youtubeMedia(url),
    signal: new AbortController().signal,
    now: () => new Date()
  };
}

function youtubeMedia(url: string): MediaItem {
  return {
    id: "youtube-1",
    title: "YouTube",
    service: "youtube",
    mediaType: "video",
    url,
    enabled: true,
    repeatable: true,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
