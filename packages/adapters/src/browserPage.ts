import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BrowserPage {
  bringToFront(): Promise<void>;
  clickByText(text: string[]): Promise<boolean>;
  clickCenterFirst(selectors: string[]): Promise<boolean>;
  clickFirst(selectors: string[]): Promise<boolean>;
  close(): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  pressKey(key: "f"): Promise<void>;
  waitForSelector(selectors: string[], timeoutMs?: number): Promise<boolean>;
}

export const browserPageClosedCode = "browser-page-closed";

export interface ChromeBrowserOptions {
  chromePath?: string;
  remoteDebuggingPort?: number;
  userDataDir?: string;
}

export type LoginBrowserService = "prime" | "youtube";

const loginProcesses = new Set<ChildProcessWithoutNullStreams>();

export class ChromeBrowser {
  private process: ChildProcessWithoutNullStreams | undefined;

  public constructor(private readonly options: ChromeBrowserOptions = {}) {}

  public async open(url: string): Promise<BrowserPage> {
    await this.ensureBrowser();
    await closePageTargets(this.port());
    const target = await createTarget(this.port(), url);
    const page = await CdpBrowserPage.connect(target.webSocketDebuggerUrl);
    await page.navigate(url);
    await page.bringToFront();
    return page;
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
    this.process.once("exit", () => {
      this.process = undefined;
    });
    this.process.unref();
    await waitForDebugPort(this.port());
  }

  private port(): number {
    return this.options.remoteDebuggingPort ?? 9223;
  }
}

export async function openLoginBrowser(
  service: LoginBrowserService,
  options: Pick<ChromeBrowserOptions, "chromePath" | "remoteDebuggingPort" | "userDataDir"> = {}
): Promise<void> {
  const port = options.remoteDebuggingPort ?? 9223;
  const url = loginUrl(service);

  if (await isDebugPortReady(port)) {
    const target = await createTarget(port, url);
    await fetch(`http://127.0.0.1:${port}/json/activate/${target.id}`).catch(() => undefined);
    return;
  }

  const chromePath = options.chromePath ?? findChromePath();
  const userDataDir = options.userDataDir ?? join(tmpdir(), "caretv-chrome-profile");
  await mkdir(userDataDir, { recursive: true });
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--autoplay-policy=no-user-gesture-required",
    "--disable-session-crashed-bubble",
    "--new-window",
    url
  ]);
  loginProcesses.add(child);
  child.once("exit", () => loginProcesses.delete(child));
  child.unref();
  await waitForDebugPort(port);
}

export async function closeLoginBrowsers(
  options: Pick<ChromeBrowserOptions, "remoteDebuggingPort"> = {}
): Promise<void> {
  const port = options.remoteDebuggingPort ?? 9223;

  if (await isDebugPortReady(port)) {
    await closePageTargets(port);
    return;
  }

  for (const child of loginProcesses) {
    if (!child.killed) {
      child.kill();
    }
  }
  loginProcesses.clear();
}

class CdpBrowserPage implements BrowserPage {
  private id = 0;
  private readonly pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >();
  private closed = false;

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
    socket.addEventListener("close", () => this.handleClose());
    socket.addEventListener("error", () => this.handleClose());
  }

  public static async connect(webSocketUrl: string): Promise<CdpBrowserPage> {
    const WebSocketCtor = globalThis.WebSocket as unknown as
      (new (url: string) => WebSocketLike) | undefined;

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
    return new CdpBrowserPage(socket);
  }

  public async clickFirst(selectors: string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
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

  public async clickCenterFirst(selectors: string[]): Promise<boolean> {
    const point = await this.evaluate<{ x: number; y: number } | undefined>(`(() => {
      for (const selector of ${JSON.stringify(selectors)}) {
        let element;
        try {
          element = document.querySelector(selector);
        } catch {
          continue;
        }

        if (!(element instanceof HTMLElement)) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        element.scrollIntoView({ block: "center", inline: "center" });
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      }
      return undefined;
    })()`);

    if (!point) {
      return false;
    }

    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y
    });
    await this.send("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mousePressed",
      x: point.x,
      y: point.y
    });
    await this.send("Input.dispatchMouseEvent", {
      button: "left",
      clickCount: 1,
      type: "mouseReleased",
      x: point.x,
      y: point.y
    });
    return true;
  }

  public async waitForSelector(selectors: string[], timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await this.hasSelector(selectors)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  public async clickByText(text: string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
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

  public async close(): Promise<void> {
    await this.navigate("about:blank").catch(() => undefined);
    this.socket.close();
  }

  public async bringToFront(): Promise<void> {
    await this.send("Page.bringToFront", {});
  }

  public async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
  }

  public evaluate<T>(expression: string): Promise<T> {
    return this.send("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true
    }) as Promise<T>;
  }

  public async pressKey(key: "f"): Promise<void> {
    const code = key.toUpperCase().charCodeAt(0);
    await this.send("Input.dispatchKeyEvent", {
      code: `Key${key.toUpperCase()}`,
      key,
      text: key,
      type: "keyDown",
      windowsVirtualKeyCode: code
    });
    await this.send("Input.dispatchKeyEvent", {
      code: `Key${key.toUpperCase()}`,
      key,
      type: "keyUp",
      windowsVirtualKeyCode: code
    });
  }

  private hasSelector(selectors: string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(() => {
      for (const selector of ${JSON.stringify(selectors)}) {
        try {
          if (document.querySelector(selector)) return true;
        } catch {
          continue;
        }
      }
      return false;
    })()`);
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(browserPageClosedError());
    }

    const id = ++this.id;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      try {
        this.socket.send(message);
      } catch {
        this.pending.delete(id);
        reject(browserPageClosedError());
      }
    });
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const error = browserPageClosedError();
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function isBrowserPageClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes(browserPageClosedCode) ||
      error.message.includes("WebSocket is not open"))
  );
}

function browserPageClosedError(): Error {
  return new Error(browserPageClosedCode);
}

function loginUrl(service: LoginBrowserService): string {
  switch (service) {
    case "youtube":
      return "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F";
    case "prime":
      return "https://www.amazon.com/ap/signin";
  }
}

interface WebSocketLike {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
    options?: { once?: boolean }
  ): void;
  close(): void;
  send(data: string): void;
}

interface ChromeTarget {
  id: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl: string;
}

async function pageTargets(port: number): Promise<ChromeTarget[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);

    if (!response.ok) {
      return [];
    }

    const targets = (await response.json()) as ChromeTarget[];
    return targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  } catch {
    return [];
  }
}

async function closePageTargets(port: number): Promise<void> {
  await Promise.all(
    (await pageTargets(port)).map((target) =>
      fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined)
    )
  );
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
    throw new Error("Chrome was not found. Set adapter chromePath.");
  }

  return found;
}
