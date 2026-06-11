# Build-Cache GC Cap — Design

Date: 2026-06-11
Status: Approved

## Problem

Every deploy builds an image (compose builds via the Docker daemon's BuildKit;
railpack/Dockerfile builds via the dedicated `runnable-buildkit` container).
Nothing ever prunes the resulting build cache, so it grows by roughly the size
of the changed layers on every deploy. Observed in production: 19.85 GB of
build cache (223 entries, 0 active, all reclaimable) — ~10 GB of disk growth
over a few weeks of deploys.

## Goal

An admin-configurable cap on build-cache size, set from the Runnable UI and
enforced by Runnable itself — no Docker daemon restarts, no host config edits.

## Decisions

- **Enforcement: app-driven prune.** Runnable runs prune commands after each
  build, keyed to a cap stored in the database. Rejected alternatives:
  - *Native `daemon.json` GC*: requires restarting dockerd on every change,
    which bounces all running deployed projects.
  - *Hybrid (daemon.json safety net + app prune)*: more moving parts than the
    problem needs.
- **UI scope: cap + current usage + "Prune now"** in a System section on the
  existing Admin page. A bare cap field would be unobservable; a full disk
  dashboard is more than the problem needs.
- **Default: 10 GB, enabled.** Existing installs start getting GC on their
  next deploy. `0` (or empty in the UI) disables enforcement.
- **"Prune now" prunes down to the cap**, not to zero. When the cap is `0`
  (enforcement disabled), "Prune now" performs a full prune instead — the
  button stays useful as a manual-only mode.

## Components

### 1. Setting storage — `AppSettings.buildCacheKeepGB`

New integer column on the existing `app_settings` singleton entity
(`server/src/entities/AppSettings.ts`), default `10`. `0` means disabled.

New `AppSettingsService` (`server/src/services/appSettings.service.ts`):
`get()` returns the singleton row (creating it with defaults if absent);
`update(partial)` persists changes. The entity currently has no accessor —
only `data-source.ts` references it — so this service is new shared
infrastructure, kept minimal.

### 2. Enforcement — `BuildCacheService`

`server/src/services/buildCache.service.ts`, public surface:

- `enforceCap(): Promise<void>` — reads the cap; no-op when `0`. Otherwise:
  1. `docker builder prune -f --keep-storage=<cap>G` — trims the Docker
     daemon's builder cache (compose builds).
  2. If `runnable-buildkit` is Up:
     `docker exec runnable-buildkit buildctl prune --keep-storage=<bytes>` —
     trims the dedicated railpack builder.
- `usage(): Promise<{ daemonBytes: number; buildkitBytes: number }>` — parses
  `docker system df --format json` (BuildCache total) and
  `docker exec runnable-buildkit buildctl du` (sum; `0` if container down).
- `pruneToCap(): Promise<{ freedBytes: number }>` — same commands as
  `enforceCap`, but measures usage before/after and returns the delta. When
  the cap is `0`, runs a full prune (`docker builder prune -af` and
  `buildctl prune` with no keep-storage) instead of being a no-op.

Concurrency: a single in-flight promise guard — if an enforcement run is
already active, a new call returns the active run instead of starting another.
BuildKit itself never evicts cache referenced by an in-flight build, so
pruning concurrently with builds is safe.

Failures (docker down, container missing) are logged and swallowed in
`enforceCap`; surfaced as errors from `usage`/`pruneToCap` (the API needs
them).

Call site: `process.service.ts`, fire-and-forget after a build completes, in
**both** deployment paths (compose and railpack). Never awaited on the deploy
critical path; never fails a deploy.

### 3. API — `system.routes.ts` (already admin-gated)

- `GET /api/system/build-cache` →
  `{ usageBytes, daemonBytes, buildkitBytes, keepGB }`
- `PUT /api/system/build-cache` — body `{ keepGB }`, validated as an integer
  in `[0, 500]`; persists via `AppSettingsService`.
- `POST /api/system/build-cache/prune` → `{ freedBytes }` via `pruneToCap()`.

Docker failures return 500 with a short stderr snippet in `error`.

### 4. UI — System card on Admin page

New section in `client/src/pages/Admin.tsx` following its existing card/form
style, plus matching functions in `client/src/api/admin.ts` (or a small
`system.ts` API module mirroring the routes):

- Current build-cache usage, displayed in GB.
- Cap input (number, GB; empty/0 = disabled) with Save.
- "Prune now" button; on success shows "Freed X.X GB" and refreshes usage.
- Errors shown inline, matching Admin's existing error states.

## Error handling summary

| Failure | Behavior |
|---|---|
| Docker unavailable (API) | 500 + stderr snippet; inline UI error |
| Docker unavailable (post-build enforcement) | log, continue; deploy unaffected |
| `runnable-buildkit` not running | skip buildkit prune; report `buildkitBytes: 0` |
| Invalid cap value | 400 from PUT validation |

## Testing

Pure helpers unit-tested in `server/src/services/__tests__/`, matching the
existing `preview.helpers` pattern:

- prune-command construction from a cap value (including the disabled case)
- `docker system df --format json` parsing → BuildCache bytes
- `buildctl du` output parsing → bytes
- GB ↔ bytes conversion

Route/UI behavior verified manually (no existing route-test harness to match).

## Out of scope

- `/etc/docker/daemon.json` changes (unnecessary under app-driven prune).
- One-time reclaim of the existing ~20 GB on the production server — an ops
  action, done via the new "Prune now" button after deploying, or one SSH
  command.
- Per-project caps, scheduled prunes, image/volume/log pruning.
