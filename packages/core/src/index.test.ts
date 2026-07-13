import { describe, expect, it } from "vitest";

import { createHealthStatus, projectName } from "./index.js";

describe("core", () => {
  it("creates health status objects", () => {
    expect(createHealthStatus("server", new Date("2026-01-01T00:00:00.000Z"))).toEqual({
      service: "server",
      status: "ok",
      timestamp: "2026-01-01T00:00:00.000Z"
    });
  });

  it("exports the project name", () => {
    expect(projectName).toBe("CareTV");
  });
});
