import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { MediaItem } from "@caretv/core";

import type {
  AdapterContext,
  PlaybackObservation,
  RecoveryResult,
  StreamingAdapter
} from "./contract.js";

interface LocalFileSession {
  page?: PlayerPage;
}

interface PlayerState {
  currentTime: number;
  duration?: number;
  ended: boolean;
  error?: string;
  fullscreen: boolean;
  paused: boolean;
  readyState: number;
}

export interface PlayerPage {
  close(): Promise<void>;
  enterFullscreen(): Promise<void>;
  pause(): Promise<void>;
  play(): Promise<void>;
  state(): Promise<PlayerState>;
  stop(): Promise<void>;
}

export interface LocalFileAdapterOptions {
  chromePath?: string;
  playerDir?: string;
  remoteDebuggingPort?: number;
  userDataDir?: string;
  openPlayer?: (localPath: string) => Promise<PlayerPage>;
}

export class LocalFileAdapter implements StreamingAdapter {
  public readonly id = "local-file";
  public readonly version = "0.2.0";

  private readonly openPlayer: (localPath: string) => Promise<PlayerPage>;
  private readonly sessions = new Map<string, LocalFileSession>();

  public constructor(options: LocalFileAdapterOptions = {}) {
    const browserOptions = {
      ...(options.chromePath ? { chromePath: options.chromePath } : {}),
      ...(options.playerDir ? { playerDir: options.playerDir } : {}),
      ...(options.remoteDebuggingPort ? { remoteDebuggingPort: options.remoteDebuggingPort } : {}),
      ...(options.userDataDir ? { userDataDir: options.userDataDir } : {})
    };
    const browser = options.openPlayer ? undefined : new ChromeLocalPlayerBrowser(browserOptions);
    this.openPlayer = options.openPlayer ?? ((localPath) => browser!.open(localPath));
  }

  public supports(item: MediaItem): boolean {
    return item.service === "local" && item.mediaType === "local-file" && Boolean(item.localPath);
  }

  public async prepare(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    await stat(localPathFor(context.mediaItem));
    this.sessions.set(context.mediaItem.id, {});
  }

  public async start(context: AdapterContext): Promise<void> {
    throwIfAborted(context.signal);
    const session = this.session(context);
    session.page ??= await this.openPlayer(localPathFor(context.mediaItem));
    await session.page.play();
  }

  public async pause(context: AdapterContext): Promise<void> {
    await this.session(context).page?.pause();
  }

  public async resume(context: AdapterContext): Promise<void> {
    await this.session(context).page?.play();
  }

  public async stop(context: AdapterContext): Promise<void> {
    await this.session(context).page?.stop();
  }

  public async enterFullscreen(context: AdapterContext): Promise<void> {
    await this.session(context).page?.enterFullscreen();
  }

  public async observe(context: AdapterContext): Promise<PlaybackObservation> {
    throwIfAborted(context.signal);

    const page = this.session(context).page;

    if (!page) {
      return { status: "ready", positionSeconds: 0 };
    }

    const state = await page.state();
    const durationSeconds = durationSecondsFor(context.mediaItem, state.duration);
    const positionSeconds = Math.floor(state.currentTime);

    if (state.error) {
      return {
        status: "error",
        errorCode: "local-file-playback-error",
        details: { ...state }
      };
    }

    if (state.ended || positionSeconds >= durationSeconds) {
      return observation("completed", positionSeconds, durationSeconds, state.fullscreen);
    }

    if (state.readyState < 2) {
      return observation("buffering", positionSeconds, durationSeconds, state.fullscreen);
    }

    return observation(
      state.paused ? "paused" : "playing",
      positionSeconds,
      durationSeconds,
      state.fullscreen
    );
  }

  public dismissKnownInterruptions(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public recover(): Promise<RecoveryResult> {
    return Promise.resolve({ recovered: false, message: "Local file recovery is not implemented." });
  }

  public async cleanup(context: AdapterContext): Promise<void> {
    const session = this.sessions.get(context.mediaItem.id);
    await session?.page?.close();
    this.sessions.delete(context.mediaItem.id);
  }

  private session(context: AdapterContext): LocalFileSession {
    const session = this.sessions.get(context.mediaItem.id);

    if (!session) {
      throw new Error(`Local file session was not prepared for ${context.mediaItem.id}`);
    }

    return session;
  }
}

class ChromeLocalPlayerBrowser {
  private process: ChildProcessWithoutNullStreams | undefined;
  private playerPath: string | undefined;

  public constructor(
    private readonly options: {
      chromePath?: string;
      playerDir?: string;
      remoteDebuggingPort?: number;
      userDataDir?: string;
    }
  ) {}

  public async open(localPath: string): Promise<PlayerPage> {
    await this.ensureBrowser();
    const playerUrl = await this.playerUrl(localPath);
    const target = await singlePageTarget(this.port(), playerUrl);
    const page = await CdpPlayerPage.connect(target.webSocketDebuggerUrl);
    await page.navigate(playerUrl);
    return page;
  }

  private async ensureBrowser(): Promise<void> {
    if (this.process && !this.process.killed && (await isDebugPortReady(this.port()))) {
      return;
    }

    const chromePath = this.options.chromePath ?? findChromePath();
    const userDataDir = this.options.userDataDir ?? join(tmpdir(), "caretv-chrome-profile");
    await mkdir(userDataDir, { recursive: true });

    this.process = spawn(chromePath, [
      `--remote-debugging-port=${this.port()}`,
      `--user-data-dir=${userDataDir}`,
      "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-session-crashed-bubble",
      "--kiosk",
      "about:blank"
    ]);
    this.process.unref();
    await waitForDebugPort(this.port());
  }

  private async playerUrl(localPath: string): Promise<string> {
    this.playerPath ??= await writePlayerHtml(this.options.playerDir);
    const url = new URL(pathToFileURL(this.playerPath).href);
    url.searchParams.set("src", pathToFileURL(localPath).href);
    url.searchParams.set("title", basename(localPath));
    return url.href;
  }

  private port(): number {
    return this.options.remoteDebuggingPort ?? 9223;
  }
}

class CdpPlayerPage implements PlayerPage {
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

  public static async connect(webSocketUrl: string): Promise<CdpPlayerPage> {
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
    return new CdpPlayerPage(socket);
  }

  public async close(): Promise<void> {
    await this.send("Page.close", {}).catch(() => undefined);
    this.socket.close();
  }

  public async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  public enterFullscreen(): Promise<void> {
    return this.evaluateVoid("window.caretv.enterFullscreen()");
  }

  public pause(): Promise<void> {
    return this.evaluateVoid("window.caretv.pause()");
  }

  public play(): Promise<void> {
    return this.evaluateVoid("window.caretv.play()");
  }

  public async state(): Promise<PlayerState> {
    return (await this.evaluate("window.caretv.state()")) as PlayerState;
  }

  public stop(): Promise<void> {
    return this.evaluateVoid("window.caretv.stop()");
  }

  private async evaluateVoid(expression: string): Promise<void> {
    await this.evaluate(expression);
  }

  private async evaluate(expression: string): Promise<unknown> {
    return this.send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
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
  id: string;
  type?: string;
  webSocketDebuggerUrl: string;
}

async function singlePageTarget(port: number, url: string): Promise<ChromeTarget> {
  const existing = await firstPageTarget(port);

  if (existing) {
    await fetch(`http://127.0.0.1:${port}/json/activate/${existing.id}`).catch(() => undefined);
    return existing;
  }

  return createTarget(port, url);
}

async function firstPageTarget(port: number): Promise<ChromeTarget | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);

    if (!response.ok) {
      return undefined;
    }

    const targets = (await response.json()) as ChromeTarget[];
    return targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  } catch {
    return undefined;
  }
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

async function writePlayerHtml(playerDir = join(tmpdir(), "caretv-player")): Promise<string> {
  await mkdir(playerDir, { recursive: true });
  const playerPath = join(playerDir, "local-player.html");
  await writeFile(playerPath, playerHtml(), "utf8");
  return playerPath;
}

function playerHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>CareTV Local Player</title>
    <style>
      html, body { background: #000; height: 100%; margin: 0; overflow: hidden; }
      video { background: #000; height: 100vh; object-fit: contain; width: 100vw; }
    </style>
  </head>
  <body>
    <video id="player" autoplay controls playsinline></video>
    <script>
      const video = document.getElementById("player");
      const params = new URLSearchParams(location.search);
      document.title = params.get("title") || "CareTV Local Player";
      video.src = params.get("src");
      window.caretv = {
        enterFullscreen: async () => {
          if (!document.fullscreenElement && video.requestFullscreen) await video.requestFullscreen();
        },
        pause: async () => video.pause(),
        play: async () => { await video.play(); },
        state: () => ({
          currentTime: video.currentTime || 0,
          duration: Number.isFinite(video.duration) ? video.duration : undefined,
          ended: video.ended,
          error: video.error ? String(video.error.code) : undefined,
          fullscreen: document.fullscreenElement === video,
          paused: video.paused,
          readyState: video.readyState
        }),
        stop: async () => {
          video.pause();
          video.currentTime = Math.max(video.duration || 0, video.currentTime || 0);
        }
      };
    </script>
  </body>
</html>`;
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
    throw new Error("Chrome was not found. Set LocalFileAdapterOptions.chromePath.");
  }

  return found;
}

function durationSecondsFor(item: MediaItem, browserDuration: number | undefined): number {
  const duration = browserDuration ?? numberValue(item.metadata.durationSeconds, item.expectedDurationSeconds ?? 60);
  return Math.max(1, Math.floor(duration));
}

function localPathFor(item: MediaItem): string {
  if (!item.localPath) {
    throw new Error(`Local media item ${item.id} has no local path.`);
  }

  return item.localPath;
}

function numberValue(input: unknown, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback;
}

function observation(
  status: PlaybackObservation["status"],
  positionSeconds: number,
  durationSeconds: number,
  fullscreen: boolean
): PlaybackObservation {
  return { durationSeconds, fullscreen, positionSeconds, status };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Adapter operation was aborted.");
  }
}
