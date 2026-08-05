#!/usr/bin/env bash
# Runnable self-update, launched by UpdateService.start via:
#   systemd-run --unit=runnable-update --collect \
#     --setenv=INSTALL_DIR=... --setenv=STATE_DIR=... /run/runnable-update.sh
#
# Runs in its own transient systemd unit so that `systemctl restart runnable`
# partway through does not kill it. Never run this from inside the API process.
#
# This file is copied to /run before execution: `git pull` rewrites it, and
# bash reads scripts incrementally, so running it in place corrupts execution.
set -uo pipefail

INSTALL_DIR=${INSTALL_DIR:?INSTALL_DIR must be set}
STATE_DIR=${STATE_DIR:?STATE_DIR must be set}
WEB_DIR=${WEB_DIR:-/var/www/runnable}
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

LOG="$STATE_DIR/update.log"
STATE="$STATE_DIR/update-state.json"
HEALTH_URL=${HEALTH_URL:-http://localhost:3001/api/health}
VERIFY_TIMEOUT=${VERIFY_TIMEOUT:-60}

mkdir -p "$STATE_DIR"
cd "$INSTALL_DIR"

PREV=$(git rev-parse HEAD)
NEW=""
STARTED_AT=$(date -Iseconds)

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

# Written atomically: the API reads this file concurrently and must never see
# a half-written document.
write_state() {
    local phase=$1 error=${2:-null} finished=${3:-null}
    local new_json="null"
    [ -n "$NEW" ] && new_json="\"$NEW\""
    [ "$error" != "null" ] && error="\"${error//\"/\\\"}\""
    [ "$finished" != "null" ] && finished="\"$finished\""
    cat > "$STATE.tmp" <<JSON
{
  "phase": "$phase",
  "prevCommit": "$PREV",
  "newCommit": $new_json,
  "startedAt": "$STARTED_AT",
  "finishedAt": $finished,
  "error": $error
}
JSON
    mv "$STATE.tmp" "$STATE"
}

run() {
    if [ "$DRY_RUN" = 1 ]; then
        log "DRY RUN: $*"
        return 0
    fi
    "$@" >>"$LOG" 2>&1
}

wait_healthy() {
    local deadline=$((SECONDS + VERIFY_TIMEOUT))
    while [ $SECONDS -lt $deadline ]; do
        if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    return 1
}

# Rebuild and restart whatever is currently checked out. Used by both the
# forward path and the rollback path so they cannot drift apart.
build_and_restart() {
    run npm ci --ignore-scripts || return 1
    run npm run build || return 1
    run mkdir -p "$WEB_DIR" || return 1
    run rsync -a --delete "$INSTALL_DIR/client/dist/" "$WEB_DIR/" || return 1
    run find "$WEB_DIR" -type d -exec chmod 755 {} + || return 1
    run find "$WEB_DIR" -type f -exec chmod 644 {} + || return 1
    run systemctl restart runnable || return 1
    run systemctl reload caddy || return 1
    return 0
}

rollback() {
    local reason=$1
    log "FAILED: $reason — rolling back to $PREV"
    write_state rolling_back "$reason"

    if ! run git reset --hard "$PREV"; then
        log "ROLLBACK FAILED: could not reset to $PREV"
        write_state failed_rollback "Rollback failed: could not reset to $PREV" "$(date -Iseconds)"
        exit 1
    fi
    if ! build_and_restart; then
        log "ROLLBACK FAILED: previous revision no longer builds"
        write_state failed_rollback "Rollback failed: previous revision no longer builds" "$(date -Iseconds)"
        exit 1
    fi
    # Deliberately no retry loop: this path runs when something is already
    # wrong, so it stays dumb and predictable.
    if ! wait_healthy; then
        log "ROLLBACK FAILED: service unhealthy after rollback"
        write_state failed_rollback "Rollback failed: service unhealthy after restoring $PREV" "$(date -Iseconds)"
        exit 1
    fi
    log "Rolled back to $PREV successfully"
    write_state failed "$reason" "$(date -Iseconds)"
    exit 1
}

: > "$LOG"
log "Starting update from $PREV (dry-run=$DRY_RUN)"

write_state pulling
run git pull --ff-only || rollback "git pull failed"
NEW=$(git rev-parse HEAD)
log "Updating $PREV -> $NEW"

write_state installing
run npm ci --ignore-scripts || rollback "npm ci failed"

write_state building
run npm run build || rollback "build failed"

write_state syncing
run mkdir -p "$WEB_DIR" || rollback "could not create $WEB_DIR"
run rsync -a --delete "$INSTALL_DIR/client/dist/" "$WEB_DIR/" || rollback "rsync failed"
run find "$WEB_DIR" -type d -exec chmod 755 {} + || rollback "chmod dirs failed"
run find "$WEB_DIR" -type f -exec chmod 644 {} + || rollback "chmod files failed"

write_state restarting
run systemctl restart runnable || rollback "service restart failed"
run systemctl reload caddy || rollback "caddy reload failed"

write_state verifying
if [ "$DRY_RUN" = 1 ]; then
    log "DRY RUN: skipping health verification"
else
    wait_healthy || rollback "service did not become healthy within ${VERIFY_TIMEOUT}s"
fi

log "Update complete: $PREV -> $NEW"
write_state done null "$(date -Iseconds)"
