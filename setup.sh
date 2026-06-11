#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Runnable — Ubuntu Server Setup Script
# Installs and configures everything needed to run Runnable in production.
# Tested on Ubuntu 22.04 / 24.04 LTS
#
# Usage:
#   chmod +x setup.sh
#   sudo ./setup.sh --domain yourdomain.com --email admin@yourdomain.com
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
DOMAIN=""
ADMIN_EMAIL=""
INSTALL_DIR="/opt/runnable"
WEB_DIR="/var/www/runnable"
REPO_URL=""
BRANCH="main"
DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)
ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '/+=' | head -c 16)

# ── Parse Arguments ──────────────────────────────────────────────────────────
usage() {
    echo "Usage: sudo $0 --domain <domain> --email <admin-email> [--repo <git-url>] [--branch <branch>]"
    echo ""
    echo "Options:"
    echo "  --domain   Base domain for Runnable (e.g. runnable.dev)"
    echo "  --email    Admin email address"
    echo "  --repo     Git repository URL (default: current directory)"
    echo "  --branch   Git branch to clone (default: main)"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --domain)  DOMAIN="$2"; shift 2 ;;
        --email)   ADMIN_EMAIL="$2"; shift 2 ;;
        --repo)    REPO_URL="$2"; shift 2 ;;
        --branch)  BRANCH="$2"; shift 2 ;;
        -h|--help) usage ;;
        *)         echo "Unknown option: $1"; usage ;;
    esac
done

if [[ -z "$DOMAIN" || -z "$ADMIN_EMAIL" ]]; then
    echo "❌ --domain and --email are required."
    usage
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo -e "\n\033[1;34m▸ $1\033[0m"; }
ok()   { echo -e "\033[1;32m  ✅ $1\033[0m"; }
warn() { echo -e "\033[1;33m  ⚠  $1\033[0m"; }

# Must run as root
if [[ $EUID -ne 0 ]]; then
    echo "❌ This script must be run as root (sudo)."
    exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Runnable — Production Setup Script          ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Domain:   $DOMAIN"
echo "║  Email:    $ADMIN_EMAIL"
echo "║  Install:  $INSTALL_DIR"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# 1. SYSTEM PACKAGES
# ══════════════════════════════════════════════════════════════════════════════
log "Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    curl wget git build-essential software-properties-common \
    ca-certificates gnupg lsb-release unzip jq
ok "System packages installed"

# ══════════════════════════════════════════════════════════════════════════════
# 2. NODE.JS 20 LTS
# ══════════════════════════════════════════════════════════════════════════════
log "Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi
ok "Node.js $(node -v) installed"

# ══════════════════════════════════════════════════════════════════════════════
# 3. DOCKER
# ══════════════════════════════════════════════════════════════════════════════
log "Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi
ok "Docker $(docker --version | awk '{print $3}') installed"

# ══════════════════════════════════════════════════════════════════════════════
# 4. POSTGRESQL 16
# ══════════════════════════════════════════════════════════════════════════════
log "Installing PostgreSQL 16..."
if ! command -v psql &>/dev/null; then
    sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg
    apt-get update -qq
    apt-get install -y -qq postgresql-16
fi
systemctl enable postgresql
systemctl start postgresql
ok "PostgreSQL 16 installed"

# Detect an existing install — re-use its DB password and preserve its .env
# (regenerating would wipe operator-filled OAuth keys and rotate JWT secrets)
ENV_FILE="${INSTALL_DIR}/.env"
FRESH_ENV=true
if [[ -f "$ENV_FILE" ]]; then
    FRESH_ENV=false
    EXISTING_DB_PASSWORD=$(grep -E '^DATABASE_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)
    if [[ -n "$EXISTING_DB_PASSWORD" ]]; then
        DB_PASSWORD="$EXISTING_DB_PASSWORD"
    else
        # Hand-written .env without DATABASE_PASSWORD: persist the generated
        # one so the ALTER USER below doesn't desync the file from the DB
        echo "DATABASE_PASSWORD=${DB_PASSWORD}" >> "$ENV_FILE"
        warn "Existing .env had no DATABASE_PASSWORD — appended a generated one"
    fi
    warn "Existing .env found — keeping its DATABASE_PASSWORD and secrets"
fi

# Create database and user (password kept in sync with .env on re-runs)
log "Configuring PostgreSQL database..."
if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='runnable'" | grep -q 1; then
    # User exists — update password to match the new .env
    sudo -u postgres psql -c "ALTER USER runnable WITH PASSWORD '${DB_PASSWORD}';"
else
    sudo -u postgres psql -c "CREATE USER runnable WITH PASSWORD '${DB_PASSWORD}';"
fi
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='runnable'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE runnable OWNER runnable;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE runnable TO runnable;" 2>/dev/null || true
ok "Database 'runnable' configured"

# ══════════════════════════════════════════════════════════════════════════════
# 5. CADDY (Master Reverse Proxy)
# ══════════════════════════════════════════════════════════════════════════════
log "Installing Caddy..."
if ! command -v caddy &>/dev/null; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
fi
ok "Caddy $(caddy version 2>&1 | head -1) installed"

# Create Caddy directories
mkdir -p /etc/caddy/sites
mkdir -p /var/log/caddy

# Write master Caddyfile
log "Configuring Caddy..."
cat > /etc/caddy/Caddyfile <<EOF
# Runnable — Master Caddyfile
# Auto-generated by setup.sh

{
    admin localhost:2019
    email ${ADMIN_EMAIL}

    # Preview environments use on-demand TLS; Caddy asks the API before
    # issuing a cert so only live preview hostnames get one.
    on_demand_tls {
        ask http://localhost:3001/api/internal/tls-check
    }
}

# API server
api.${DOMAIN} {
    reverse_proxy localhost:3001
    encode gzip zstd
    log {
        output file /var/log/caddy/api.log
    }
}

# Client (static build)
${DOMAIN} {
    encode gzip zstd

    # Deterministic ordering — API/WebSocket MUST be matched before SPA fallback
    route {
        # Proxy API to backend
        reverse_proxy /api/* localhost:3001

        # Proxy WebSocket to backend
        reverse_proxy /socket.io/* localhost:3001

        # SPA: root must be set before try_files
        # Served from ${WEB_DIR} (deploy.sh syncs the build here; Caddy
        # cannot read the install dir when its parents are mode 700)
        root * ${WEB_DIR}
        try_files {path} /index.html
        file_server
    }

    log {
        output file /var/log/caddy/client.log
    }
}

# Import per-project configs
import /etc/caddy/sites/*.caddyfile
EOF
ok "Caddy master config written"

# ══════════════════════════════════════════════════════════════════════════════
# 6. RAILPACK (Universal App Builder)
# ══════════════════════════════════════════════════════════════════════════════
log "Installing Railpack..."
if ! command -v railpack &>/dev/null; then
    curl -sSL https://railpack.com/install.sh | bash
fi
ok "Railpack installed"

# ══════════════════════════════════════════════════════════════════════════════
# 7. START BUILDKIT DAEMON
# ══════════════════════════════════════════════════════════════════════════════
log "Starting BuildKit daemon..."
if ! docker ps --filter name=runnable-buildkit --format '{{.Status}}' | grep -q "Up"; then
    docker rm -f runnable-buildkit 2>/dev/null || true
    docker run -d --name runnable-buildkit --privileged --restart unless-stopped moby/buildkit:latest
fi
ok "BuildKit daemon running"

# ══════════════════════════════════════════════════════════════════════════════
# 8. CLONE / COPY APPLICATION
# ══════════════════════════════════════════════════════════════════════════════
log "Setting up application at ${INSTALL_DIR}..."
if [[ -n "$REPO_URL" ]]; then
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        cd "$INSTALL_DIR" && git pull origin "$BRANCH"
    else
        git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    fi
else
    # Copy from current directory if no repo specified
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
        mkdir -p "$INSTALL_DIR"
        rsync -a --exclude node_modules --exclude dist --exclude .git \
            "$SCRIPT_DIR/" "$INSTALL_DIR/"
    fi
fi
ok "Application code ready"

# ══════════════════════════════════════════════════════════════════════════════
# 9. ENVIRONMENT FILE
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$FRESH_ENV" == true ]]; then
log "Generating .env..."
cat > "${INSTALL_DIR}/.env" <<EOF
# ── Database ──
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=runnable
DATABASE_USER=runnable
DATABASE_PASSWORD=${DB_PASSWORD}

# ── JWT ──
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}

# ── Server ──
PORT=3001
NODE_ENV=production
CLIENT_URL=https://${DOMAIN}

# ── Admin ──
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}

# ── Hosting ──
SERV_DIR=/var/runnable/projects
BASE_DOMAIN=${DOMAIN}
API_BASE_URL=https://api.${DOMAIN}
MAX_UPLOAD_SIZE_MB=512

# ── GitHub OAuth (fill in after creating GitHub App) ──
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=https://${DOMAIN}/api/auth/github/callback

# ── Google OAuth (optional) ──
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=https://${DOMAIN}/api/auth/google/callback

# ── Caddy ──
CADDY_CONFIG_DIR=/etc/caddy/sites
CADDY_ADMIN_API=http://localhost:2019

# ── Sandbox ──
SANDBOX_ENABLED=true
SANDBOX_USER_PREFIX=runnable-
EOF
chmod 600 "${INSTALL_DIR}/.env"
ok "Environment file generated"
else
    log "Preserving existing .env..."
    chmod 600 "${INSTALL_DIR}/.env"
    ok "Existing .env preserved (secrets and OAuth keys untouched)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 10. INSTALL DEPENDENCIES & BUILD
# ══════════════════════════════════════════════════════════════════════════════
log "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production=false
ok "Dependencies installed"

log "Building client and server..."
npm run build
ok "Build complete"

# Publish client build to the Caddy web root (same path deploy.sh syncs to)
log "Publishing client build to ${WEB_DIR}..."
mkdir -p "$WEB_DIR"
rsync -a --delete "${INSTALL_DIR}/client/dist/" "$WEB_DIR/"
find "$WEB_DIR" -type d -exec chmod 755 {} +
find "$WEB_DIR" -type f -exec chmod 644 {} +
ok "Client build published to ${WEB_DIR}"

# Create project storage directories
mkdir -p /var/runnable/projects
mkdir -p "${INSTALL_DIR}/server/storage/logs"
mkdir -p "${INSTALL_DIR}/server/storage/caddy/sites"

# ══════════════════════════════════════════════════════════════════════════════
# 11. SYSTEMD SERVICE
# ══════════════════════════════════════════════════════════════════════════════
log "Creating systemd service..."
cat > /etc/systemd/system/runnable.service <<EOF
[Unit]
Description=Runnable API Server
After=network.target postgresql.service docker.service
Requires=postgresql.service docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/server/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=BUILDKIT_HOST=docker-container://runnable-buildkit
EnvironmentFile=${INSTALL_DIR}/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=runnable

# Security
NoNewPrivileges=false
ProtectSystem=false

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable runnable
ok "Systemd service created"

# ══════════════════════════════════════════════════════════════════════════════
# 12. START SERVICES
# ══════════════════════════════════════════════════════════════════════════════
log "Starting services..."
systemctl restart caddy
systemctl start runnable
ok "All services started"

# ══════════════════════════════════════════════════════════════════════════════
# DONE
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              ✅ Runnable Setup Complete!                ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                        ║"
echo "║  🌐 Dashboard:  https://${DOMAIN}"
echo "║  🔌 API:        https://api.${DOMAIN}"
echo "║                                                        ║"
if [[ "$FRESH_ENV" == true ]]; then
echo "║  👤 Admin Login:                                       ║"
echo "║     Email:    ${ADMIN_EMAIL}"
echo "║     Password: ${ADMIN_PASSWORD}"
else
echo "║  👤 Admin Login: unchanged (existing .env preserved)   ║"
fi
echo "║                                                        ║"
echo "║  📁 Install:    ${INSTALL_DIR}"
echo "║  📋 Logs:       journalctl -u runnable -f              ║"
echo "║  🔄 Restart:    systemctl restart runnable              ║"
echo "║                                                        ║"
echo "║  ⚠  DNS Required:                                      ║"
echo "║     Point these records to this server's IP:           ║"
echo "║     • ${DOMAIN}       → A record"
echo "║     • api.${DOMAIN}   → A record"
echo "║     • *.${DOMAIN}     → A record (wildcard for projects)║"
echo "║                                                        ║"
echo "║  🔐 GitHub OAuth:                                      ║"
echo "║     Create an app at github.com/settings/developers    ║"
echo "║     Callback: https://${DOMAIN}/api/auth/github/callback"
echo "║     Then update GITHUB_CLIENT_ID/SECRET in .env        ║"
echo "║                                                        ║"
echo "║  🔐 Google OAuth (optional):                           ║"
echo "║     Create credentials at console.cloud.google.com     ║"
echo "║     Callback: https://${DOMAIN}/api/auth/google/callback"
echo "║     Then update GOOGLE_CLIENT_ID/SECRET in .env        ║"
echo "║                                                        ║"
echo "  • PR previews (optional): point a wildcard DNS record"
echo "      *.preview.${DOMAIN}  →  this server's IP"
echo "    then set the preview base domain to 'preview.${DOMAIN}' per project."
echo "║                                                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
if [[ "$FRESH_ENV" == true ]]; then
echo "⚠  IMPORTANT: Save these credentials! The admin password"
echo "   is randomly generated and shown only once."
else
echo "ℹ  Existing .env preserved — credentials, JWT secrets and"
echo "   OAuth keys were NOT regenerated."
fi
echo ""
