import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, normalizePath, redactConfig } from "./index.js";

describe("config", () => {
  it("loads defaults and normalizes paths", () => {
    const config = loadConfig({}, { createDirectories: false, cwd: "C:\\CareTV" });

    expect(config.values).toMatchObject({
      host: "127.0.0.1",
      serverPort: 4010,
      webPort: 4020,
      appliancePollMs: 1000,
      applianceHeartbeatMs: 5000,
      appliancePlaybackObserveMs: 1000,
      applianceRequestTimeoutMs: 10000,
      applianceMediaScanMs: 30000,
      timezone: "America/Los_Angeles"
    });
    expect(config.values.runtimeDir.toLowerCase()).toContain("caretv");
    expect(config.values.runtimeDir).toBe(resolve(config.values.runtimeDir));
    expect(config.values.applianceMediaDir.toLowerCase()).toContain("caretv");
    expect(config.values.applianceMediaDir).toBe(resolve(config.values.applianceMediaDir));
  });

  it("keeps explicit relative paths scoped to cwd", () => {
    const config = loadConfig(
      {
        CARETV_RUNTIME_DIR: ".caretv/runtime",
        CARETV_CHROME_PROFILE_DIR: ".caretv/chrome-profile",
        CARETV_APPLIANCE_MEDIA_DIR: ".caretv/media"
      },
      { createDirectories: false, cwd: "C:\\CareTV" }
    );

    expect(config.values.runtimeDir).toBe(normalizePath(".caretv/runtime", "C:\\CareTV"));
    expect(config.values.applianceMediaDir).toBe(normalizePath(".caretv/media", "C:\\CareTV"));
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
          CARETV_CHROME_PROFILE_DIR: "profile",
          CARETV_APPLIANCE_MEDIA_DIR: "media"
        },
        { cwd: root }
      );

      expect(config.values.runtimeDir).toBe(join(root, "runtime"));
      expect(config.values.chromeProfileDir).toBe(join(root, "profile"));
      expect(config.values.applianceMediaDir).toBe(join(root, "media"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads config from caretv.config.json", () => {
    const root = mkdtempSync(join(tmpdir(), "caretv-config-file-"));

    try {
      writeFileSync(
        join(root, "caretv.config.json"),
        JSON.stringify({
          applianceId: "tv-room",
          applianceName: "TV Room",
          runtimeDir: "runtime",
          serverUrl: "http://caretv.lan:4010"
        })
      );

      const config = loadConfig({}, { createDirectories: false, cwd: root });

      expect(config.values).toMatchObject({
        applianceId: "tv-room",
        applianceName: "TV Room",
        serverUrl: "http://caretv.lan:4010"
      });
      expect(config.values.runtimeDir).toBe(join(root, "runtime"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets environment variables override config file values", () => {
    const root = mkdtempSync(join(tmpdir(), "caretv-config-env-"));

    try {
      writeFileSync(
        join(root, "caretv.config.json"),
        JSON.stringify({
          applianceName: "Config Name",
          serverUrl: "http://config.lan:4010"
        })
      );

      const config = loadConfig(
        { CARETV_APPLIANCE_NAME: "Env Name" },
        { createDirectories: false, cwd: root }
      );

      expect(config.values.applianceName).toBe("Env Name");
      expect(config.values.serverUrl).toBe("http://config.lan:4010");
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
        appliancePollMs: 1000,
        applianceHeartbeatMs: 5000,
        appliancePlaybackObserveMs: 1000,
        applianceRequestTimeoutMs: 10000,
      applianceMediaDir: "media",
      applianceMediaScanMs: 30000,
      notificationFormat: "json",
      serverUrl: "http://127.0.0.1:4010",
      authToken: "0123456789abcdef"
    })
    ).toMatchObject({ authToken: "[redacted]" });
  });
});
