import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BrowserPage {
  clickByText(text: string[]): Promise<boolean>;
  clickFirst(selectors: string[]): Promise<boolean>;
  close(): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
}

export interface ChromeBrowserOptions {
  chromePath?: string;
  remoteDebuggingPort?: number;
  userDataDir?: string;
}

export class ChromeBrowser {
  private process: ChildProcessWithoutNullStreams | undefined;

  public constructor(private readonly options: ChromeBrowserOptions = {}) {}

  public async open(url: string): Promise<BrowserPage> {
    await this.ensureBrowser();
    const target = await createTarget(this.port(), url);
    return CdpBrowserPage.connect(target.webSocketDebuggerUrl);
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

class CdpBrowserPage implements BrowserPage {
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

  public static async connect(webSocketUrl: string): Promise<CdpBrowserPage> {
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
