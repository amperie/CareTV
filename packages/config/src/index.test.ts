import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, normalizePath, redactConfig } from "./index.js";

describe("config", () => {
  it("loads defaults and normalizes paths", () => {
    const config = loadConfig({}, { createDirectories: false, cwd: "C:\\CareTV" });

    expect(config.values).toMatchObject({
      host: "127.0.0.1",
      serverPort: 4010,
      webPort: 4020,
      timezone: "America/Los_Angeles"
    });
    expect(config.values.runtimeDir).toBe(normalizePath(".caretv/runtime", "C:\\CareTV"));
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ CARETV_SERVER_PORT: "99999" }, { createDirectories: false })).toThrow(
      ConfigError
    );
  });

  it("creates runtime directories when enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "caretv-config-"));

    try {
      const config = loadConfig(
        {
          CARETV_RUNTIME_DIR: "runtime",
          CARETV_CHROME_PROFILE_DIR: "profile"
        },
        { cwd: root }
      );

      expect(config.values.runtimeDir).toBe(join(root, "runtime"));
      expect(config.values.chromeProfileDir).toBe(join(root, "profile"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts secrets in summaries", () => {
    expect(
      redactConfig({
        host: "127.0.0.1",
        serverPort: 4010,
        webPort: 4020,
        runtimeDir: "runtime",
        chromeProfileDir: "profile",
        timezone: "UTC",
        applianceId: "local-appliance",
        applianceName: "Local Appliance",
        serverUrl: "http://127.0.0.1:4010",
        authToken: "0123456789abcdef"
      })
    ).toMatchObject({ authToken: "[redacted]" });
  });
});
