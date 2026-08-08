#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/caretv"
BRANCH="main"
DOMAIN=""
REPO_URL=""
AUTH_TOKEN=""
ADMIN_IP="107.217.177.172"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/setup-linux-vps.sh --domain caretv.example.com --repo https://github.com/you/caretv.git [--branch main] [--token TOKEN] [--admin-ip IP]

What it does:
  - installs Node.js 22, pnpm via corepack, git, and Caddy
  - clones or updates CareTV into /opt/caretv/current
  - generates /etc/caretv/server.env
  - builds the API and web UI
  - runs the API as systemd service caretv-server
  - serves the web UI and HTTPS through Caddy
  - enables UFW: allows 22, 80, 443, and full access from --admin-ip

Prereqs:
  - Ubuntu/Debian VPS
  - DNS A/AAAA record for --domain points at this VPS
  - ports 80 and 443 allowed by the VPS provider firewall, if one exists
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --repo)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --token)
      AUTH_TOKEN="${2:-}"
      shift 2
      ;;
    --admin-ip)
      ADMIN_IP="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script with sudo/root." >&2
  exit 1
fi

if [[ -z "$DOMAIN" || -z "$REPO_URL" ]]; then
  usage
  exit 2
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script targets Ubuntu/Debian systems with apt-get." >&2
  exit 1
fi

CURRENT_DIR="$APP_DIR/current"
RUNTIME_DIR="/var/lib/caretv/runtime"
MEDIA_DIR="/var/lib/caretv/media"
CHROME_DIR="/var/lib/caretv/chrome-profile"
ENV_DIR="/etc/caretv"
ENV_FILE="$ENV_DIR/server.env"

resolve_auth_token() {
  if [[ -n "$AUTH_TOKEN" ]]; then
    return
  fi

  if [[ -f "$ENV_FILE" ]]; then
    AUTH_TOKEN="$(grep -E '^CARETV_AUTH_TOKEN=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  fi

  if [[ -z "$AUTH_TOKEN" ]]; then
    AUTH_TOKEN="$(openssl rand -hex 32)"
  fi
}

install_base_packages() {
  apt-get update
  apt-get install -y ca-certificates curl debian-keyring debian-archive-keyring gnupg git openssl ufw
}

configure_firewall() {
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing

  ufw allow proto tcp to any port 22
  ufw allow proto tcp to any port 80
  ufw allow proto tcp to any port 443

  if [[ -n "$ADMIN_IP" ]]; then
    ufw allow from "$ADMIN_IP" to any
  fi

  ufw --force enable
}

install_node() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [[ "$major" != "22" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  corepack enable
}

install_caddy() {
  if command -v caddy >/dev/null 2>&1; then
    return
  fi

  apt-get install -y apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
}

ensure_user_and_dirs() {
  if ! id caretv >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin caretv
  fi

  install -d -o caretv -g caretv "$APP_DIR" "$RUNTIME_DIR" "$MEDIA_DIR" "$CHROME_DIR"
  install -d -m 0755 "$ENV_DIR"
}

sync_repo() {
  if [[ -d "$CURRENT_DIR/.git" ]]; then
    runuser -u caretv -- git -C "$CURRENT_DIR" fetch origin "$BRANCH"
    runuser -u caretv -- git -C "$CURRENT_DIR" checkout "$BRANCH"
    runuser -u caretv -- git -C "$CURRENT_DIR" pull --ff-only origin "$BRANCH"
    return
  fi

  if [[ -e "$CURRENT_DIR" ]]; then
    echo "$CURRENT_DIR exists but is not a git checkout. Move it aside or remove it, then rerun." >&2
    exit 1
  fi

  runuser -u caretv -- git clone --branch "$BRANCH" "$REPO_URL" "$CURRENT_DIR"
}

write_env() {
  cat > "$ENV_FILE" <<EOF
CARETV_HOST=127.0.0.1
CARETV_SERVER_PORT=4010
CARETV_WEB_PORT=4020
CARETV_RUNTIME_DIR=$RUNTIME_DIR
CARETV_CHROME_PROFILE_DIR=$CHROME_DIR
CARETV_TIMEZONE=America/Los_Angeles
CARETV_SERVER_URL=https://$DOMAIN
CARETV_AUTH_TOKEN=$AUTH_TOKEN
CARETV_APPLIANCE_ID=vps-server
CARETV_APPLIANCE_NAME=VPS Server
CARETV_APPLIANCE_POLL_MS=1000
CARETV_APPLIANCE_HEARTBEAT_MS=5000
CARETV_APPLIANCE_PLAYBACK_OBSERVE_MS=1000
CARETV_APPLIANCE_REQUEST_TIMEOUT_MS=10000
CARETV_APPLIANCE_MEDIA_DIR=$MEDIA_DIR
CARETV_APPLIANCE_MEDIA_SCAN_MS=30000
EOF
  chmod 0600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
}

build_app() {
  cd "$CURRENT_DIR"
  runuser -u caretv -- corepack pnpm install --frozen-lockfile
  runuser -u caretv -- corepack pnpm --filter './packages/*' build
  runuser -u caretv -- corepack pnpm --filter @caretv/server build
  runuser -u caretv -- corepack pnpm --filter @caretv/web build
}

write_systemd_service() {
  cat > /etc/systemd/system/caretv-server.service <<EOF
[Unit]
Description=CareTV API server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=caretv
Group=caretv
WorkingDirectory=$CURRENT_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $CURRENT_DIR/apps/server/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable caretv-server
  systemctl restart caretv-server
}

write_caddyfile() {
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode zstd gzip

  reverse_proxy /api/* 127.0.0.1:4010
  reverse_proxy /health 127.0.0.1:4010

  root * $CURRENT_DIR/apps/web/dist
  try_files {path} /index.html
  file_server
}
EOF

  caddy fmt --overwrite /etc/caddy/Caddyfile
  systemctl enable caddy
  systemctl reload caddy || systemctl restart caddy
}

install_base_packages
configure_firewall
resolve_auth_token
install_node
install_caddy
ensure_user_and_dirs
sync_repo
write_env
build_app
write_systemd_service
write_caddyfile

cat <<EOF

CareTV VPS setup complete.

Dashboard:
  https://$DOMAIN/?token=$AUTH_TOKEN

Appliance config:
  CARETV_SERVER_URL=https://$DOMAIN
  CARETV_AUTH_TOKEN=$AUTH_TOKEN

Useful commands:
  systemctl status caretv-server
  journalctl -u caretv-server -f
  systemctl status caddy
  ufw status verbose

Keep the token private. It is stored on the server at:
  $ENV_FILE
EOF
