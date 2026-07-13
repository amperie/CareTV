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

## Architecture

CareTV is split into a control plane and an appliance runtime. The control plane owns the dashboard,
API, queue, commands, appliance heartbeat, and SQLite database. The appliance runtime polls the
control plane, claims queued work, runs playback locally, and reports state/events back.

```mermaid
flowchart LR
  subgraph Operator["Family / Operator Device"]
    Browser["Web browser"]
  end

  subgraph Control["CareTV Control Plane"]
    Web["apps/web\nReact dashboard"]
    Server["apps/server\nFastify API"]
    DB[("SQLite\nmedia, queue, commands,\nevents, settings, appliances")]
  end

  subgraph Appliance["TV Appliance / Mini-PC"]
    ApplianceAgent["apps/appliance-agent\npolling runtime"]
    Adapter["Fake adapter today\nlocal/streaming adapters later"]
    Display["TV output"]
  end

  subgraph Shared["Shared Workspace Packages"]
    Core["@caretv/core\ndomain types"]
    Config["@caretv/config\nenv/runtime paths"]
    Database["@caretv/database\nrepositories + migrations"]
    State["@caretv/state-machine\nplayback transitions"]
    Adapters["@caretv/adapters\nadapter contract + fake adapter"]
    Playback["@caretv/playback-agent\nin-process fake runner"]
  end

  Browser --> Web
  Web --> Server
  Server <--> DB
  ApplianceAgent -->|polls playback settings,\nclaims queue items,\nfetches commands/media| Server
  ApplianceAgent -->|heartbeats,\nstate, events,\nqueue status| Server
  ApplianceAgent --> Adapter
  Adapter --> Display

  Server -.uses.-> Config
  Server -.uses.-> Database
  Server -.uses.-> Core
  ApplianceAgent -.uses.-> Core
  ApplianceAgent -.uses.-> Config
  ApplianceAgent -.uses.-> State
  ApplianceAgent -.uses.-> Adapters
  Playback -.uses.-> Database
  Playback -.uses.-> State
  Playback -.uses.-> Adapters
```

### Runtime Flow

1. The dashboard calls `apps/server` over `/api/v1` to create fake media, manage the queue, start or
   stop playback, toggle loop mode, and issue commands.
2. The server persists media, queue entries, playback commands, appliance heartbeats, and events in
   SQLite through `@caretv/database`.
3. `apps/appliance-agent` polls the server for playback settings. When playback is enabled, it claims
   the next queued entry and fetches the media item.
4. The appliance selects an adapter. Today that is the deterministic fake adapter in
   `@caretv/adapters`; later this boundary is where local media, YouTube, Prime, or other browser
   adapters plug in.
5. The appliance uses `@caretv/state-machine` to turn observations and commands into explicit
   playback states, then reports heartbeats/events/status updates back to the server.
6. The dashboard reads `/api/v1/playback/status` to show queue state, appliance state, and recent
   events.

### Package Responsibilities

- `apps/server`: local Fastify API, CORS handling for the dashboard, SQLite ownership, operator
  endpoints, and appliance polling endpoints.
- `apps/web`: browser dashboard for the fake playback lab.
- `apps/appliance-agent`: polling process intended to run on the TV-connected appliance.
- `apps/agent`: older local placeholder entry point retained while the appliance runtime evolves.
- `apps/watchdog`: placeholder for process health checks and restart behavior.
- `@caretv/core`: shared domain types and health helpers.
- `@caretv/config`: environment loading, validation, path normalization, and redacted config output.
- `@caretv/database`: SQLite migrations and repositories.
- `@caretv/adapters`: playback adapter contract plus deterministic fake adapter.
- `@caretv/state-machine`: allowed playback transitions and event generation.
- `@caretv/playback-agent`: in-process fake playback runner used by the server-side prototype path.

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
- `CARETV_APPLIANCE_POLL_MS`: control/queue polling interval, default `1000`
- `CARETV_APPLIANCE_HEARTBEAT_MS`: idle heartbeat interval, default `5000`
- `CARETV_APPLIANCE_PLAYBACK_OBSERVE_MS`: playback observation/progress interval, default `1000`

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
