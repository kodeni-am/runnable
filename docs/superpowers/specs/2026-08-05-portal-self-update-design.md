# Portal Self-Update — Design

**Date:** 2026-08-05
**Status:** Draft — awaiting review

## Goal

Let an admin update the Runnable instance itself from the portal: see that a
newer commit exists on the tracked branch, read what it contains, and apply it
with one button — performing exactly what `deploy.sh` does today, plus an
automatic rollback if the new revision fails to build or fails to come back
healthy.

## Scope

In scope:

- Background check (hourly) for commits on the tracked upstream branch, plus a
  manual "Check now" that bypasses the interval.
- One-click update running the existing deploy steps out-of-process.
- Automatic rollback to the previous commit when the update fails.
- Live progress in the UI that survives the API restarting mid-update.
- Admin-only, one update at a time.

Out of scope (explicitly deferred):

- Applying updates automatically without a human pressing the button.
- Release channels, version pinning, or downgrading to an arbitrary commit.
- Orchestrating several instances from one portal.
- Reverting database migrations. See "Rollback reverts code, not data".

## The core constraint

`deploy.sh` ends with `systemctl restart runnable`. The API cannot run its own
update as a child process: systemd's default `KillMode=control-group` kills
every process in the service's cgroup on restart, so the updater would be
killed partway through — after `git pull`, possibly mid-build, with no one left
to finish or roll back. `nohup` and `setsid` do not help; they detach from the
session, not from the cgroup.

The updater therefore runs in **its own transient systemd unit**:

```
systemd-run --unit=runnable-update --collect /run/runnable-update.sh
```

`systemd-run` places the script in a fresh unit outside the API's cgroup, so
`systemctl restart runnable` leaves it untouched. Nothing needs to be
pre-installed on the host, which matters: the existing instances must be able
to take this feature through the normal deploy, without an SSH visit to install
a unit file first.

Consequence: **the API is not the source of truth for update progress.** It is
offline for 10–30s in the middle. The source of truth is a state file on disk;
the API only reads it.

## Components

Three units with one responsibility each. The API asks about and triggers
updates; it never performs one.

### 1. `update.sh` (repo root)

The whole update-and-rollback procedure, in bash, with no knowledge of the API.
Can be run by hand on a box, which is how it gets verified.

Phases, each written to the state file as it begins:

```
PREV=$(git rev-parse HEAD)     # recorded before anything mutates
pulling      git pull --ff-only
installing   npm ci --ignore-scripts
building     npm run build          ─┐
syncing      rsync -> $WEB_DIR       │ any failure jumps to rollback
restarting   systemctl restart runnable
             systemctl reload caddy  │
verifying    poll /api/health, 60s  ─┘
done
```

Rollback runs the same steps against `$PREV`: `git reset --hard $PREV`,
install, build, sync, restart, verify. If rollback itself fails it stops at
`failed_rollback` and reports loudly. **No retry loops** — this path executes
precisely when something is already wrong, so it must stay dumb and
predictable.

`--dry-run` runs every step except the mutating ones (`git pull`,
`git reset`, `rsync`, `systemctl`), so the script can be exercised on a real
host without changing it.

**The script must copy itself before running.** `git pull` rewrites
`update.sh` while bash is still reading it, and bash reads scripts
incrementally by byte offset — an in-place rewrite mid-run causes arbitrary
misexecution. The API does `install -m700 update.sh /run/runnable-update.sh`
and runs the copy.

### 2. `UpdateService` (`server/src/services/update.service.ts`)

- `check({ force })` — `git fetch origin --quiet`, then `git rev-list --count
  HEAD..@{u}` and `git log --oneline HEAD..@{u}`. Caches the result with a
  timestamp. Concurrent calls share one in-flight fetch rather than issuing
  several. A failed fetch surfaces the error but **leaves the previous cached
  result intact**, with its original timestamp — stale-but-true beats blank.
- `status()` — merges the cached check with the on-disk state file.
- `start()` — preflight, claim, then trigger. Never performs the update itself.

  **Amended 2026-08-05 after review.** The original design checked the phase and
  then launched, which was a time-of-check/time-of-use snapshot: the state file
  is written only by the spawned script, so between `start()` returning and the
  updater's first write, `readState()` still reported a terminal phase and a
  second caller passed every gate. `start()` now:

  1. writes an atomic `phase: 'pulling'` claim (temp file + `rename`) after
     preflight passes and before launching, so the window closes;
  2. copies the script via a temp path plus `rename` rather than writing the
     destination in place, so a second launch cannot truncate a script a
     running bash is still reading by byte offset;
  3. maps a `systemd-run` unit collision to a 409 and **leaves the state file
     untouched** on that path — the collision means another updater owns the
     claim, and overwriting it would report `failed` during a live update;
  4. reverts the claim to `phase: 'failed'` on any other launch failure, so a
     failed launch cannot wedge the instance at `pulling` forever.
- Hourly timer following the existing `HealthMonitorService.setInterval`
  pattern, started from `bootstrap()`.

Preflight refusals:

| Condition | Status | Reasoning |
|---|---|---|
| an update is already in progress (state file in a non-terminal phase) | 409 | conflicting state, retryable later |
| working tree is dirty (`git status --porcelain` non-empty) | 409 | `git pull --ff-only` would fail anyway; refuse with a clear reason instead |
| not a git checkout, or no upstream branch configured | 409 | the feature does not apply to this install |
| nothing to update (`behind === 0`) | 400 | the request asks for something meaningless; no `force` override — an update with nothing to apply is a restart, not an update |

### 3. State and log files

Durable, outside the repo, following the existing build-log convention
(`path.resolve(config.hosting.servDir, '..')`, i.e. `/var/runnable`):

- `/var/runnable/update.log` — human-readable, tailed by the UI
- `/var/runnable/update-state.json` — `{ phase, prevCommit, newCommit,
  startedAt, finishedAt, error }`

They must live outside the repo: `git reset --hard` during rollback would
otherwise delete the log that explains why the rollback happened.

**Stale claims (added 2026-08-05 during execution).** `update.sh` installs an
EXIT trap that writes a terminal phase on abnormal termination, but no process
can trap `SIGKILL` — an OOM kill, a power loss, or a script that dies before
its first write (say `/run` mounted `noexec`) still strands a non-terminal
phase. Since `start()` refuses on any non-terminal phase, that would wedge the
instance permanently, recoverable only by deleting the state file over SSH.
`readState()` therefore treats a non-terminal claim older than
`STALE_CLAIM_MS` (60 minutes) as `failed`, so the instance heals itself. A
missing or unparseable `startedAt` on a non-terminal phase counts as stale —
an unmeasurable claim must not be able to wedge anything. Terminal phases are
never rewritten by age, and `readState` stays a pure read: repairing the file
here would race an updater that may still own it.

Sixty minutes is deliberately generous. Declaring a live update dead is worse
than waiting, because it would let a second updater launch on top of the first.

### 4. API (`server/src/routes/system.routes.ts`, already admin-gated)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/system/update` | current commit, behind count, commit list, last check, phase |
| `POST` | `/api/system/update/check` | force a fetch now, return fresh status |
| `POST` | `/api/system/update` | preflight and trigger; 409 if already running |
| `GET` | `/api/system/update/log` | tail the update log |

`system.routes.ts` already applies `authenticate, requireRole(Role.ADMIN)` at
the router level, so these inherit admin-only access.

### 5. Client — Admin → System → Updates

Shows current commit, "up to date" or "N updates available" with the commit
subjects, last-checked time, a **Check now** button, and an **Update now**
button. While an update runs it polls `/api/system/update` and the log.

The UI must treat connection-refused during the `restarting` phase as
**expected**, not as failure — otherwise every successful update looks like a
crash at the moment it succeeds. Polling continues until the state file reaches
a terminal phase or a generous overall timeout elapses.

## Rollback reverts code, not data

TypeORM runs migrations on boot (`migrationsRun: true`) and does not revert
them. Rollback therefore restores **code only**; the database stays migrated.

This is safe today because every existing migration is additive
(`ADD COLUMN IF NOT EXISTS`), and older code ignores columns it does not know
about. This design promotes that from a habit to an **invariant**:

> A migration must leave the database readable and writable by the previous
> release. No dropping or renaming a column still referenced by the previous
> release in the same version that stops using it — split it across two.

To be documented in `docs/` alongside this spec, because the safety of the
rollback button now depends on it.

## Error handling

- The state file doubles as the lock; a non-terminal phase makes `POST
  /api/system/update` return 409.
- Health verification uses the existing unauthenticated `/api/health`
  (`server/src/index.ts:220`).
- A `git fetch` failure is reported without discarding cached results.
- `failed_rollback` is terminal and loud: the instance may be on a
  half-updated tree and needs a human.

## Testing

- `UpdateService` unit tests with mocked `execFile`: parsing `git rev-list` and
  `git log` output; every preflight refusal; concurrent-check dedupe; cache
  retention on fetch failure; missing and corrupt state JSON.
- `update.sh --dry-run` exercised on a host.
- The bash happy path is **not** unit tested. A mock asserting bash would have
  worked proves nothing about a script whose entire job is real side effects.
  Verification is a dry run plus one real update on a staging instance, and
  this spec says so rather than implying coverage that does not exist.

## Assumptions

- The server has working git credentials for the origin remote. `deploy.sh`
  already runs `git pull` there, so this holds today.
- The service runs as root (`User=root` in the unit installed by `setup.sh`),
  so `systemctl` and `systemd-run` are available to it without sudo.
- The install is a git checkout tracking an upstream branch. An instance
  deployed some other way cannot use this feature; the UI reports that rather
  than failing obscurely.
