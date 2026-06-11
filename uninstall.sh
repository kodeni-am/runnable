#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Runnable — Uninstall Script
# Removes Runnable and all its data from the server.
#
# Usage:
#   chmod +x uninstall.sh
#   sudo ./uninstall.sh
#
# Options:
#   --keep-db       Keep the PostgreSQL database and user
#   --keep-docker   Keep Docker containers and images
#   --yes           Skip confirmation prompt
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="/opt/runnable"
KEEP_DB=false
KEEP_DOCKER=false
SKIP_CONFIRM=false

# ── Parse Arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --keep-db)     KEEP_DB=true; shift ;;
        --keep-docker) KEEP_DOCKER=true; shift ;;
        --yes|-y)      SKIP_CONFIRM=true; shift ;;
        -h|--help)
            echo "Usage: sudo $0 [--keep-db] [--keep-docker] [--yes]"
            exit 0 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Must run as root
if [[ $EUID -ne 0 ]]; then
    echo "❌ This script must be run as root (sudo)."
    exit 1
fi

# ── Confirmation ─────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     ⚠  Runnable — Complete Uninstall                ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  This will permanently remove:                      ║"
echo "║    • Runnable service and application files          ║"
echo "║    • Client web root (/var/www/runnable)             ║"
echo "║    • All hosted project data                        ║"
echo "║    • Caddy site configs for Runnable                ║"
if [[ "$KEEP_DB" == false ]]; then
echo "║    • PostgreSQL database and user                   ║"
fi
if [[ "$KEEP_DOCKER" == false ]]; then
echo "║    • Docker containers and images (runnable-*)      ║"
fi
echo "║    • Sandbox users (runnable-*)                     ║"
echo "║    • Log files                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

if [[ "$SKIP_CONFIRM" == false ]]; then
    read -rp "Are you sure you want to continue? (type 'yes' to confirm): " CONFIRM
    if [[ "$CONFIRM" != "yes" ]]; then
        echo "Aborted."
        exit 0
    fi
fi

log()  { echo -e "\n\033[1;34m▸ $1\033[0m"; }
ok()   { echo -e "\033[1;32m  ✅ $1\033[0m"; }
warn() { echo -e "\033[1;33m  ⚠  $1\033[0m"; }

# ══════════════════════════════════════════════════════════════════════════════
# 1. STOP SERVICES
# ══════════════════════════════════════════════════════════════════════════════
log "Stopping Runnable service..."
systemctl stop runnable 2>/dev/null || true
systemctl disable runnable 2>/dev/null || true
rm -f /etc/systemd/system/runnable.service
systemctl daemon-reload
ok "Service stopped and removed"

# ══════════════════════════════════════════════════════════════════════════════
# 2. REMOVE DOCKER CONTAINERS & IMAGES
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$KEEP_DOCKER" == false ]]; then
    log "Removing Runnable Docker containers and images..."
    # Stop and remove all runnable containers
    docker ps -a --filter "name=runnable-" --format '{{.Names}}' 2>/dev/null | while read -r name; do
        docker rm -f "$name" 2>/dev/null || true
    done
    # Remove runnable images
    docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep "runnable-" | while read -r img; do
        docker rmi -f "$img" 2>/dev/null || true
    done
    # Remove BuildKit container
    docker rm -f runnable-buildkit 2>/dev/null || true
    ok "Docker resources cleaned"
else
    warn "Keeping Docker containers and images (--keep-docker)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 3. REMOVE SANDBOX USERS
# ══════════════════════════════════════════════════════════════════════════════
log "Removing sandbox users..."
getent passwd | grep "^runnable-" | cut -d: -f1 | while read -r user; do
    pkill -u "$user" 2>/dev/null || true
    userdel "$user" 2>/dev/null || true
done
# Remove cgroups
rm -rf /sys/fs/cgroup/runnable/ 2>/dev/null || true
ok "Sandbox users removed"

# ══════════════════════════════════════════════════════════════════════════════
# 4. REMOVE DATABASE
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$KEEP_DB" == false ]]; then
    log "Removing PostgreSQL database and user..."
    if command -v psql &>/dev/null; then
        sudo -u postgres psql -c "DROP DATABASE IF EXISTS runnable;" 2>/dev/null || true
        sudo -u postgres psql -c "DROP USER IF EXISTS runnable;" 2>/dev/null || true
        ok "Database and user dropped"
    else
        warn "PostgreSQL not found, skipping database removal"
    fi
else
    warn "Keeping database (--keep-db)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 5. REMOVE CADDY CONFIGS
# ══════════════════════════════════════════════════════════════════════════════
log "Removing Caddy site configs..."
rm -f /etc/caddy/sites/runnable*.caddyfile 2>/dev/null || true
rm -f /etc/caddy/sites/*.caddyfile 2>/dev/null || true
# Remove Runnable blocks from master Caddyfile (restore to empty)
if [[ -f /etc/caddy/Caddyfile ]]; then
    # Back up the current Caddyfile before overwriting it
    cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.uninstall
    echo "  Existing Caddyfile backed up to /etc/caddy/Caddyfile.bak.uninstall"
    # Keep Caddy running but remove Runnable-specific config
    cat > /etc/caddy/Caddyfile << 'EOF'
# Caddyfile — Runnable config removed by uninstall
{
    admin localhost:2019
}
EOF
    systemctl reload caddy 2>/dev/null || true
fi
ok "Caddy configs removed"

# ══════════════════════════════════════════════════════════════════════════════
# 6. REMOVE APPLICATION FILES
# ══════════════════════════════════════════════════════════════════════════════
log "Removing application files..."
rm -rf "$INSTALL_DIR"
ok "Application directory removed ($INSTALL_DIR)"

# ══════════════════════════════════════════════════════════════════════════════
# 7. REMOVE PROJECT DATA
# ══════════════════════════════════════════════════════════════════════════════
log "Removing project data..."
rm -rf /var/runnable
ok "Project data removed (/var/runnable)"
rm -rf /var/www/runnable
ok "Client web root removed (/var/www/runnable)"

# ══════════════════════════════════════════════════════════════════════════════
# 8. REMOVE LOGS
# ══════════════════════════════════════════════════════════════════════════════
log "Removing log files..."
rm -f /var/log/caddy/api.log 2>/dev/null || true
rm -f /var/log/caddy/client.log 2>/dev/null || true
journalctl --rotate 2>/dev/null || true
journalctl --vacuum-time=1s -u runnable 2>/dev/null || true
ok "Logs cleaned"

# ══════════════════════════════════════════════════════════════════════════════
# DONE
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         ✅ Runnable Uninstall Complete!              ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║                                                      ║"
echo "║  The following were NOT removed (install separately):║"
echo "║    • Node.js                                        ║"
echo "║    • Docker                                         ║"
echo "║    • PostgreSQL (server)                            ║"
echo "║    • Caddy (server)                                 ║"
echo "║                                                      ║"
echo "║  To remove those too:                               ║"
echo "║    apt remove nodejs docker-ce postgresql-16 caddy   ║"
echo "║                                                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
