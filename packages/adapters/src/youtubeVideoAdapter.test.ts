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
    expect(page.centerClickSelectors).toContain(".ytp-fullscreen-button");
  });
});

class FakeBrowserPage implements BrowserPage {
  public readonly evaluations: string[] = [];
  public readonly centerClickSelectors: string[] = [];

  public clickByText(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public clickCenterFirst(selectors: string[]): Promise<boolean> {
    this.centerClickSelectors.push(...selectors);
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
    if (expression.includes("ytp-fullscreen")) {
      return Promise.resolve(false as T);
    }
    return Promise.resolve(undefined as T);
  }

  public pressKey(): Promise<void> {
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
