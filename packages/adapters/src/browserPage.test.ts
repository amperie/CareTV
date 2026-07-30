import { afterEach, describe, expect, it, vi } from "vitest";

import { ChromeBrowser } from "./browserPage.js";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

describe("ChromeBrowser", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    FakeWebSocket.instances.length = 0;
    vi.restoreAllMocks();
  });

  it("opens a fresh target when the cached page was closed", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("/json/version")) {
        return jsonResponse({});
      }

      if (url.includes("/json/list")) {
        return jsonResponse([]);
      }

      if (url.includes("/json/new")) {
        urls.push(decodeURIComponent(url.split("/json/new?")[1] ?? ""));
        return jsonResponse({
          id: `target-${urls.length}`,
          type: "page",
          webSocketDebuggerUrl: `ws://target-${urls.length}`
        });
      }

      return jsonResponse({});
    }) as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const browser = new ChromeBrowser();
    const first = await browser.open("https://example.test/one");
    await first.close();

    const second = await browser.open("https://example.test/two");

    expect(second).not.toBe(first);
    expect(urls).toEqual(["https://example.test/one", "https://example.test/two"]);
  });
});

class FakeWebSocket {
  public static readonly instances: FakeWebSocket[] = [];
  private closed = false;
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  public addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  public close(): void {
    this.closed = true;
    this.emit("close", {});
  }

  public send(data: string): void {
    if (this.closed) {
      throw new Error("WebSocket is not open");
    }

    const message = JSON.parse(data) as { id: number };
    queueMicrotask(() =>
      this.emit("message", {
        data: JSON.stringify({
          id: message.id,
          result: { result: { value: true } }
        })
      })
    );
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as Response;
}
