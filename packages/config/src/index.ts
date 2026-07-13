import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
  CARETV_HOST: z.string().min(1).default("127.0.0.1"),
  CARETV_SERVER_PORT: portSchema.default(4010),
  CARETV_WEB_PORT: portSchema.default(4020),
  CARETV_RUNTIME_DIR: z.string().min(1).default(".caretv/runtime"),
  CARETV_CHROME_PROFILE_DIR: z.string().min(1).default(".caretv/chrome-profile"),
  CARETV_TIMEZONE: z.string().min(1).default("America/Los_Angeles"),
  CARETV_AUTH_TOKEN: z.string().min(16).optional()
});

export interface CareTvConfig {
  host: string;
  serverPort: number;
  webPort: number;
  runtimeDir: string;
  chromeProfileDir: string;
  timezone: string;
  authToken?: string;
}

export interface LoadedConfig {
  values: CareTvConfig;
  redacted: Omit<CareTvConfig, "authToken"> & { authToken?: "[redacted]" };
}

export interface LoadConfigOptions {
  createDirectories?: boolean;
  cwd?: string;
}

export class ConfigError extends Error {
  public override readonly name = "ConfigError";

  public constructor(message: string) {
    super(message);
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {}
): LoadedConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const cwd = options.cwd ?? process.cwd();
  const values: CareTvConfig = {
    host: parsed.data.CARETV_HOST,
    serverPort: parsed.data.CARETV_SERVER_PORT,
    webPort: parsed.data.CARETV_WEB_PORT,
    runtimeDir: normalizePath(parsed.data.CARETV_RUNTIME_DIR, cwd),
    chromeProfileDir: normalizePath(parsed.data.CARETV_CHROME_PROFILE_DIR, cwd),
    timezone: parsed.data.CARETV_TIMEZONE,
    ...(parsed.data.CARETV_AUTH_TOKEN ? { authToken: parsed.data.CARETV_AUTH_TOKEN } : {})
  };

  if (options.createDirectories ?? true) {
    mkdirSync(values.runtimeDir, { recursive: true });
    mkdirSync(values.chromeProfileDir, { recursive: true });
  }

  return {
    values,
    redacted: redactConfig(values)
  };
}

export function normalizePath(input: string, cwd = process.cwd()): string {
  return resolve(cwd, input);
}

export function redactConfig(config: CareTvConfig): LoadedConfig["redacted"] {
  const { authToken, ...visible } = config;
  return authToken ? { ...visible, authToken: "[redacted]" } : visible;
}
