import type { MediaItem } from "@caretv/core";

import { ChromeBrowser, type BrowserPage, type ChromeBrowserOptions } from "./browserPage.js";
import type {
  AdapterContext,
  PlaybackObservation,
  RecoveryResult,
  StreamingAdapter
} from "./contract.js";
import { observationFromPrimeDom, primeSelectors, type PrimeDomState } from "./primeSelectors.js";
import { durationSecondsFor } from "./videoObservation.js";

interface PrimeSession {
  page?: BrowserPage;
}

export interface PrimeVideoAdapterOptions extends ChromeBrowserOptions {
  openPage?: (url: string) => Promise<BrowserPage>;
}

export class PrimeVideoAdapter implements StreamingAdapter {
  public readonly id = "prime";
  public readonly version = "0.1.0";

  private readonly openPage: (url: string) => Promise<BrowserPage>;
  private readonly sessions = new Map<string, PrimeSession>();

  public constructor(options: PrimeVideoAdapterOptions = {}) {
    const browser = options.openPage
      ? undefined
      : new ChromeBrowser({
          ...(options.chromePath ? { chromePath: options.chromePath } : {}),
          ...(options.remoteDebuggingPort
            ? { remoteDebuggingPort: options.remoteDebuggingPort }
            : {}),
          ...(options.userDataDir ? { userDataDir: options.userDataDir } : {})
        });
    this.openPage = options.openPage ?? ((url) => browser!.open(url));
  }

  public supports(item: MediaItem): boolean {
    return item.service === "prime" && Boolean(item.url);
  }

  public prepare(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    const url = primeUrlFor(context.mediaItem);

    if (!isPrimeUrl(url)) {
      throw new Error(`Prime media item ${context.mediaItem.id} must use an Amazon Prime URL.`);
    }

    this.sessions.set(context.mediaItem.id, {});
    return Promise.resolve();
  }

  public async start(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    const session = this.session(context);
    const page = (session.page ??= await this.openPage(primeUrlFor(context.mediaItem)));
    await page.waitForSelector([primeSelectors.video, ...primeSelectors.playButton]);
    await page.clickFirst(primeSelectors.playButton);
    await page.clickByText(["play", "resume", "continue watching"]);
    await page.evaluate<void>(`(() => {
      const video = document.querySelector("${primeSelectors.video}");
      if (video) return video.play().catch(() => undefined);
    })()`);
  }

  public async pause(context: AdapterContext): Promise<void> {
    await this.session(context).page?.evaluate<void>(
      `document.querySelector("${primeSelectors.video}")?.pause()`
    );
  }

  public async restart(context: AdapterContext): Promise<void> {
    await this.session(context).page?.evaluate<void>(`(() => {
      const video = document.querySelector("${primeSelectors.video}");
      if (!video) return;
      video.currentTime = 0;
      return video.play().catch(() => undefined);
    })()`);
  }

  public async resume(context: AdapterContext): Promise<void> {
    await this.session(context).page?.evaluate<void>(
      `document.querySelector("${primeSelectors.video}")?.play().catch(() => undefined)`
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

    await page.waitForSelector([primeSelectors.video, ...primeSelectors.fullscreenButton], 5_000);

    if (await page.clickFirst(primeSelectors.fullscreenButton)) {
      return;
    }

    await page.evaluate<void>(
      `document.querySelector("${primeSelectors.video}")?.requestFullscreen?.()`
    );
  }

  public async observe(context: AdapterContext): Promise<PlaybackObservation> {
    throwIfAborted(context.signal);
    const page = this.session(context).page;

    if (!page) {
      return { status: "ready", positionSeconds: 0 };
    }

    const state = await page.evaluate<PrimeDomState>(`(() => {
      const video = document.querySelector("${primeSelectors.video}");
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
    return observationFromPrimeDom(state, durationSecondsFor(context.mediaItem));
  }

  public async dismissKnownInterruptions(context: AdapterContext): Promise<boolean> {
    const page = this.session(context).page;

    if (!page) {
      return false;
    }

    return page.clickByText(["continue watching", "not now"]);
  }

  public async recover(context: AdapterContext, attempt: number): Promise<RecoveryResult> {
    if (attempt > 3) {
      return { recovered: false, message: "Prime browser recovery limit reached." };
    }

    const session = this.session(context);
    await session.page?.close().catch(() => undefined);
    delete session.page;
    await this.start(context);
    await this.resume(context);
    await this.enterFullscreen(context);
    return { recovered: true, message: "Prime browser relaunched." };
  }

  public async cleanup(context: AdapterContext): Promise<void> {
    const session = this.sessions.get(context.mediaItem.id);
    await session?.page?.close();
    this.sessions.delete(context.mediaItem.id);
  }

  private session(context: AdapterContext): PrimeSession {
    const session = this.sessions.get(context.mediaItem.id);

    if (!session) {
      throw new Error(`Prime session was not prepared for ${context.mediaItem.id}`);
    }

    return session;
  }
}

function isPrimeUrl(input: string): boolean {
  try {
    const host = new URL(input).hostname;
    return host.includes("amazon.") || host.endsWith("primevideo.com");
  } catch {
    return false;
  }
}

function primeUrlFor(item: MediaItem): string {
  if (!item.url) {
    throw new Error(`Prime media item ${item.id} has no URL.`);
  }

  return item.url;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Adapter operation was aborted.");
  }
}
