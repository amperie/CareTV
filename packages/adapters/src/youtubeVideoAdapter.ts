import type { MediaItem } from "@caretv/core";

import { ChromeBrowser, type BrowserPage, type ChromeBrowserOptions } from "./browserPage.js";
import type {
  AdapterContext,
  PlaybackObservation,
  RecoveryResult,
  StreamingAdapter
} from "./contract.js";
import { durationSecondsFor } from "./videoObservation.js";
import {
  observationFromYouTubeDom,
  youtubeSelectors,
  type YouTubeDomState
} from "./youtubeSelectors.js";

interface YouTubeSession {
  page?: BrowserPage;
}

export interface YouTubeVideoAdapterOptions extends ChromeBrowserOptions {
  openPage?: (url: string) => Promise<BrowserPage>;
}

export class YouTubeVideoAdapter implements StreamingAdapter {
  public readonly id = "youtube";
  public readonly version = "0.1.0";

  private readonly openPage: (url: string) => Promise<BrowserPage>;
  private readonly sessions = new Map<string, YouTubeSession>();

  public constructor(options: YouTubeVideoAdapterOptions = {}) {
    const browser = options.openPage
      ? undefined
      : new ChromeBrowser({
          ...(options.chromePath ? { chromePath: options.chromePath } : {}),
          ...(options.remoteDebuggingPort ? { remoteDebuggingPort: options.remoteDebuggingPort } : {}),
          ...(options.userDataDir ? { userDataDir: options.userDataDir } : {})
        });
    this.openPage = options.openPage ?? ((url) => browser!.open(url));
  }

  public supports(item: MediaItem): boolean {
    return item.service === "youtube" && Boolean(item.url);
  }

  public prepare(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    const url = youtubeUrlFor(context.mediaItem);

    if (!isYouTubeUrl(url)) {
      throw new Error(`YouTube media item ${context.mediaItem.id} must use a YouTube URL.`);
    }

    this.sessions.set(context.mediaItem.id, {});
    return Promise.resolve();
  }

  public async start(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    const session = this.session(context);
    const page = (session.page ??= await this.openPage(
      normalizeYouTubeUrl(youtubeUrlFor(context.mediaItem))
    ));
    await this.dismissKnownInterruptions(context);
    await page.clickFirst(youtubeSelectors.playButton);
    await page.clickByText(["play"]);
    await page.evaluate<void>(
      `document.querySelector("${youtubeSelectors.video}")?.play().catch(() => undefined)`
    );
  }

  public async pause(context: AdapterContext): Promise<void> {
    await this.session(context).page?.evaluate<void>(
      `document.querySelector("${youtubeSelectors.video}")?.pause()`
    );
  }

  public async resume(context: AdapterContext): Promise<void> {
    await this.dismissKnownInterruptions(context);
    await this.session(context).page?.evaluate<void>(
      `document.querySelector("${youtubeSelectors.video}")?.play().catch(() => undefined)`
    );
  }

  public async stop(context: AdapterContext): Promise<void> {
    await this.pause(context);
  }

  public async enterFullscreen(context: AdapterContext): Promise<void> {
    const page = this.session(context).page;

    if (!page) {
      return;
    }

    if (await page.clickFirst(youtubeSelectors.fullscreenButton)) {
      return;
    }

    await page.evaluate<void>(`document.querySelector("${youtubeSelectors.video}")?.requestFullscreen?.()`);
  }

  public async observe(context: AdapterContext): Promise<PlaybackObservation> {
    throwIfAborted(context.signal);
    const page = this.session(context).page;

    if (!page) {
      return { status: "ready", positionSeconds: 0 };
    }

    await this.dismissKnownInterruptions(context);
    const state = await page.evaluate<YouTubeDomState>(`(() => {
      const video = document.querySelector("${youtubeSelectors.video}");
      return {
        currentTime: video?.currentTime,
        duration: Number.isFinite(video?.duration) ? video.duration : undefined,
        ended: video?.ended,
        fullscreen: document.fullscreenElement === video,
        hasVideo: Boolean(video),
        paused: video?.paused,
        readyState: video?.readyState,
        text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim()
      };
    })()`);
    return observationFromYouTubeDom(state, durationSecondsFor(context.mediaItem, 900));
  }

  public async dismissKnownInterruptions(context: AdapterContext): Promise<boolean> {
    const page = this.session(context).page;

    if (!page) {
      return false;
    }

    const skippedAd = await page.clickFirst(youtubeSelectors.skipAdButton);
    const dismissed = await page.clickByText(["skip ads", "skip ad", "no thanks", "not now", "i agree"]);
    return skippedAd || dismissed;
  }

  public recover(): Promise<RecoveryResult> {
    return Promise.resolve({ recovered: false, message: "YouTube recovery is not implemented yet." });
  }

  public async cleanup(context: AdapterContext): Promise<void> {
    const session = this.sessions.get(context.mediaItem.id);
    await session?.page?.close();
    this.sessions.delete(context.mediaItem.id);
  }

  private session(context: AdapterContext): YouTubeSession {
    const session = this.sessions.get(context.mediaItem.id);

    if (!session) {
      throw new Error(`YouTube session was not prepared for ${context.mediaItem.id}`);
    }

    return session;
  }
}

function isYouTubeUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname.replace(/^www\./, "");
    return host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

function normalizeYouTubeUrl(input: string): string {
  const url = new URL(input);

  if (url.hostname.replace(/^www\./, "") === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];

    if (id) {
      return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
  }

  return url.href;
}

function youtubeUrlFor(item: MediaItem): string {
  if (!item.url) {
    throw new Error(`YouTube media item ${item.id} has no URL.`);
  }

  return item.url;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Adapter operation was aborted.");
  }
}
