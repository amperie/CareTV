import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65535);
const millisecondsSchema = z.coerce.number().int().min(100);
const configFilename = "caretv.config.json";
const defaultDataDir = defaultCareTvDataDir();

const envSchema = z.object({
  CARETV_HOST: z.string().min(1).default("127.0.0.1"),
  CARETV_SERVER_PORT: portSchema.default(4010),
  CARETV_WEB_PORT: portSchema.default(4020),
  CARETV_RUNTIME_DIR: z.string().min(1).default(resolve(defaultDataDir, "runtime")),
  CARETV_CHROME_PROFILE_DIR: z.string().min(1).default(resolve(defaultDataDir, "chrome-profile")),
  CARETV_TIMEZONE: z.string().min(1).default("America/Los_Angeles"),
  CARETV_APPLIANCE_ID: z.string().min(1).default("local-appliance"),
  CARETV_APPLIANCE_NAME: z.string().min(1).default("Local Appliance"),
  CARETV_APPLIANCE_POLL_MS: millisecondsSchema.default(1000),
  CARETV_APPLIANCE_HEARTBEAT_MS: millisecondsSchema.default(5000),
  CARETV_APPLIANCE_PLAYBACK_OBSERVE_MS: millisecondsSchema.default(1000),
  CARETV_APPLIANCE_REQUEST_TIMEOUT_MS: millisecondsSchema.default(10000),
  CARETV_APPLIANCE_MEDIA_DIR: z.string().min(1).default(resolve(defaultDataDir, "media")),
  CARETV_APPLIANCE_MEDIA_SCAN_MS: millisecondsSchema.default(30000),
  CARETV_NOTIFICATION_FORMAT: z.enum(["json", "ntfy"]).default("json"),
  CARETV_NOTIFICATION_WEBHOOK_URL: z.string().url().optional(),
  CARETV_REMOTE_SUPPORT_URL: z.string().url().optional(),
  CARETV_SERVER_URL: z.string().url().default("http://127.0.0.1:4010"),
  CARETV_AUTH_TOKEN: z.string().min(16).optional()
});

const fileSchema = z
  .object({
    host: z.string().min(1).optional(),
    serverPort: portSchema.optional(),
    webPort: portSchema.optional(),
    runtimeDir: z.string().min(1).optional(),
    chromeProfileDir: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    applianceId: z.string().min(1).optional(),
    applianceName: z.string().min(1).optional(),
    appliancePollMs: millisecondsSchema.optional(),
    applianceHeartbeatMs: millisecondsSchema.optional(),
    appliancePlaybackObserveMs: millisecondsSchema.optional(),
    applianceRequestTimeoutMs: millisecondsSchema.optional(),
    applianceMediaDir: z.string().min(1).optional(),
    applianceMediaScanMs: millisecondsSchema.optional(),
    notificationFormat: z.enum(["json", "ntfy"]).optional(),
    notificationWebhookUrl: z.string().url().optional(),
    remoteSupportUrl: z.string().url().optional(),
    serverUrl: z.string().url().optional(),
    authToken: z.string().min(16).optional()
  })
  .strict();
type FileConfig = z.infer<typeof fileSchema>;

export interface CareTvConfig {
  host: string;
  serverPort: number;
  webPort: number;
  runtimeDir: string;
  chromeProfileDir: string;
  timezone: string;
  applianceId: string;
  applianceName: string;
  appliancePollMs: number;
  applianceHeartbeatMs: number;
  appliancePlaybackObserveMs: number;
  applianceRequestTimeoutMs: number;
  applianceMediaDir: string;
  applianceMediaScanMs: number;
  notificationFormat: "json" | "ntfy";
  notificationWebhookUrl?: string;
  remoteSupportUrl?: string;
  serverUrl: string;
  authToken?: string;
}

export interface LoadedConfig {
  values: CareTvConfig;
  redacted: Omit<CareTvConfig, "authToken"> & { authToken?: "[redacted]" };
}

export interface LoadConfigOptions {
  configFile?: string;
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
  const cwd = options.cwd ?? process.cwd();
  const fileValues = readConfigFile(options.configFile ?? env.CARETV_CONFIG_FILE, cwd);
  const parsed = envSchema.safeParse({ ...toEnvConfig(fileValues), ...definedEnv(env) });

  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const values: CareTvConfig = {
    host: parsed.data.CARETV_HOST,
    serverPort: parsed.data.CARETV_SERVER_PORT,
    webPort: parsed.data.CARETV_WEB_PORT,
    runtimeDir: normalizePath(parsed.data.CARETV_RUNTIME_DIR, cwd),
    chromeProfileDir: normalizePath(parsed.data.CARETV_CHROME_PROFILE_DIR, cwd),
    timezone: parsed.data.CARETV_TIMEZONE,
    applianceId: parsed.data.CARETV_APPLIANCE_ID,
    applianceName: parsed.data.CARETV_APPLIANCE_NAME,
    appliancePollMs: parsed.data.CARETV_APPLIANCE_POLL_MS,
    applianceHeartbeatMs: parsed.data.CARETV_APPLIANCE_HEARTBEAT_MS,
    appliancePlaybackObserveMs: parsed.data.CARETV_APPLIANCE_PLAYBACK_OBSERVE_MS,
    applianceRequestTimeoutMs: parsed.data.CARETV_APPLIANCE_REQUEST_TIMEOUT_MS,
    applianceMediaDir: normalizePath(parsed.data.CARETV_APPLIANCE_MEDIA_DIR, cwd),
    applianceMediaScanMs: parsed.data.CARETV_APPLIANCE_MEDIA_SCAN_MS,
    notificationFormat: parsed.data.CARETV_NOTIFICATION_FORMAT,
    ...(parsed.data.CARETV_NOTIFICATION_WEBHOOK_URL
      ? { notificationWebhookUrl: parsed.data.CARETV_NOTIFICATION_WEBHOOK_URL }
      : {}),
    ...(parsed.data.CARETV_REMOTE_SUPPORT_URL
      ? { remoteSupportUrl: parsed.data.CARETV_REMOTE_SUPPORT_URL }
      : {}),
    serverUrl: parsed.data.CARETV_SERVER_URL.replace(/\/$/, ""),
    ...(parsed.data.CARETV_AUTH_TOKEN ? { authToken: parsed.data.CARETV_AUTH_TOKEN } : {})
  };

  if (options.createDirectories ?? true) {
    mkdirSync(values.runtimeDir, { recursive: true });
    mkdirSync(values.chromeProfileDir, { recursive: true });
    mkdirSync(values.applianceMediaDir, { recursive: true });
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

function readConfigFile(path: string | undefined, cwd: string): Partial<CareTvConfig> {
  const configPath = normalizePath(path?.trim() || configFilename, cwd);

  if (!existsSync(configPath)) {
    return {};
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Failed to read ${configPath}: ${error instanceof Error ? error.message : "invalid JSON"}`
    );
  }

  const parsed = fileSchema.safeParse(raw);

  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  return withoutUndefined(parsed.data);
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined)
  ) as Record<string, string>;
}

function toEnvConfig(config: Partial<CareTvConfig>): Record<string, unknown> {
  return {
    ...(config.host ? { CARETV_HOST: config.host } : {}),
    ...(config.serverPort ? { CARETV_SERVER_PORT: config.serverPort } : {}),
    ...(config.webPort ? { CARETV_WEB_PORT: config.webPort } : {}),
    ...(config.runtimeDir ? { CARETV_RUNTIME_DIR: config.runtimeDir } : {}),
    ...(config.chromeProfileDir ? { CARETV_CHROME_PROFILE_DIR: config.chromeProfileDir } : {}),
    ...(config.timezone ? { CARETV_TIMEZONE: config.timezone } : {}),
    ...(config.applianceId ? { CARETV_APPLIANCE_ID: config.applianceId } : {}),
    ...(config.applianceName ? { CARETV_APPLIANCE_NAME: config.applianceName } : {}),
    ...(config.appliancePollMs ? { CARETV_APPLIANCE_POLL_MS: config.appliancePollMs } : {}),
    ...(config.applianceHeartbeatMs
      ? { CARETV_APPLIANCE_HEARTBEAT_MS: config.applianceHeartbeatMs }
      : {}),
    ...(config.appliancePlaybackObserveMs
      ? { CARETV_APPLIANCE_PLAYBACK_OBSERVE_MS: config.appliancePlaybackObserveMs }
      : {}),
    ...(config.applianceRequestTimeoutMs
      ? { CARETV_APPLIANCE_REQUEST_TIMEOUT_MS: config.applianceRequestTimeoutMs }
      : {}),
    ...(config.applianceMediaDir ? { CARETV_APPLIANCE_MEDIA_DIR: config.applianceMediaDir } : {}),
    ...(config.applianceMediaScanMs
      ? { CARETV_APPLIANCE_MEDIA_SCAN_MS: config.applianceMediaScanMs }
      : {}),
    ...(config.notificationFormat ? { CARETV_NOTIFICATION_FORMAT: config.notificationFormat } : {}),
    ...(config.notificationWebhookUrl
      ? { CARETV_NOTIFICATION_WEBHOOK_URL: config.notificationWebhookUrl }
      : {}),
    ...(config.remoteSupportUrl ? { CARETV_REMOTE_SUPPORT_URL: config.remoteSupportUrl } : {}),
    ...(config.serverUrl ? { CARETV_SERVER_URL: config.serverUrl } : {}),
    ...(config.authToken ? { CARETV_AUTH_TOKEN: config.authToken } : {})
  };
}

function withoutUndefined(config: FileConfig): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

function defaultCareTvDataDir(): string {
  if (process.platform === "win32") {
    return resolve(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? homedir(), "CareTV");
  }

  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "CareTV");
  }

  return resolve(process.env.XDG_DATA_HOME ?? resolve(homedir(), ".local", "share"), "caretv");
}
