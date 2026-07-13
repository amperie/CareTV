# CareTV

CareTV is a local-first television automation system for a resident who cannot reliably use
a remote. The first milestone is not commercial streaming automation. It is a reliable queue,
state model, dashboard, fake adapter, local-media playback, recovery, and watchdog foundation.

## Current Status

This repository currently contains the Phase 0/1 local prototype:

- pnpm TypeScript workspace
- server control plane
- web dashboard
- appliance agent
- shared package structure
- SQLite repositories for media, queue, commands, events, settings, and appliance heartbeat
- fake playback adapter and state machine
- strict TypeScript, ESLint, Prettier, and Vitest configuration
- Windows-focused startup script

Real streaming-service automation is not implemented yet. The current playback path is deterministic
fake playback used to prove queue orchestration, remote appliance polling, state reporting, and
dashboard controls.

## Requirements

- Windows 11 for the target development VM
- Node.js LTS
- Corepack enabled for pnpm
- Google Chrome installed later, before browser playback work starts

## Setup

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

## Development

Start the server, dashboard, and local appliance agent:

```powershell
.\scripts\start-dev.ps1
```

Or run directly:

```powershell
pnpm dev
```

Default local endpoints:

- server health: `http://127.0.0.1:4010/health`
- web dashboard: `http://127.0.0.1:4020`

In deployment, the server/dashboard can run on a hosted machine and the appliance agent runs on the
TV appliance. The appliance polls the server for queue work and commands, executes playback locally,
and reports heartbeat/state/events back to the server.

## Fake Playback Lab

The dashboard can add fake media items, enqueue them, start/stop playback, toggle loop, edit queued
items, and show appliance state/event output.

1. Start the local server, dashboard, and appliance:

   ```powershell
   .\scripts\start-dev.ps1
   ```

2. Open `http://127.0.0.1:4020`.
3. Add one or more fake items.
4. Click `Start`.
5. Watch the output panel, queue statuses, and event log update as items play through.

The playback is deterministic fake playback only. It does not open Chrome or use any streaming
service yet.

## Appliance Configuration

The appliance agent reads these environment variables:

- `CARETV_SERVER_URL`: server base URL, default `http://127.0.0.1:4010`
- `CARETV_APPLIANCE_ID`: stable appliance id, default `local-appliance`
- `CARETV_APPLIANCE_NAME`: dashboard display name, default `Local Appliance`

For local development, `pnpm dev` starts the appliance against the local server. For a separate TV
appliance, run `pnpm --filter @caretv/appliance-agent dev` with `CARETV_SERVER_URL` pointing at the
hosted server.

## Runtime Data

Runtime data must stay outside source control. Use `.env.example` as the starting point and
store browser profiles, SQLite databases, screenshots, and logs under a runtime directory such
as `C:\CareTV\runtime`.

## Next Task

Add a dedicated output-only route/window and then start the first real playback adapter, ideally
local file or YouTube before attempting DRM-heavy services.
