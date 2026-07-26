import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MediaItem } from "@caretv/core";

import type {
  AdapterContext,
  PlaybackObservation,
  RecoveryResult,
  StreamingAdapter
} from "./contract.js";
import {
  observationFromPrimeDom,
  primeSelectors,
  type PrimeDomState
} from "./primeSelectors.js";

interface PrimeSession {
  page?: PrimePage;
}

export interface PrimeVideoAdapterOptions {
  chromePath?: string;
  remoteDebuggingPort?: number;
  userDataDir?: string;
  openPage?: (url: string) => Promise<PrimePage>;
}

export interface PrimePage {
  clickByText(text: string[]): Promise<boolean>;
  clickFirst(selectors: string[]): Promise<boolean>;
  close(): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
}

export class PrimeVideoAdapter implements StreamingAdapter {
  public readonly id = "prime";
  public readonly version = "0.1.0";

  private readonly openPage: (url: string) => Promise<PrimePage>;
  private readonly sessions = new Map<string, PrimeSession>();

  public constructor(options: PrimeVideoAdapterOptions = {}) {
    const browser = options.openPage
      ? undefined
      : new ChromePrimeBrowser({
          ...(options.chromePath ? { chromePath: options.chromePath } : {}),
          ...(options.remoteDebuggingPort ? { remoteDebuggingPort: options.remoteDebuggingPort } : {}),
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
    session.page ??= await this.openPage(primeUrlFor(context.mediaItem));
    await session.page.clickFirst(primeSelectors.playButton);
    await session.page.clickByText(["play", "resume", "continue watching"]);
    await session.page.evaluate<void>(`(() => {
      const video = document.querySelector("${primeSelectors.video}");
      if (video) return video.play().catch(() => undefined);
    })()`);
  }

  public async pause(context: AdapterContext): Promise<void> {
    await this.session(context).page?.evaluate<void>(
      `document.querySelector("${primeSelectors.video}")?.pause()`
    );
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

    if (await page.clickFirst(primeSelectors.fullscreenButton)) {
      return;
    }

    await page.evaluate<void>(`document.querySelector("${primeSelectors.video}")?.requestFullscreen?.()`);
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

  public recover(): Promise<RecoveryResult> {
    return Promise.resolve({ recovered: false, message: "Prime recovery is not implemented yet." });
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

class ChromePrimeBrowser {
  private process: ChildProcessWithoutNullStreams | undefined;

  public constructor(
    private readonly options: {
      chromePath?: string;
      remoteDebuggingPort?: number;
      userDataDir?: string;
    }
  ) {}

  public async open(url: string): Promise<PrimePage> {
    await this.ensureBrowser();
    const target = await createTarget(this.port(), url);
    return CdpPrimePage.connect(target.webSocketDebuggerUrl);
  }

  private async ensureBrowser(): Promise<void> {
    if (this.process && !this.process.killed && (await isDebugPortReady(this.port()))) {
      return;
    }

    if (await isDebugPortReady(this.port())) {
      return;
    }

    const chromePath = this.options.chromePath ?? findChromePath();
    const userDataDir = this.options.userDataDir ?? join(tmpdir(), "caretv-chrome-profile");
    await mkdir(userDataDir, { recursive: true });
    this.process = spawn(chromePath, [
      `--remote-debugging-port=${this.port()}`,
      `--user-data-dir=${userDataDir}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-session-crashed-bubble",
      "--kiosk",
      "about:blank"
    ]);
    this.process.unref();
    await waitForDebugPort(this.port());
  }

  private port(): number {
    return this.options.remoteDebuggingPort ?? 9223;
  }
}

class CdpPrimePage implements PrimePage {
  private id = 0;
  private readonly pending = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>();

  private constructor(private readonly socket: WebSocketLike) {
    socket.addEventListener("message", (event: { data?: unknown }) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: { result?: { value?: unknown } };
        error?: { message?: string };
      };

      if (message.id === undefined) {
        return;
      }

      const pending = this.pending.get(message.id);

      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "CDP command failed."));
      } else {
        pending.resolve(message.result?.result?.value);
      }
    });
  }

  public static async connect(webSocketUrl: string): Promise<CdpPrimePage> {
    const WebSocketCtor = globalThis.WebSocket as unknown as
      | (new (url: string) => WebSocketLike)
      | undefined;

    if (!WebSocketCtor) {
      throw new Error("Global WebSocket is required for Chrome DevTools control.");
    }

    const socket = new WebSocketCtor(webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Failed to connect to Chrome.")), {
        once: true
      });
    });
    return new CdpPrimePage(socket);
  }

  public async clickFirst(selectors: string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(async () => {
      for (const selector of ${JSON.stringify(selectors)}) {
        let element;
        try {
          element = document.querySelector(selector);
        } catch {
          continue;
        }
        if (element instanceof HTMLElement) {
          element.click();
          return true;
        }
      }
      return false;
    })()`);
  }

  public async clickByText(text: string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(async () => {
      const needles = ${JSON.stringify(text)}.map((value) => value.toLowerCase());
      for (const element of Array.from(document.querySelectorAll("button, [role='button']"))) {
        const label = (element.getAttribute("aria-label") || element.textContent || "").toLowerCase();
        if (element instanceof HTMLElement && needles.some((needle) => label.includes(needle))) {
          element.click();
          return true;
        }
      }
      return false;
    })()`);
  }

  public close(): Promise<void> {
    this.socket.close();
    return Promise.resolve();
  }

  public evaluate<T>(expression: string): Promise<T> {
    return this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true
    }) as Promise<T>;
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.send(message);
    });
  }
}

interface WebSocketLike {
  addEventListener(
    type: "open" | "message" | "error",
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean }
  ): void;
  close(): void;
  send(data: string): void;
}

interface ChromeTarget {
  webSocketDebuggerUrl: string;
}

async function createTarget(port: number, url: string): Promise<ChromeTarget> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Chrome target creation failed with ${response.status}.`);
  }

  return (await response.json()) as ChromeTarget;
}

async function isDebugPortReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForDebugPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isDebugPortReady(port)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Chrome did not expose its remote debugging port.");
}

function durationSecondsFor(item: MediaItem): number {
  const metadataDuration = item.metadata.durationSeconds;
  const duration =
    typeof metadataDuration === "number" && Number.isFinite(metadataDuration)
      ? metadataDuration
      : (item.expectedDurationSeconds ?? 7200);
  return Math.max(1, Math.floor(duration));
}

function findChromePath(): string {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];

  const found = candidates.find((candidate) => candidate && existsSync(candidate));

  if (!found) {
    throw new Error("Chrome was not found. Set PrimeVideoAdapterOptions.chromePath.");
  }

  return found;
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
