#!/usr/bin/env bash
# Runnable production deploy.
# Builds client+server, syncs the client build to the Caddy-served dir,
# restarts the API and reloads Caddy. Safe to re-run.
#
# Caddy runs as the `caddy` user and cannot traverse /root (mode 700),
# so the client build MUST be served from a world-readable path
# (/var/www/runnable), not directly from the install dir.
set -euo pipefail

INSTALL_DIR=/root/runnable
WEB_DIR=/var/www/runnable

cd "$INSTALL_DIR"

# Resolve the public domain for the post-deploy verification check.
# Priority: $DEPLOY_URL override > BASE_DOMAIN from .env > skip verify.
BASE_DOMAIN=$(grep -E '^BASE_DOMAIN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
DEPLOY_URL=${DEPLOY_URL:-${BASE_DOMAIN:+https://$BASE_DOMAIN}}

echo "==> git pull"
git pull --ff-only

echo "==> npm install (in case deps changed)"
npm install

echo "==> build (client + server)"
npm run build

echo "==> sync client build -> $WEB_DIR (Caddy serves from here; /root is 700 and unreadable by caddy)"
mkdir -p "$WEB_DIR"
rsync -a --delete "$INSTALL_DIR/client/dist/" "$WEB_DIR/"
find "$WEB_DIR" -type d -exec chmod 755 {} +
find "$WEB_DIR" -type f -exec chmod 644 {} +

echo "==> restart API"
systemctl restart runnable

echo "==> reload Caddy"
systemctl reload caddy

echo "==> verify"
sleep 2
systemctl is-active runnable
BUILT=$(grep -o "index-[A-Za-z0-9_-]*\.js" "$WEB_DIR/index.html" | head -1)
if [ -z "${DEPLOY_URL:-}" ]; then
  echo "⚠️  BASE_DOMAIN not set in .env and no DEPLOY_URL given — skipping live check."
  echo "    built bundle: $BUILT (services restarted)."
  exit 0
fi
BUNDLE=$(curl -s "$DEPLOY_URL/" | grep -o "index-[A-Za-z0-9_-]*\.js" | head -1)
echo "url:          $DEPLOY_URL"
echo "live bundle:  $BUNDLE"
echo "built bundle: $BUILT"
if [ "$BUNDLE" = "$BUILT" ] && [ -n "$BUNDLE" ]; then
  echo "✅ Deploy OK — live site serving the fresh build."
else
  echo "❌ Mismatch — live bundle != built bundle. Check Caddy root + $WEB_DIR." >&2
  exit 1
fi
