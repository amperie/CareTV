# Curated TV Automation Platform

## Codex Project Brief

### Working name

**CareTV**

### Primary objective

Build a remotely managed television playback system for a visually and hearing-impaired nursing-home resident who cannot reliably operate a television remote.

A family member must be able to create and manage a queue of movies, television episodes, local media, and other browser-accessible content. A playback agent will run on a computer connected to a television through HDMI. It will open the correct streaming service in a visible browser, start the selected title, enter full-screen mode, monitor playback, recover from common interruptions, and continue to the next queue item.

The first development environment will be a Windows virtual machine running on a desktop computer. The eventual production target is a dedicated Windows mini-PC connected to a television.

---

# 1. Product principles

1. **The resident should not need to interact with the system.**
2. **There should nearly always be appropriate content playing.**
3. **Failures are expected and must be handled automatically.**
4. **Remote intervention must be possible without visiting the nursing home.**
5. **Streaming-service automation must be isolated behind replaceable adapters.**
6. **The system must support a deterministic simulation mode before real streaming automation is attempted.**
7. **The MVP should remain local-first and avoid unnecessary cloud infrastructure.**
8. **The system must not download, decrypt, rebroadcast, or circumvent DRM-protected media.**

---

# 2. Initial scope

## 2.1 MVP capabilities

The MVP must support:

- A local web dashboard.
- A persistent queue of media items.
- Add, edit, delete, reorder, enable, and disable queue items.
- Play-now, skip, pause, resume, restart, and stop controls.
- Sequential playback.
- Repeat queue mode.
- A deterministic fake streaming adapter.
- A local-media adapter.
- A browser playback agent using Playwright and installed Google Chrome.
- A persistent browser profile.
- Playback-state reporting.
- Periodic screenshots.
- Structured logs.
- Automatic retry and recovery.
- A watchdog process.
- Restart-safe state.
- A simple daily schedule.
- A fallback playlist.
- Windows VM support.
- A single-command development startup process.

## 2.2 First real streaming integration

After the simulation and local-media flows work reliably, implement **Amazon Prime Video** as the first browser adapter.

Do not implement Netflix, Hulu, Max, Disney+, Paramount+, or other services until the Prime adapter is stable and the adapter contract has proven adequate.

## 2.3 Explicitly out of scope for the initial MVP

- Native mobile applications.
- Multi-tenant SaaS.
- Public internet exposure.
- Account credential storage.
- Media downloading.
- DRM circumvention.
- Browser-headless playback.
- AI-based movie recommendations.
- Voice control.
- Automatic discovery of streaming catalogs.
- Kubernetes.
- Microservices.
- A separate cloud database.
- Multiple playback devices.

---

# 3. Development environment

## 3.1 Initial environment

The system will initially run inside a Windows 11 virtual machine hosted on the developer's desktop.

Expected VM characteristics:

- Windows 11.
- 4 virtual CPU cores.
- 8 GB RAM minimum; 12–16 GB preferred.
- 80 GB virtual disk minimum.
- Virtual audio device enabled.
- GPU acceleration enabled when supported.
- Network access using NAT or bridged networking.
- Google Chrome installed manually or through a setup script.
- Node.js LTS installed.
- Git installed.
- PowerShell 7 preferred.

## 3.2 VM limitations that must be anticipated

Commercial streaming playback inside a VM may fail because of:

- Widevine DRM restrictions.
- Missing hardware video decoding.
- Virtualized display adapters.
- HDCP or protected-video-path requirements.
- Disabled audio devices.
- Browser detection of virtualized environments.
- Remote Desktop sessions changing the active display or audio device.

Therefore:

- Simulation and local media are the authoritative development paths.
- Real streaming inside the VM is considered best-effort.
- A failure to play DRM content in the VM does not invalidate the architecture.
- The production mini-PC must be tested separately with a physical HDMI display.
- The application must expose enough diagnostics to distinguish an adapter bug from a DRM/environment limitation.

## 3.3 Browser rules

- Use installed stable Google Chrome.
- Use Playwright to launch a **persistent visible browser context**.
- Never use headless mode for streaming playback.
- Store the browser profile outside the repository.
- Never commit cookies, browser profile data, credentials, or tokens.
- Keep the Chrome remote-debugging endpoint bound to localhost.
- Allow manual login through the same persistent profile.

---

# 4. Recommended technical stack

## 4.1 Language and runtime

- TypeScript.
- Node.js LTS.
- Strict TypeScript configuration.
- pnpm workspaces.

## 4.2 Main libraries

- Playwright for browser control.
- Fastify for the local API.
- React with Vite for the dashboard.
- SQLite for local persistence.
- Drizzle ORM or Prisma for database access.
- Zod for validation.
- Pino for structured logging.
- Vitest for unit and integration testing.
- Playwright Test for browser-facing tests.
- Socket.IO or native WebSocket support for live state updates.
- ffprobe for local-media metadata if needed.
- A lightweight process supervisor or Windows service wrapper for production.

## 4.3 Architectural style

Use a modular monolith with separate processes where operationally useful:

1. **Server process**
   - API.
   - Web dashboard.
   - Database.
   - Queue management.
   - Scheduling.
   - Command dispatch.
   - State aggregation.

2. **Playback agent process**
   - Browser lifecycle.
   - Adapter execution.
   - Playback monitoring.
   - Screenshot capture.
   - Recovery logic.
   - Heartbeats.

3. **Watchdog process**
   - Detects an unresponsive server or agent.
   - Restarts processes.
   - Eventually triggers an operating-system restart in production.

Do not split these into network microservices. They may communicate over localhost HTTP/WebSocket or an internal message abstraction.

---

# 5. Repository structure

```text
caretv/
├── apps/
│   ├── server/
│   │   ├── src/
│   │   │   ├── api/
│   │   │   ├── commands/
│   │   │   ├── queue/
│   │   │   ├── scheduler/
│   │   │   ├── telemetry/
│   │   │   └── index.ts
│   │   └── package.json
│   ├── agent/
│   │   ├── src/
│   │   │   ├── browser/
│   │   │   ├── playback/
│   │   │   ├── recovery/
│   │   │   ├── screenshots/
│   │   │   └── index.ts
│   │   └── package.json
│   ├── watchdog/
│   │   ├── src/
│   │   └── package.json
│   └── web/
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   ├── hooks/
│       │   └── api/
│       └── package.json
├── packages/
│   ├── contracts/
│   ├── database/
│   ├── adapters/
│   │   ├── core/
│   │   ├── fake/
│   │   ├── local-media/
│   │   └── prime/
│   ├── logging/
│   ├── config/
│   └── test-utils/
├── scripts/
│   ├── setup-windows.ps1
│   ├── start-dev.ps1
│   ├── reset-local-state.ps1
│   └── package-production.ps1
├── data/
│   └── .gitkeep
├── docs/
│   ├── architecture.md
│   ├── adapter-development.md
│   ├── operations.md
│   └── vm-testing.md
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

Runtime data must default to a directory outside source-controlled files, for example:

```text
C:\CareTV\data
C:\CareTV\chrome-profile
C:\CareTV\screenshots
C:\CareTV\logs
C:\CareTV\media
```

For local development, these paths may be overridden to repository-local ignored directories.

---

# 6. Core domain model

## 6.1 Media item

```ts
export type MediaService =
  | "fake"
  | "local"
  | "prime"
  | "netflix"
  | "youtube"
  | "plex";

export type MediaType =
  | "movie"
  | "episode"
  | "series"
  | "video"
  | "local-file"
  | "slideshow"
  | "stream";

export interface MediaItem {
  id: string;
  title: string;
  service: MediaService;
  mediaType: MediaType;
  url?: string;
  localPath?: string;
  expectedDurationSeconds?: number;
  profileName?: string;
  enabled: boolean;
  repeatable: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

## 6.2 Queue entry

```ts
export type QueueEntryStatus =
  | "queued"
  | "starting"
  | "playing"
  | "paused"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

export interface QueueEntry {
  id: string;
  mediaItemId: string;
  position: number;
  status: QueueEntryStatus;
  priority: number;
  scheduledStartAt?: string;
  startedAt?: string;
  completedAt?: string;
  attemptCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}
```

## 6.3 Playback state

```ts
export type PlaybackPhase =
  | "idle"
  | "launching-browser"
  | "loading"
  | "awaiting-play"
  | "playing"
  | "paused"
  | "buffering"
  | "ending"
  | "recovering"
  | "failed";

export interface PlaybackState {
  phase: PlaybackPhase;
  queueEntryId?: string;
  mediaItemId?: string;
  adapterId?: string;
  title?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  volume?: number;
  muted?: boolean;
  fullscreen?: boolean;
  lastProgressAt?: string;
  lastHeartbeatAt: string;
  recoveryAttempt: number;
  screenshotPath?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

## 6.4 Schedule block

```ts
export interface ScheduleBlock {
  id: string;
  name: string;
  enabled: boolean;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  playlistId?: string;
  behavior: "start-playlist" | "stop-playback" | "fallback";
}
```

## 6.5 Playback command

```ts
export type PlaybackCommandType =
  | "play"
  | "pause"
  | "resume"
  | "stop"
  | "skip"
  | "restart"
  | "play-now"
  | "reload"
  | "restart-browser"
  | "restart-agent";

export interface PlaybackCommand {
  id: string;
  type: PlaybackCommandType;
  mediaItemId?: string;
  issuedAt: string;
  issuedBy: string;
  status: "pending" | "accepted" | "completed" | "failed";
}
```

---

# 7. Adapter contract

Streaming-service-specific behavior must be hidden behind an adapter interface.

```ts
export interface AdapterContext {
  page: import("@playwright/test").Page;
  logger: Logger;
  mediaItem: MediaItem;
  signal: AbortSignal;
}

export interface PlaybackObservation {
  status:
    | "unknown"
    | "ready"
    | "playing"
    | "paused"
    | "buffering"
    | "completed"
    | "blocked"
    | "error";
  positionSeconds?: number;
  durationSeconds?: number;
  fullscreen?: boolean;
  dialog?: string;
  errorCode?: string;
  details?: Record<string, unknown>;
}

export interface StreamingAdapter {
  readonly id: string;

  supports(item: MediaItem): boolean;

  prepare(context: AdapterContext): Promise<void>;

  start(context: AdapterContext): Promise<void>;

  pause(context: AdapterContext): Promise<void>;

  resume(context: AdapterContext): Promise<void>;

  stop(context: AdapterContext): Promise<void>;

  enterFullscreen(context: AdapterContext): Promise<void>;

  observe(context: AdapterContext): Promise<PlaybackObservation>;

  dismissKnownInterruptions(
    context: AdapterContext
  ): Promise<boolean>;

  recover(
    context: AdapterContext,
    attempt: number
  ): Promise<RecoveryResult>;

  cleanup(context: AdapterContext): Promise<void>;
}
```

## 7.1 Adapter requirements

Every adapter must:

- Be idempotent where practical.
- Use semantic locators before CSS selectors.
- Centralize selectors in one module.
- Emit structured observations.
- Capture screenshots when it encounters an unknown state.
- Respect cancellation.
- Avoid storing credentials.
- Never manipulate decrypted media streams.
- Include a fixture or simulation page for deterministic testing.
- Expose a version string so diagnostics identify the active implementation.

## 7.2 Fake adapter

The fake adapter is not a throwaway mock. It is a production-quality deterministic adapter used to validate orchestration.

It must support configurable scenarios:

- Normal playback.
- Delayed start.
- Buffering.
- Pause and resume.
- End-of-item completion.
- “Are you still watching?” interruption.
- Login-required interruption.
- Playback failure.
- Frozen progress.
- Browser crash simulation.
- Recovery succeeds after N attempts.
- Permanent failure.

Scenario configuration can be placed in `MediaItem.metadata`.

Example:

```json
{
  "scenario": "interrupt-then-recover",
  "durationSeconds": 45,
  "interruptAtSeconds": 15,
  "recoverySucceedsOnAttempt": 2
}
```

---

# 8. Playback state machine

The playback agent must use an explicit state machine rather than a loose loop of conditionals.

```text
IDLE
  -> SELECTING
  -> PREPARING
  -> STARTING
  -> PLAYING
      -> PAUSED
      -> BUFFERING
      -> INTERRUPTION
      -> COMPLETED
      -> FAILED
  -> RECOVERING
      -> PLAYING
      -> FAILED
  -> FINALIZING
  -> IDLE
```

## 8.1 State transition rules

- Only one queue entry may be active.
- Queue selection and status updates must be transactional.
- A process restart must not leave two entries marked active.
- On startup, stale `starting`, `playing`, `paused`, or `recovering` entries must be reconciled.
- Commands must be persisted before execution.
- Duplicate commands must be safely ignored.
- Completion must be recorded before the next entry begins.
- Every state transition must be logged.
- Invalid transitions must throw a typed domain error.

## 8.2 Playback monitoring

During playback, poll adapter state every 2–5 seconds.

Maintain:

- Last observed position.
- Last position-change timestamp.
- Consecutive buffering observations.
- Consecutive unknown observations.
- Last successful screenshot.
- Elapsed wall time.
- Expected completion deadline.

A freeze may be declared when:

- State claims to be playing.
- Position has not advanced for a configurable period.
- No recognized pause or buffering state exists.
- The item has not reached its expected end.

Use conservative thresholds to avoid interrupting legitimate buffering.

---

# 9. Recovery policy

Recovery is a first-class subsystem.

## 9.1 Recovery ladder

Apply actions in this order:

1. Dismiss recognized dialog.
2. Reissue play or resume.
3. Exit and re-enter full screen.
4. Reload current page.
5. Navigate again to the media URL.
6. Open a new page in the same browser context.
7. Restart Chrome while preserving the profile.
8. Restart the playback agent.
9. Mark the entry failed.
10. Start the next queue item or fallback media.
11. Record an alert for remote intervention.

## 9.2 Retry policy

- Each action has its own maximum attempt count.
- Use bounded exponential backoff.
- Do not retry permanent errors indefinitely.
- Authentication-required states should trigger a visible diagnostic and fallback.
- Purchase-required or unavailable-title states should be treated as permanent for that queue execution.
- Circuit-break an adapter after repeated failures across different items.
- Reset the circuit after a configured cooldown or manual action.

## 9.3 Fallback behavior

If no queued item can play:

1. Select the next enabled fallback item.
2. Prefer local media over another browser service.
3. Continue cycling fallback items.
4. Keep the dashboard available.
5. Display an unobtrusive local status screen only when no media can play at all.

---

# 10. Database schema

Use SQLite with migrations.

Required tables:

- `media_items`
- `queue_entries`
- `playlists`
- `playlist_items`
- `schedule_blocks`
- `playback_sessions`
- `playback_events`
- `playback_commands`
- `agent_heartbeats`
- `screenshots`
- `adapter_health`
- `settings`

Important constraints:

- Queue positions must be unique among active queued entries.
- Only one playback session may be marked active.
- Commands must use unique IDs.
- Media-item deletion should be soft deletion when referenced historically.
- Playback events should be append-only.
- Timestamps must be stored in UTC.
- UI must display times in configured local timezone.

---

# 11. API design

Prefix endpoints with `/api/v1`.

## 11.1 Media

```text
GET    /media
POST   /media
GET    /media/:id
PATCH  /media/:id
DELETE /media/:id
POST   /media/:id/play-now
```

## 11.2 Queue

```text
GET    /queue
POST   /queue
PATCH  /queue/:id
DELETE /queue/:id
POST   /queue/reorder
POST   /queue/clear-completed
```

## 11.3 Playback

```text
GET    /playback/state
POST   /playback/pause
POST   /playback/resume
POST   /playback/skip
POST   /playback/restart
POST   /playback/stop
POST   /playback/reload
POST   /playback/restart-browser
```

## 11.4 Scheduling

```text
GET    /schedules
POST   /schedules
PATCH  /schedules/:id
DELETE /schedules/:id
```

## 11.5 Diagnostics

```text
GET    /health
GET    /diagnostics
GET    /diagnostics/events
GET    /diagnostics/screenshots
GET    /diagnostics/screenshots/latest
POST   /diagnostics/test-adapter/:adapterId
```

## 11.6 Agent communication

```text
POST   /agent/register
POST   /agent/heartbeat
POST   /agent/state
POST   /agent/events
GET    /agent/commands/next
POST   /agent/commands/:id/ack
POST   /agent/commands/:id/complete
POST   /agent/commands/:id/fail
```

Use a shared secret for localhost agent authentication even in the MVP.

---

# 12. Dashboard

The UI must be usable from a phone and desktop browser.

## 12.1 Now-playing page

Display:

- Current title.
- Service.
- Playback phase.
- Position and duration.
- Last screenshot.
- Time since last heartbeat.
- Current recovery attempt.
- Next three queue entries.
- Pause, resume, skip, restart, stop, and reload buttons.
- Browser and agent status.
- Clear warning when login or manual intervention is required.

## 12.2 Queue page

Support:

- Add item.
- Edit item.
- Drag-and-drop reorder.
- Enable/disable.
- Remove.
- Play immediately.
- Mark as fallback.
- Duplicate.
- View prior failures.
- Repeat queue toggle.

## 12.3 Schedule page

Support simple blocks:

- Days of week.
- Start time.
- End time.
- Playlist.
- Start or stop behavior.
- Enable/disable.

Do not build a complex calendar interface initially.

## 12.4 Diagnostics page

Display:

- Last 100 structured events.
- Current configuration with secrets redacted.
- Chrome version.
- Playwright version.
- Adapter versions.
- Operating-system information.
- Display dimensions.
- Audio-device status where available.
- Recent screenshots.
- Recent failures grouped by error code.
- Buttons for restarting the browser and agent.

---

# 13. Browser lifecycle

Implement a `BrowserManager` responsible for:

- Starting installed Chrome.
- Using a persistent profile.
- Ensuring only one managed browser instance exists.
- Reconnecting when possible.
- Creating and replacing pages.
- Setting viewport and display behavior.
- Closing stray tabs.
- Detecting browser termination.
- Capturing browser logs.
- Taking screenshots.
- Performing graceful and forced shutdown.

Configuration:

```ts
export interface BrowserConfig {
  executablePath: string;
  userDataDir: string;
  headless: false;
  startupTimeoutMs: number;
  navigationTimeoutMs: number;
  screenshotDir: string;
  browserArgs: string[];
}
```

Do not hard-code Chrome paths. Detect common Windows installation locations and allow explicit override.

---

# 14. Local-media adapter

The local-media adapter should be the most reliable adapter.

Preferred initial implementation:

- Serve local files from the local Fastify server.
- Use a dedicated HTML5 player page.
- Control it with Playwright.
- Support MP4/WebM files that Chrome can decode.
- Read duration and progress from the `<video>` element.
- Support pause, resume, seek, mute, volume, and full screen.
- Report exact completion.
- Support a loop flag.
- Provide a built-in test video or generated test pattern that is safe to commit or generate locally.

Avoid VLC integration for the first version. A separate media player adds process-control complexity before it is needed.

---

# 15. Amazon Prime adapter

This adapter comes after the fake and local adapters.

## 15.1 Assumptions

- User logs into Amazon manually using the persistent Chrome profile.
- Queue entries contain direct title URLs.
- Some titles may require additional payment and must be rejected.
- Page structure will change over time.
- Full automation is not officially supported.
- DRM playback may fail in a VM.

## 15.2 Required behaviors

- Navigate to direct title URL.
- Detect login screen.
- Detect profile chooser when present.
- Detect included-with-Prime versus rent/buy states where practical.
- Select play or resume.
- Enter full-screen mode.
- Observe progress where accessible.
- Detect end screen.
- Dismiss “Are you still watching?” prompts.
- Detect playback error screens.
- Capture screenshots of unknown states.
- Apply recovery ladder.
- Fall back without blocking the queue indefinitely.

## 15.3 Selector strategy

Use this priority order:

1. Accessible role and name.
2. Stable data attributes.
3. Visible text.
4. Scoped CSS selectors.
5. Keyboard shortcuts.
6. Coordinate or image-based fallback only if separately enabled.

All selectors must live in one adapter-specific module and be covered by fixture tests.

---

# 16. Scheduling behavior

The scheduler must be deterministic and timezone-aware.

Initial rules:

- Schedule is evaluated once per minute.
- A block triggers at most once per scheduled occurrence.
- If the application was offline at the exact trigger time, apply a configurable grace window.
- Manual play-now overrides the schedule until the current item ends or is stopped.
- Stop blocks may end current playback.
- Outside scheduled hours, fallback behavior is configurable.
- Daylight-saving transitions must not duplicate or permanently skip events.
- Persist trigger history.

---

# 17. Observability

## 17.1 Logging

Use JSON logs with:

- Timestamp.
- Level.
- Process.
- Component.
- Session ID.
- Queue-entry ID.
- Media-item ID.
- Adapter ID.
- Event type.
- Error code.
- Recovery attempt.
- Duration.

Never log:

- Passwords.
- Cookies.
- Authorization headers.
- Full browser profile data.
- Sensitive query parameters.
- Screenshots by default outside configured retention.

## 17.2 Event types

At minimum:

```text
agent.started
agent.stopped
agent.heartbeat
browser.started
browser.crashed
browser.restarted
queue.item.selected
playback.preparing
playback.started
playback.progress
playback.paused
playback.resumed
playback.buffering
playback.interrupted
playback.completed
playback.failed
recovery.started
recovery.succeeded
recovery.failed
fallback.started
command.received
command.completed
schedule.triggered
```

## 17.3 Screenshot retention

- Take a screenshot on state transitions and errors.
- Optional periodic screenshot every 1–5 minutes.
- Default retention: seven days or a configurable storage limit.
- Redact or avoid screenshots on login pages when practical.
- Dashboard access must require authentication once remote access is enabled.

---

# 18. Security

MVP assumptions:

- Server listens on localhost by default.
- LAN access is opt-in.
- Remote access will eventually use Tailscale.
- No direct router port forwarding.
- No public cloud exposure initially.
- Browser credentials remain in Chrome profile storage.
- Application secrets are stored in environment variables or a protected config file.
- All diagnostic endpoints redact secrets.
- File-serving endpoints must prevent path traversal.
- Local-media directories must be explicitly allow-listed.
- API commands require authentication tokens.
- Use CSRF protection or same-site protections where appropriate.
- Add a confirmation step for destructive actions such as clearing the queue.

---

# 19. Testing strategy

## 19.1 Unit tests

Cover:

- Queue ordering.
- State-machine transitions.
- Retry policy.
- Circuit breaker.
- Schedule evaluation.
- Command deduplication.
- Configuration validation.
- Database repositories.
- Adapter selection.
- Duration and freeze detection.

## 19.2 Integration tests

Cover:

- Server plus SQLite.
- Agent command flow.
- Process restart and state reconciliation.
- Fake adapter scenarios.
- Local-media playback.
- Screenshot creation.
- WebSocket state updates.
- Fallback selection.
- Watchdog restart behavior.

## 19.3 Browser tests

Use local fixture pages that model:

- Play button.
- Resume button.
- Full-screen action.
- End screen.
- Login prompt.
- Profile chooser.
- Buffering state.
- “Are you still watching?”
- Unknown popup.
- Playback error.
- DOM changes.

Do not make normal CI depend on real Amazon or Netflix.

## 19.4 Soak tests

Before installation in the nursing home:

1. Run fake-adapter queue for 24 hours.
2. Inject randomized recoverable failures.
3. Confirm no queue deadlocks.
4. Run local-media playlist for 24 hours.
5. Restart server and agent during playback.
6. Reboot Windows and confirm automatic recovery.
7. Disconnect and reconnect the network.
8. Simulate browser crashes.
9. Fill screenshot storage near its limit.
10. Test smart-plug hard reboot.
11. Run Prime playback on physical hardware for multiple consecutive titles.
12. Leave the system unattended for at least one week before deployment.

---

# 20. Windows startup and production operation

For the VM development stage:

- Use `pnpm dev` or `scripts/start-dev.ps1`.
- Keep browser visible.
- Do not run as a Windows service yet.

For production:

- Use a dedicated Windows account.
- Configure automatic login only on the locked-down appliance.
- Disable sleep and hibernation.
- Configure display never to turn off during active hours.
- Start server, agent, and watchdog automatically.
- Prefer Task Scheduler initially; use NSSM or a packaged Windows service later.
- Configure daily maintenance restart only if testing proves it useful.
- Suppress Windows restart notifications where administratively appropriate.
- Configure Chrome update behavior without permanently disabling security updates.
- Add a remote-controlled smart plug as an external recovery mechanism.
- Keep a wireless keyboard/trackpad onsite.

---

# 21. Configuration

Use `.env` for development and a validated JSON or TOML configuration file for production.

Example:

```env
CAREATV_DATA_DIR=C:\CareTV\data
CAREATV_MEDIA_DIR=C:\CareTV\media
CAREATV_SCREENSHOT_DIR=C:\CareTV\screenshots
CAREATV_LOG_DIR=C:\CareTV\logs
CAREATV_CHROME_PROFILE_DIR=C:\CareTV\chrome-profile
CAREATV_CHROME_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe
CAREATV_SERVER_HOST=127.0.0.1
CAREATV_SERVER_PORT=4310
CAREATV_TIMEZONE=America/Los_Angeles
CAREATV_AGENT_TOKEN=replace-me
CAREATV_DEFAULT_ADAPTER=fake
CAREATV_PERIODIC_SCREENSHOT_SECONDS=120
CAREATV_PROGRESS_POLL_SECONDS=3
```

On startup:

- Validate every configuration value.
- Create required directories.
- Refuse unsafe media paths.
- Print a redacted configuration summary.
- Fail clearly when Chrome cannot be found.

---

# 22. Implementation roadmap

## Phase 0 — Repository bootstrap

Deliver:

- pnpm workspace.
- Strict TypeScript.
- Shared linting and formatting.
- Vitest.
- Basic CI.
- Environment validation.
- README with Windows setup instructions.
- PowerShell start script.

Acceptance criteria:

- Fresh clone can be installed with documented commands.
- `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
- All applications start with placeholder health endpoints.

## Phase 1 — Database and core domain

Deliver:

- SQLite setup and migrations.
- Domain types.
- Queue repository.
- Media repository.
- Command repository.
- Playback-event repository.
- Transactional queue selection.
- State-machine library.

Acceptance criteria:

- Queue survives process restart.
- Only one item can become active.
- Invalid state transitions fail predictably.
- Repository integration tests pass.

## Phase 2 — Fake adapter and agent

Deliver:

- Adapter contract.
- Fake adapter.
- Playback agent.
- Explicit state machine.
- Heartbeats.
- Command polling.
- Recovery ladder.
- Structured events.

Acceptance criteria:

- Five fake items play sequentially.
- Pause/resume/skip/restart work.
- Recoverable failure resumes.
- Permanent failure moves to the next item.
- Agent restart reconciles current state.

## Phase 3 — API and dashboard

Deliver:

- Media CRUD.
- Queue CRUD and reorder.
- Now-playing endpoint.
- Command endpoints.
- WebSocket updates.
- Responsive dashboard.
- Screenshot display.

Acceptance criteria:

- Queue can be fully managed from a phone-sized browser.
- State changes appear without manual refresh.
- Duplicate command submissions do not execute twice.

## Phase 4 — Local-media adapter

Deliver:

- Secure local file serving.
- HTML5 player page.
- Local-media adapter.
- Exact progress and completion.
- Full-screen operation.
- Fallback playlist.

Acceptance criteria:

- Multiple local videos play in sequence.
- End detection is exact.
- Browser and agent restarts recover safely.
- Unsupported files fail without blocking the queue.

## Phase 5 — Scheduling and watchdog

Deliver:

- Schedule blocks.
- Trigger history.
- Watchdog.
- Automatic process restart.
- Storage-retention cleanup.
- Diagnostic page.

Acceptance criteria:

- Scheduled playlist starts once.
- Stop block ends playback.
- Watchdog restarts a killed agent.
- Screenshot retention remains bounded.

## Phase 6 — Prime adapter

Deliver:

- Persistent Chrome context.
- Manual login workflow.
- Direct-title navigation.
- Play/resume.
- Full screen.
- End detection.
- Common interruption handling.
- Prime-specific diagnostics.

Acceptance criteria:

- On physical Windows hardware, three known included-with-Prime titles play sequentially without manual input.
- Login-required and unavailable-title states fall back cleanly.
- Unknown states create useful screenshots and logs.
- A selector change can be corrected within the Prime adapter without modifying orchestration code.

## Phase 7 — Deployment hardening

Deliver:

- Production configuration.
- Task Scheduler or service setup.
- Tailscale operating guide.
- Remote desktop operating guide.
- Smart-plug recovery instructions.
- Installation checklist.
- One-click diagnostic bundle export.

Acceptance criteria:

- Cold Windows reboot returns to playback automatically.
- Family can inspect status and issue commands remotely.
- System survives a seven-day unattended soak test.

---

# 23. Initial Codex tasks

Codex should execute these in order and make small, reviewable commits.

## Task 1: Bootstrap the monorepo

Create:

- pnpm workspace.
- `apps/server`.
- `apps/agent`.
- `apps/web`.
- `apps/watchdog`.
- Shared packages.
- Strict TypeScript.
- ESLint.
- Prettier.
- Vitest.
- Root scripts.
- `.env.example`.
- `.gitignore`.
- Initial README.

Do not add streaming-service code.

## Task 2: Implement configuration

Create a shared config package using Zod.

Requirements:

- Load environment variables.
- Normalize Windows paths.
- Validate ports and timing values.
- Create runtime directories.
- Redact secrets when logged.
- Unit-test valid and invalid configuration.

## Task 3: Implement database package

Use SQLite and migrations.

Implement repositories for:

- Media items.
- Queue entries.
- Commands.
- Playback sessions.
- Playback events.
- Settings.

Add transaction tests and restart persistence tests.

## Task 4: Implement the playback state machine

Create typed states, events, and transition guards.

Requirements:

- No invalid transitions.
- Serialized state updates.
- Append an event for every transition.
- Reconcile stale active state on startup.
- Unit-test every allowed and denied transition.

## Task 5: Implement adapter core and fake adapter

Implement the adapter contract and deterministic scenarios.

Provide a local fixture page so Playwright exercises a real browser page rather than only timers.

## Task 6: Implement playback agent

Implement:

- Browser manager.
- Queue selection.
- Adapter selection.
- Polling.
- Commands.
- State reporting.
- Recovery ladder.
- Graceful shutdown.
- Screenshot capture.

Use fake adapter only.

## Task 7: Implement local API

Implement versioned Fastify endpoints, validation, errors, health checks, and WebSocket updates.

## Task 8: Implement basic dashboard

Implement:

- Now playing.
- Queue.
- Add/edit media.
- Playback controls.
- Diagnostics summary.
- Responsive layout.

Use plain, accessible UI. Do not spend time on branding.

## Task 9: Implement local-media playback

Implement secure file serving and an HTML5 player fixture.

Add local-media queue and fallback tests.

## Task 10: Implement scheduling

Implement daily/weekly blocks with timezone support and trigger deduplication.

## Task 11: Implement watchdog

Start with process health checks and restart commands. Keep operating-system reboot disabled in development.

## Task 12: Add Prime adapter skeleton

Create the module, selector registry, fixture pages, typed observations, and manual-login documentation.

Do not claim real Prime support until it has been tested against the live service.

---

# 24. Coding rules for Codex

1. Keep commits small and focused.
2. Do not introduce a framework without a concrete need.
3. Do not create microservices.
4. Do not use `any` except at explicitly documented external boundaries.
5. Validate all external input.
6. Use typed error codes.
7. Make operations idempotent.
8. Include tests with every domain behavior.
9. Never commit secrets or browser profile data.
10. Never automate DRM bypass or media extraction.
11. Never assume a streaming website's selectors are stable.
12. Keep adapter-specific behavior out of orchestration code.
13. Use dependency injection for clocks, IDs, browser objects, and process controls.
14. Use UTC internally and configured timezone for display/scheduling.
15. Prefer deterministic tests over sleeps.
16. Avoid long-running real streaming tests in CI.
17. Update documentation when behavior changes.
18. Keep the dashboard functional at narrow mobile widths.
19. Emit actionable errors rather than generic failures.
20. Treat recovery and fallback as core behavior, not later polish.

---

# 25. Definition of MVP done

The MVP is complete when all of the following are true:

- The system runs in a Windows VM.
- A user can add and reorder fake and local-media items through the dashboard.
- The agent plays items sequentially in a visible Chrome browser.
- Play, pause, resume, skip, restart, and play-now work.
- Playback state updates appear live.
- Screenshots and structured events are visible.
- Recoverable fake failures recover automatically.
- Permanent failures advance to the next item.
- A local fallback playlist starts when queued items fail.
- State survives server and agent restarts.
- A weekly schedule can start and stop playback.
- The watchdog restarts a failed agent.
- The project has a documented Windows setup process.
- Automated tests cover core queue, state-machine, recovery, scheduling, and local-media flows.
- No real streaming service is required to demonstrate MVP completion.

---

# 26. First prompt to give Codex

Use the following prompt in a new Codex project:

> Build the initial foundation of the CareTV project described in `PROJECT_SPEC.md`. Start only with Phase 0 and Task 1: bootstrap the pnpm TypeScript monorepo, create the proposed application and package structure, configure strict TypeScript, linting, formatting, Vitest, root scripts, environment examples, and a Windows-focused README. Add minimal health-check entry points for the server, agent, and watchdog, and a placeholder React page for the web app. Do not implement the database, Playwright, playback logic, streaming adapters, or scheduling yet. Run all available checks and fix failures. At the end, summarize the files created, commands to run, assumptions made, and the exact next task. Keep the architecture modular but do not create microservices.

After reviewing that commit, give Codex Task 2 rather than asking it to build the entire system in one pass.

---

# 27. Key architectural decision

The first milestone is not Amazon Prime automation.

The first milestone is proving that queue management, state transitions, recovery, restart behavior, scheduling, monitoring, and fallback playback work against deterministic fake and local adapters.

Browser automation against Prime should be treated as a replaceable, brittle edge integration. The rest of the system must remain useful and testable even when that integration is broken.

---

# 28. Hardware and deployment bill of materials

## 28.1 Development and VM testing

The first development environment should use the existing desktop computer rather than purchasing production hardware immediately.

Recommended VM allocation:

- Windows 11 guest.
- 4 virtual CPU cores.
- 8 GB RAM minimum; 12 GB preferred.
- 80–120 GB virtual disk.
- Virtual audio device enabled.
- 1920 × 1080 display resolution.
- 100% Windows display scaling.
- Accelerated 3D graphics enabled when the hypervisor supports it.
- Bridged networking when testing from phones or other LAN devices; NAT is sufficient for local-only work.
- Chrome installed inside the guest.
- A shared folder for source code is acceptable, but the Chrome profile and SQLite database should live on the guest disk.

Do not use the VM as proof that commercial DRM playback will work on the production device. Use it to validate the application, fake adapter, local-media adapter, queue, dashboard, state machine, recovery logic, scheduling, and watchdog. Prime or Netflix playback inside a VM may fail even when the code is correct.

## 28.2 Recommended production computer

### First choice: used Dell OptiPlex 7060 Micro

Target configuration:

- Intel Core i5-8500T.
- 16 GB RAM.
- 256 GB or larger NVMe SSD.
- Windows 11 Pro activated.
- Genuine Dell power adapter.
- Gigabit Ethernet.
- Wi-Fi and Bluetooth preferred but not required.
- BIOS unlocked.
- No asset-management password.
- No Computrace/Absolute lock.
- Seller return policy of at least 30 days.

Why this is the first choice:

- Common corporate lease-return hardware.
- Mature drivers and firmware.
- Easy RAM and storage replacement.
- Good availability of replacement power supplies and mounts.
- More CPU capacity than this application needs.
- Built for continuous business use.

Important display caveat:

Most OptiPlex 7060 Micro units have two DisplayPort outputs. HDMI was an optional configurable rear port, not guaranteed on every unit. Verify the photographs and listing. If the machine does not have native HDMI, use an **active DisplayPort-to-HDMI 2.0 adapter that explicitly carries audio**.

### Second choice: Lenovo ThinkCentre M720q Tiny

Target configuration:

- Intel Core i5-8500T.
- 16 GB RAM.
- 256 GB or larger NVMe SSD.
- Genuine Lenovo power adapter.
- Windows 11 Pro.
- Gigabit Ethernet.
- BIOS unlocked.

Advantages:

- Excellent used-enterprise value.
- Compact and serviceable.
- Common replacement parts.
- Many configurations include both DisplayPort and HDMI, but the exact rear I/O must still be verified from listing photographs.

### Third choice: HP EliteDesk 800 G4 Mini

Target configuration:

- Intel Core i5-8500T or i5-8600T.
- 16 GB RAM.
- 256 GB or larger NVMe SSD.
- Genuine HP power adapter.
- Windows 11 Pro.
- Gigabit Ethernet.
- BIOS unlocked.

This is equivalent in practical suitability to the Dell and Lenovo. Choose among the three based on listing quality, seller reliability, included power adapter, port configuration, and return policy rather than minor CPU differences.

## 28.3 Acceptable lower-cost configurations

The application can run on:

- 8 GB RAM.
- 128 GB SSD.
- Intel Core i5-7500T or similar.

However, prefer an 8th-generation Intel CPU because it offers straightforward official Windows 11 compatibility and more remaining service life.

A machine with 8 GB RAM is acceptable for the initial deployment if the price is meaningfully lower. RAM can be upgraded later. A 128 GB SSD is acceptable only when screenshots, logs, and local fallback media are aggressively limited or stored on external storage.

## 28.4 Used-computer purchase checklist

Do not buy a listing until all of these are confirmed:

- Exact model number.
- CPU model, not merely “Core i5.”
- RAM capacity.
- SSD capacity and type.
- Power adapter included.
- Windows license or activation status.
- Ethernet port present.
- Video-output type visible in photographs.
- No BIOS or administrator password.
- No “for parts,” “untested,” or “as-is” wording.
- No missing drive caddy or Wi-Fi antennas when those are needed.
- Seller has a strong transaction history.
- Returns are accepted.
- Unit is not described as having intermittent power, fan, USB, or display problems.

Prefer a slightly more expensive listing with a tested system, correct power supply, and returns over the absolute cheapest bare unit.

## 28.5 Components to buy with the mini-PC

### Required

#### Display cable or adapter

Preferred order:

1. Native HDMI-to-HDMI cable when the mini-PC has HDMI.
2. Active DisplayPort-to-HDMI 2.0 adapter with audio, plus HDMI cable.
3. USB-C-to-HDMI only when the specific USB-C port supports DisplayPort Alternate Mode.

Requirements:

- 4K/60 capability is preferable even if the TV is 1080p.
- Audio support must be explicit.
- Avoid no-name passive adapters when connecting DisplayPort to a television.
- Use a short cable, typically 6 feet or less, unless the room requires more.

#### Ethernet cable

Use wired Ethernet whenever the nursing-home room provides a usable network jack.

- Cat 5e or Cat 6.
- Appropriate length without a large coil behind the television.
- Add cable clips or hook-and-loop ties.

Wi-Fi is acceptable when Ethernet is unavailable, but remote recovery is less reliable when wireless connectivity is unstable.

#### Wireless keyboard with integrated touchpad

Recommended class:

- Logitech K400 Plus or equivalent.
- USB receiver rather than Bluetooth-only.
- Full keyboard and touchpad in one device.

Keep it labeled and stored in the room for staff or family intervention. A USB receiver is preferable because it works at the Windows login screen and does not depend on Bluetooth pairing state.

#### Smart plug

Use a reputable Wi-Fi smart plug that:

- Can be controlled remotely outside the local network.
- Retains its power state after an outage.
- Supports schedules.
- Has a manual power button.
- Is rated comfortably above the mini-PC and television load.

Only connect the mini-PC to the remotely switched outlet unless there is a deliberate reason to power-cycle the television too. Hard power cycling is the last recovery step, not normal operation.

### Strongly recommended

#### Small UPS

A 400–600 VA UPS is sufficient for the mini-PC, networking equipment in the room, and optionally the television.

Benefits:

- Prevents reboot loops during brief power interruptions.
- Protects SQLite writes and browser-profile data.
- Keeps remote access alive during short outages.

Do not oversize the UPS. Battery replacement cost matters more than runtime for this use case.

#### VESA or under-desk mounting bracket

Mount the mini-PC:

- Behind the television.
- Beside the television mount.
- In a ventilated cabinet.
- Somewhere inaccessible to accidental unplugging but still serviceable.

Do not cover ventilation slots. Use the manufacturer-specific bracket when inexpensive; otherwise use a universal mini-PC mount with straps.

#### External USB storage for fallback media

Use a 500 GB or 1 TB external SSD when maintaining a substantial local fallback library.

Prefer SSD over a portable spinning hard drive because it:

- Tolerates movement better.
- Uses less power.
- Is quieter.
- Has fewer mechanical failure modes.

The application should still work when this drive is disconnected and should report the missing fallback library clearly.

#### USB audio device or speakers

Normally, audio should travel over HDMI to the television.

Add external speakers only when:

- The TV speakers are inadequate.
- The resident needs a speaker placed closer to the chair or bed.
- The facility allows the volume and cabling.

For hearing impairment, speaker placement can matter more than raw volume. Avoid relying on a Bluetooth speaker for unattended operation because pairing and battery state add failure modes.

### Optional

- USB Ethernet adapter as a spare.
- Second active DisplayPort-to-HDMI adapter.
- Spare genuine power adapter.
- Short USB extension cable for the keyboard receiver.
- HDMI dummy plug for lab testing without a physical display.
- Cable labels.
- Velcro cable ties.
- Locking security cable when theft is a realistic concern.
- Basic webcam only if future remote visual confirmation is explicitly desired and privacy approval is obtained.

## 28.6 Remote-access software

### Private networking: Tailscale

Use Tailscale to make the dashboard and administrative endpoints reachable without opening router ports.

Deployment rules:

- Install it on the CareTV computer and the family members' authorized devices.
- Do not expose the dashboard directly to the public internet.
- Use device approval and account multifactor authentication.
- Disable subnet routing and exit-node features unless specifically required.
- Record a recovery procedure for an expired or removed device authorization.

### Remote desktop

Install one primary and one fallback remote-access method.

Preferred options:

- Chrome Remote Desktop for simple unattended access.
- RustDesk when self-hosting or greater control is desired.
- Windows Remote Desktop only when its session behavior has been tested with video and audio; RDP can alter the active display and audio session.

The remote-desktop client must:

- Start automatically.
- Permit unattended access using protected credentials.
- Avoid blanking or replacing the television display during normal troubleshooting when possible.
- Be tested from outside the nursing-home network.

Do not rely on remote desktop as the only control path. The CareTV dashboard and watchdog should handle routine operations.

## 28.7 Network requirements

Before installation, confirm:

- Whether resident devices may connect to facility Wi-Fi.
- Whether captive-portal login is required.
- Whether device registration uses a MAC address.
- Whether streaming services are blocked or rate-limited.
- Whether client isolation prevents local phone-to-device access.
- Whether wired Ethernet is available.
- Whether the facility changes Wi-Fi passwords periodically.
- Whether a personal cellular hotspot or 5G home-internet device is permitted as a fallback.

Captive portals are particularly dangerous for unattended operation. The system should detect loss of general internet access and show it prominently in diagnostics.

## 28.8 Television configuration

Before deployment:

- Reserve one HDMI input for CareTV.
- Label the HDMI input “CareTV” or the resident's name when the television supports input labels.
- Disable television sleep timers.
- Disable automatic power-off where allowed.
- Disable HDMI-CEC behaviors that cause unwanted source changes, or deliberately configure CEC only after testing.
- Set the television to restore the last-used HDMI input after power loss.
- Configure a fixed, safe volume.
- Disable retail/demo mode.
- Record the exact television model and remote-control procedure.
- Keep the original remote labeled and accessible to family or staff.

Do not assume the television will automatically return to the correct HDMI input after an outage. Test this explicitly.

## 28.9 Recommended initial purchasing plan

For development:

- Buy nothing except an adapter or test cable if the desktop lacks a suitable display output.
- Use the Windows VM.
- Develop fake and local playback first.

For physical pilot testing at home:

- Used OptiPlex 7060 Micro, ThinkCentre M720q Tiny, or EliteDesk 800 G4 Mini.
- 16 GB RAM.
- 256 GB SSD.
- Correct active video adapter if required.
- Wireless keyboard/trackpad.
- Ethernet cable.
- Smart plug.

Before nursing-home installation:

- Add the UPS.
- Add mounting hardware.
- Install Tailscale and two remote-desktop paths.
- Add local fallback storage.
- Run the seven-day unattended soak test.
- Document every cable, login, device name, serial number, and recovery step.

## 28.10 What not to buy

Avoid:

- Raspberry Pi for the production streaming player.
- Android TV boxes for this custom browser-automation design.
- ChromeOS devices.
- Mini-PCs with only 4 GB RAM or eMMC storage.
- Sixth-generation or older Intel corporate PCs unless nearly free.
- Listings with missing proprietary power adapters.
- Machines whose only display output requires an obscure proprietary adapter.
- Unknown low-cost mini-PC brands when the device will be deployed remotely.
- Fanless PCs with weak processors and poor vendor support solely because they appear appliance-like.
- Consumer Wi-Fi extenders as a substitute for diagnosing the actual network.
- Bluetooth-only keyboards or speakers for critical recovery.
- A large, expensive GPU-equipped mini-PC; it adds cost, heat, and failure surface without helping this workload.

## 28.11 Production hardware acceptance test

Before deployment, the exact physical kit must pass:

1. Cold boot with no keyboard attached.
2. Automatic Windows login.
3. Automatic CareTV startup.
4. Correct HDMI picture and audio.
5. 24-hour local-media playback.
6. 24-hour fake-adapter fault injection.
7. Multiple Prime titles on the physical device.
8. Network disconnect and reconnect.
9. Browser crash and automatic restart.
10. Agent-process kill and watchdog restart.
11. Smart-plug hard reboot.
12. Brief UPS power-loss test.
13. Remote dashboard access from a phone outside the local network.
14. Remote-desktop access from a second network.
15. Television power cycle returning to the proper input.
16. Full recovery after Windows Update and reboot.
17. Verification that logs and screenshots remain within storage limits.
18. Confirmation that no credentials are written to application logs.

