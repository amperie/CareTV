# CareTV Current Architecture And Backlog

This file replaces the original planning dump. The old content mixed requirements, prompts,
hardware notes, and phase instructions that no longer matched the repository. Treat this file as the
short current docs companion to `README.md`.

## Goal

CareTV lets an operator manage television playback for a resident who cannot reliably use a remote.
The system should eventually run unattended on a TV-connected Windows mini-PC, while family or staff
control media and playback through a dashboard.

## Current Implementation

Control plane:

- `apps/server` runs the Fastify API.
- SQLite is stored under `runtimeDir`.
- The server owns media, playlists, queue entries, playback commands, playback events, settings,
  uploads, appliance downloads, local media deletions, and appliance heartbeat state.
- The server exposes dashboard endpoints and appliance polling endpoints under `/api/v1`.

Dashboard:

- `apps/web` is a React/Mantine dashboard.
- Tabs: Main, Media, Fallback, Logs.
- Main controls playback start/stop, pause/resume/restart/skip, loop mode, queue order, play-now,
  clear-completed, and lab reset.
- Media supports uploads, discovered local media, streaming URL queueing, playlist create/edit/queue,
  and media deletion.
- Fallback manages the YouTube fallback playlist and fallback toggle.
- Logs shows a 24-hour event/command timeline from the server database.

Appliance:

- `apps/appliance-agent` is the active TV-side runtime.
- It polls the server for playback settings, commands, queue work, downloads, and deletion jobs.
- It sends heartbeat, playback state, queue status updates, media inventory, and playback events
  back to the server.
- Normal operation requires only outbound appliance access to `serverUrl`.

Adapters:

- `FakeStreamingAdapter`: deterministic test playback.
- `LocalFileAdapter`: visible Chrome local-file playback.
- `YouTubeVideoAdapter`: early browser automation for YouTube URLs.
- `PrimeVideoAdapter`: early browser automation for Prime URLs.

Shared packages:

- `@caretv/core`: domain types.
- `@caretv/config`: config file/env loading and runtime directory creation.
- `@caretv/database`: SQLite migrations and repositories.
- `@caretv/state-machine`: playback transitions and generated events.
- `@caretv/adapters`: adapter contract and browser/video helpers.
- `@caretv/playback-agent`: older in-process runner retained for test/prototype use.

## Runtime Data

Keep runtime data outside source control:

- SQLite database: `runtimeDir\caretv.sqlite`
- upload staging: `runtimeDir\uploads`
- Chrome profile: `chromeProfileDir`
- appliance local media: `applianceMediaDir`
- process logs: currently whatever the shell, scheduled task, or future service wrapper captures

The current code does not create a first-class log directory despite older docs mentioning one.

## Logging Reality

Dashboard logs are not raw appliance logs. `/api/v1/logs` is synthesized from:

- `playback_events`
- `playback_commands`

The server filters out noisy `PLAYING` and `HEARTBEAT` events. Local-only failures can still require
checking the appliance console, Task Scheduler history, Chrome, or process-manager output.

## Security Reality

The prototype has permissive CORS and no production authentication layer. Do not expose it directly
to the public internet. Before remote deployment, add authentication, HTTPS termination, request
limits appropriate for uploads, and an operations story for secrets.

## Hardware Reality

Use physical Windows hardware with a real HDMI display for final playback validation. DRM services
can fail under VM, remote desktop, capture, or protected-video-path constraints even when the
application logic is correct.

## Near-Term Backlog

1. Add durable appliance process logging and a bounded support bundle.
2. Decide whether the appliance should run as a Windows service, scheduled task, or packaged app.
3. Add authentication before internet exposure.
4. Implement watchdog restart behavior or delete the placeholder watchdog app.
5. Validate local-file playback on the target TV hardware.
6. Harden YouTube and Prime selector/blocker handling with real fixture pages.
7. Add screenshot capture for unknown playback states with redaction rules.
8. Add an appliance diagnostics page that separates server-side events from local process health.
9. Package deployment so production setup does not require a source checkout and pnpm.

## Removed Stale Assumptions

- Netflix, Plex, slideshow, and scheduling remain domain types only; they are not implemented
  production features.
- There is no automatic streaming catalog discovery.
- There is no production remote-access or auth story yet.
- There is no complete centralized appliance log pipeline yet.
- The watchdog is not an implemented restart supervisor.
- The historical phase prompts are no longer authoritative project documentation.
