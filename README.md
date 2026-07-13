# CareTV

CareTV is a local-first television automation system for a resident who cannot reliably use
a remote. The first milestone is not commercial streaming automation. It is a reliable queue,
state model, dashboard, fake adapter, local-media playback, recovery, and watchdog foundation.

## Current Status

This repository contains the Phase 0 scaffold:

- pnpm TypeScript workspace
- server, agent, watchdog, and web app shells
- shared package structure
- strict TypeScript, ESLint, Prettier, and Vitest configuration
- Windows-focused startup script

No database, Playwright automation, streaming adapter, scheduling, or playback logic has been
implemented yet.

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

Start all placeholder processes:

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

## Runtime Data

Runtime data must stay outside source control. Use `.env.example` as the starting point and
store browser profiles, SQLite databases, screenshots, and logs under a runtime directory such
as `C:\CareTV\runtime`.

## Next Task

Implement Task 2 from the project spec: a shared configuration package using Zod that loads and
validates environment variables, normalizes Windows paths, creates runtime directories, and logs a
redacted configuration summary.
