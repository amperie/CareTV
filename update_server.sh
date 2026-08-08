#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/caretv/current}"
BRANCH="${BRANCH:-main}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo/root." >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR is not a git checkout. Run scripts/setup-linux-vps.sh first." >&2
  exit 1
fi

cd "$APP_DIR"

runuser -u caretv -- git pull --ff-only origin "$BRANCH"
runuser -u caretv -- corepack pnpm install --frozen-lockfile
runuser -u caretv -- corepack pnpm --filter './packages/*' build
runuser -u caretv -- corepack pnpm --filter @caretv/server build
runuser -u caretv -- corepack pnpm --filter @caretv/web build

systemctl restart caretv-server
systemctl reload caddy

echo "CareTV server updated from origin/$BRANCH."
