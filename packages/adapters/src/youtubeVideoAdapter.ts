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
          ...(options.remoteDebuggingPort
            ? { remoteDebuggingPort: options.remoteDebuggingPort }
            : {}),
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
    if (isTerminalStartupObservation(await this.observe(context))) return;

    await page.waitForSelector([youtubeSelectors.video, ...youtubeSelectors.playButton], 5_000);
    if (isTerminalStartupObservation(await this.observe(context))) return;

    await this.dismissKnownInterruptions(context);
    await page.clickFirst(youtubeSelectors.playButton);
    await page.clickByText(["play"]);
    await startPlaybackFromBeginning(page);
    await this.enterFullscreen(context);
  }

  public async pause(context: AdapterContext): Promise<void> {
    await this.session(context).page?.evaluate<void>(
      `document.querySelector("${youtubeSelectors.video}")?.pause()`
    );
  }

  public async restart(context: AdapterContext): Promise<void> {
    await this.dismissKnownInterruptions(context);
    const page = this.session(context).page;

    if (page) {
      await startPlaybackFromBeginning(page);
      await this.enterFullscreen(context);
    }
  }

  public async resume(context: AdapterContext): Promise<void> {
    await this.dismissKnownInterruptions(context);
    await this.session(context).page?.evaluate<void>(
      `document.querySelector("${youtubeSelectors.video}")?.play()?.catch?.(() => undefined)`
    );
    await this.enterFullscreen(context);
  }

  public async stop(context: AdapterContext): Promise<void> {
    await this.pause(context);
  }

  public async enterFullscreen(context: AdapterContext): Promise<void> {
    const page = this.session(context).page;

    if (!page) {
      return;
    }

    await page.waitForSelector(
      [youtubeSelectors.video, ...youtubeSelectors.fullscreenButton],
      5_000
    );

    await page.setWindowFullscreen();
    await forceYouTubeViewport(page);

    if (await youtubeFullscreen(page)) {
      return;
    }

    if (await page.clickCenterFirst(youtubeSelectors.fullscreenButton)) {
      await wait(500);
    }

    if (await youtubeFullscreen(page)) {
      return;
    }

    await page.evaluate<void>(`(() => {
      document.querySelector(".html5-video-player")?.focus?.();
      document.querySelector("${youtubeSelectors.video}")?.focus?.();
    })()`);
    await page.pressKey("f");
    await wait(500);

    if (await youtubeFullscreen(page)) {
      return;
    }

    if (await page.clickFirst(youtubeSelectors.fullscreenButton)) {
      await wait(500);
    }

    if (await youtubeFullscreen(page)) {
      return;
    }

    await page.evaluate<void>(`(() => {
      if (document.fullscreenElement) return;
      const player = document.querySelector(".html5-video-player");
      const video = document.querySelector("${youtubeSelectors.video}");
      return (player?.requestFullscreen?.() ?? video?.requestFullscreen?.())?.catch?.(() => undefined);
    })()`);
  }

  public async observe(context: AdapterContext): Promise<PlaybackObservation> {
    throwIfAborted(context.signal);
    const page = this.session(context).page;

    if (!page) {
      return { status: "ready", positionSeconds: 0 };
    }

    await this.dismissKnownInterruptions(context);
    const expectedVideoId = youTubeVideoId(youtubeUrlFor(context.mediaItem));
    const state = await page.evaluate<YouTubeDomState>(`(() => {
      const video = document.querySelector("${youtubeSelectors.video}");
      const player = document.querySelector(".html5-video-player");
      return {
        adShowing: Boolean(
          player?.classList.contains("ad-showing") ||
          document.querySelector(".ytp-ad-player-overlay, .ytp-ad-text")
        ),
        currentTime: video?.currentTime,
        currentUrl: location.href,
        duration: Number.isFinite(video?.duration) ? video.duration : undefined,
        ended: video?.ended,
        fullscreen: Boolean(
          player?.classList.contains("ytp-fullscreen") ||
          (document.fullscreenElement &&
            (document.fullscreenElement === video || document.fullscreenElement === player))
        ),
        hasAccountButton: Boolean(
          document.querySelector("#avatar-btn, button[aria-label*='Account' i]")
        ),
        hasSignInButton: Boolean(
          document.querySelector("a[href*='ServiceLogin'], a[href*='accounts.google.com'], ytd-button-renderer a[aria-label*='Sign in' i], button[aria-label*='Sign in' i]")
        ),
        hasVideo: Boolean(video),
        paused: video?.paused,
        readyState: video?.readyState,
        text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim()
      };
    })()`);
    return observationFromYouTubeDom(
      { ...state, ...(expectedVideoId ? { expectedVideoId } : {}) },
      durationSecondsFor(context.mediaItem, 900)
    );
  }

  public async dismissKnownInterruptions(context: AdapterContext): Promise<boolean> {
    const page = this.session(context).page;

    if (!page) {
      return false;
    }

    const skippedAd = await page.clickFirst(youtubeSelectors.skipAdButton);
    const dismissed = await page.clickByText([
      "skip ads",
      "skip ad",
      "no thanks",
      "not now",
      "i agree"
    ]);
    return skippedAd || dismissed;
  }

  public async recover(context: AdapterContext, attempt: number): Promise<RecoveryResult> {
    if (attempt > 3) {
      return { recovered: false, message: "YouTube browser recovery limit reached." };
    }

    const session = this.session(context);
    await session.page?.close().catch(() => undefined);
    delete session.page;
    await this.start(context);
    await this.resume(context);
    await this.enterFullscreen(context);
    return { recovered: true, message: "YouTube browser relaunched." };
  }

  public async cleanup(context: AdapterContext): Promise<void> {
    const session = this.sessions.get(context.mediaItem.id);
    await session?.page?.close().catch(() => undefined);
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

function isTerminalStartupObservation(observation: PlaybackObservation): boolean {
  return observation.status === "blocked" || observation.status === "error";
}

function normalizeYouTubeUrl(input: string): string {
  const url = new URL(input);
  const id = youTubeVideoId(input);

  if (id) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&start=0`;
  }

  url.hash = "";
  url.searchParams.delete("t");
  url.searchParams.delete("start");
  url.searchParams.delete("time_continue");
  return url.href;
}

function youTubeVideoId(input: string): string | undefined {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    return host === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : (url.searchParams.get("v") ?? undefined);
  } catch {
    return undefined;
  }
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startPlaybackFromBeginning(page: BrowserPage): Promise<void> {
  return page.evaluate<void>(`(() => {
    const video = document.querySelector("${youtubeSelectors.video}");
    if (!video) return;
    if (Number.isFinite(video.duration) && video.currentTime > 1) {
      video.currentTime = 0;
    }
    video.play()?.catch?.(() => undefined);
  })()`);
}

function youtubeFullscreen(page: BrowserPage): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const video = document.querySelector("${youtubeSelectors.video}");
    const player = document.querySelector(".html5-video-player");
    const rect = (player ?? video)?.getBoundingClientRect?.();
    const fillsViewport = Boolean(
      rect &&
      rect.width >= window.innerWidth * 0.9 &&
      rect.height >= window.innerHeight * 0.9
    );
    return Boolean(
      fillsViewport ||
      player?.classList.contains("ytp-fullscreen") ||
      (document.fullscreenElement &&
        (document.fullscreenElement === video || document.fullscreenElement === player))
    );
  })()`);
}

function forceYouTubeViewport(page: BrowserPage): Promise<void> {
  return page.evaluate<void>(`(() => {
    if (document.getElementById("caretv-youtube-full-window")) return;

    const style = document.createElement("style");
    style.id = "caretv-youtube-full-window";
    style.textContent = \`
      html, body {
        background: #000 !important;
        cursor: none !important;
        margin: 0 !important;
        overflow: hidden !important;
      }
      #movie_player,
      .html5-video-player,
      ytd-player,
      #player,
      #player-container,
      #player-container-inner {
        background: #000 !important;
        height: 100vh !important;
        inset: 0 !important;
        max-height: none !important;
        max-width: none !important;
        position: fixed !important;
        width: 100vw !important;
        z-index: 2147483647 !important;
      }
      ${youtubeSelectors.video} {
        height: 100vh !important;
        left: 0 !important;
        object-fit: contain !important;
        position: fixed !important;
        top: 0 !important;
        width: 100vw !important;
      }
    \`;
    document.documentElement.appendChild(style);
  })()`);
}
