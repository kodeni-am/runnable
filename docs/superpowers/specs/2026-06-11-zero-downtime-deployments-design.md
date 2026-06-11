# Zero-Downtime Deployments — Design

**Date:** 2026-06-11
**Status:** Approved pending user review

## Problem

Today every redeploy is stop → build → start: the old container (or whole
compose stack) is killed before the new image even builds
(`process.service.ts` — `redeploy()` calls `doStop()` then `doStart()`).
A 5-minute build means 5+ minutes of downtime, and a *failed* build leaves
the site down entirely.

## Goal

Redeploys keep serving traffic on the old version until the new version is
built and responding, then switch routing. A failed deploy never takes the
running site down.

**Decisions made during brainstorming:**

- Blue-green strategy (build alongside, health-gate, switch proxy, retire old).
- Health gate = the new container answers an HTTP request on its published
  port (any status code counts). No per-project health path for v1.
- Covers both single-container (Railpack) and Docker Compose projects.
- Compose stacks that cannot safely run twice fall back automatically — but
  to an *in-place diff update* (no `down`), not to the old full-teardown flow.
- Default **on** for all projects, with a per-project toggle to disable.

## Strategy tiers

| Tier | Applies to | Strategy | Downtime |
|------|-----------|----------|----------|
| 1 | Single container (Railpack/Dockerfile) | Full blue-green | Zero |
| 2 | Compose, stack safe to run twice | Full blue-green (parallel stack) | Zero |
| 3 | Compose, stateful/unsafe stack | In-place diff update (`up` without `down`) | Zero for unchanged services; ~1–3 s for recreated ones |
| — | `zeroDowntime` disabled, or first start / explicit restart | Current behavior | Build + start time |

### Compose safety detection (tier 2 vs tier 3)

After `docker compose config` (already run and parsed for the security
policy, `process.service.ts:179-193`), the normalized YAML is scanned. The
stack is **unsafe to run twice** (→ tier 3) if any of:

- Any service mounts a **volume** of any kind — named, external, or bind
  mount. (Named volumes would be re-prefixed and start empty in the parallel
  stack; external volumes and bind mounts would be concurrently written by
  two instances — worse.)
- Any service publishes a **fixed host port** (`"5432:5432"`); the parallel
  stack would collide.
- Any service sets **`container_name`**; Docker container names are global.

The chosen tier and, for tier 3, the reason, are written to the build log,
e.g. `Zero-downtime: in-place update (stack mounts volumes: db:/var/lib/postgresql/data)`.

## Mechanics

All of this lives in `ProcessService`. `redeploy()` and `redeployExclusive()`
route to a new `doDeploy()` instead of `doStop()`+`doStart()` when:
the project is an APP, `zeroDowntime` is enabled, and something is currently
running (`containerId` set and status RUNNING/ERROR-with-live-container).
Otherwise they keep today's path. In all three tiers `doDeploy()` sets
status to `DEPLOYING` for the duration (the old version is still serving) and
restores `RUNNING` on success or failure-with-old-alive.
`start()`, `stop()`, `restart()`, and the
health monitor's `restartIfStillError()` are **unchanged** — an explicit
restart means "restart", and the health monitor only acts when the old
container is already dead, so there is nothing to keep alive.

### Tier 1 — single container blue-green

Today's container name is `runnable-<id8>`. New scheme: a generation suffix,
`runnable-<id8>-blue` / `runnable-<id8>-green`. `project.containerId` keeps
holding the **active** container's full name; the incoming deploy uses the
other color. (Migration: a running unsuffixed `runnable-<id8>` container is
treated as the active one and retired normally after the first blue-green
deploy.)

1. Status → `DEPLOYING` (not `BUILDING`) — the site is still up. Emit to
   clients as today.
2. Remove any leftover container with the *incoming* name (orphan from a
   crashed previous deploy).
3. Build exactly as today (build command + Railpack → `runnable-img-<id8>`).
   Re-tagging the image does not affect the running old container; the old
   image just becomes dangling (the existing `BuildCacheService.enforceCap()`
   pass covers cleanup).
4. `docker run` the incoming container (other color), dynamic host port, same
   flow as today's step 3.
5. Port-wait loop as today, **plus the HTTP health gate**: poll
   `http://127.0.0.1:<hostPort>/` (2 s timeout per attempt, 1 s between
   attempts, 60 s total). Any HTTP response — including 500 — counts as
   ready; only connect failures/timeouts don't.
6. On healthy: regenerate proxy config with the new port, write, reload
   (Caddy/nginx/Apache reloads are all graceful — in-flight requests on the
   old upstream complete).
7. Grace period (10 s), then `docker stop` (SIGTERM + Docker's 10 s grace)
   and `docker rm` the old container.
8. Update `project.containerId`/`port`, status → `RUNNING`.

**On any failure (build, run, health gate):** remove the incoming container,
leave the old container and proxy config untouched, set status back to
`RUNNING`, record the Deployment row as failed, send the failure
notification. Visitors never notice.

### Tier 2 — compose blue-green

Same shape, with a generation-suffixed compose project name:
`runnable-<id8>-a` / `runnable-<id8>-b` (active name stored in
`containerId`, as today).

- `up --build -d` on the incoming project name while the old stack keeps
  running. No `down` first.
- Port discovery + HTTP health gate against the primary service's published
  port, then proxy switch, grace period, and `down --remove-orphans` on the
  **old** project name.
- The shared `.runnable.env` file is rewritten before `up`, same as today —
  the old stack has already interpolated its values, so this is safe.
- Failure: `down` the incoming project name; old stack untouched.

### Tier 3 — compose in-place diff update

For stacks that can't run twice (volumes / fixed ports / `container_name`):

- **Drop the `down`** that runs today (`process.service.ts:195-200`).
- Run `docker compose up --build -d --remove-orphans` on the *same* project
  name. Compose builds first (site still up), then recreates **only services
  whose config or image changed** — an unchanged Postgres is not touched at
  all. `--remove-orphans` cleans up services deleted from the compose file.
- Re-discover the primary service's host port (it changes if that service
  was recreated), regenerate proxy config, reload.
- Failure mode: if the build fails, compose leaves the running stack as-is —
  zero downtime. If recreation of a service fails, that service is down (no
  old copy exists to fall back to); status → `ERROR` as today. This is the
  inherent limit of single-copy stateful services.

## Data model & API changes

- `Project.zeroDowntime: boolean` (default `true`) — new column + migration.
  Exposed in the project settings PATCH route and a settings-card toggle in
  the UI ("Zero-downtime deploys", with a one-line note that stateful compose
  stacks use in-place updates).
- `Deployment.strategy?: string` — `'blue-green' | 'compose-inplace' |
  'recreate'`, recorded per deploy so the history shows what ran. Nullable;
  old rows stay null.
- `ServiceStatus.DEPLOYING` already exists in the enum and is currently
  unused for this purpose — it becomes the "old version still serving, new
  one building" state. The client status badge needs a label/color for it
  (e.g. amber "Deploying" while the dot stays green-ish since the site is up).

## Components

- **`ProcessService.doDeploy(projectId)`** — orchestrates tier selection and
  the blue-green / in-place flows. Reuses `doStart`'s build logic, refactored
  so build/run/port-wait pieces are callable with an explicit container or
  compose-project name instead of hardcoding the active one.
- **`ComposeSafetyService` (or a function in `ComposePolicyService`)** —
  pure function: normalized compose config → `{ safeToParallel: boolean,
  reasons: string[] }`. Independently unit-testable.
- **`probeHttp(port, timeoutMs)`** — small helper in ProcessService (or a
  util): resolves true on any HTTP response. Used by the health gate.
- **`ServerConfigService`** — unchanged; already regenerates and reloads.

## Error handling summary

| Failure point | Result |
|---|---|
| Build fails (any tier) | Old version keeps serving; deploy marked failed; notification sent |
| New container exits immediately / health gate times out (tiers 1–2) | Incoming container/stack removed; old keeps serving; deploy failed |
| Proxy reload fails after switch | Retry once; on persistent failure keep old container alive and mark deploy failed (routing still points at old port since config write failed → still serving) |
| Server crashes mid-deploy | Orphaned incoming container/stack is removed at the start of the next deploy (step 2); active container untouched |
| Tier 3: changed service fails to recreate | That service down, status `ERROR` (inherent single-copy limit) |

## Out of scope (explicitly)

- Per-service blue-green *inside* a stateful compose stack (manually running
  a second copy of the app service on the stack network). Possible future
  enhancement; fragile today.
- Configurable health-check paths / expected status codes — v1 is "any HTTP
  response".
- Canary / weighted traffic shifting.
- Managed external databases as a way to make stateful stacks tier-2.

## Testing

- **Unit:** compose safety detection over fixture configs (named volume,
  external volume, bind mount, fixed port, `container_name`, clean stack);
  generation-name alternation; HTTP probe against a local listener (responds /
  refuses / hangs).
- **Integration (manual via `/verify`):** deploy a sample app, run
  `while true; do curl -sf ...; done` against it during a redeploy, confirm
  zero failed requests (tier 1), then repeat with a compose+postgres project
  and confirm Postgres container ID is unchanged across the deploy and data
  survives.
- **Failure path:** push a commit with a broken build; confirm the site stays
  up and the deploy is marked failed.
