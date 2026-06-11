# Zero-Downtime Deployments — Design

**Date:** 2026-06-11 (rev 3, after two specialist review rounds)
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
| 3 | Compose, stateful/unsafe stack | In-place diff update (`up` without `down`) | Zero for unchanged services; recreated services are down for their boot time plus a few seconds of port rediscovery + proxy reload |
| — | `zeroDowntime` disabled, or first start / explicit restart | Current behavior | Build + start time |

### Compose safety detection (tier 2 vs tier 3)

After `docker compose config` (already run and parsed for the security
policy, `process.service.ts:179-193`), the normalized YAML is scanned. The
stack is **unsafe to run twice** (→ tier 3) if any of:

- Any service mounts a **named or external volume**. (Named volumes would be
  re-prefixed and start empty in the parallel stack; external volumes would
  be concurrently written by two instances — worse.) *Anonymous* volumes are
  per-container and safe to parallel — they do **not** trigger tier 3. Bind
  mounts are already rejected outright by `ComposePolicyService`
  (`composePolicy.service.ts:186-223`) so they never reach tier
  classification; the detector still flags them as defense-in-depth.
- Any service publishes a **fixed host port** (`"5432:5432"`); the parallel
  stack would collide.
- Any service sets **`container_name`**; Docker container names are global.
- The stack uses any **external network or network with a fixed `name:`** —
  both generations would join the same network with identical service
  aliases, and Docker DNS would round-robin lookups across old and new
  generations during the overlap.

The chosen tier and, for tier 3, the reason, are written to the build log,
e.g. `Zero-downtime: in-place update (stack mounts volumes: db:/var/lib/postgresql/data)`.

## Mechanics

### Eligibility gate

`redeploy()` and `redeployExclusive()` route to a new `doDeploy()` instead of
`doStop()`+`doStart()` when: the project is an APP, `zeroDowntime` is
enabled, **and the active container/stack is actually live** — checked via
`docker inspect` (single) / `docker compose ps` (compose) against
`project.containerId`, **not** via DB status. (Callers set status to
`DEPLOYING` *before* calling redeploy — `github.service.ts:176`, `:289`,
`preview.service.ts` — so a status-based gate would never fire.) Otherwise
they keep today's path.

In all three tiers `doDeploy()` keeps status `DEPLOYING` for the duration
(the old version is still serving) and sets `RUNNING` on success.
`start()`, `stop()`, `restart()`, and the health monitor's
`restartIfStillError()` keep today's semantics — an explicit restart means
"restart", and the health monitor only sweeps `RUNNING` projects
(`healthMonitor.service.ts:57-59`), never one mid-deploy.

### Failure contract with callers

Deployment-row recording, notifications, and failure status writes live in
the **callers** (`github.service.ts:210-245`, `:313-347`,
`preview.service.ts`), not in ProcessService — so the failure path must be a
shared contract, and those files change too:

- `doDeploy()` **throws** a typed `DeployError` carrying
  `stillServing: boolean` (and the attempted `strategy`).
- `redeploy()`/`redeployExclusive()` resolve with `{ ran, strategy }` on
  success (instead of today's bare boolean) so callers can record
  `Deployment.strategy`.
- Caller catch blocks change from unconditional
  `update(status: ERROR)` to: if `err.stillServing`, set status `RUNNING`
  (old version up; visitors never noticed) and record the failed Deployment +
  failure notification as today; otherwise `ERROR` as today. ProcessService
  itself records nothing — no duplicate rows.
- `stillServing` is **verified at throw time** by re-running the same
  liveness check the eligibility gate uses — never assumed. (The old
  container can die independently during a long build; asserting
  `stillServing: true` then would leave a dead site with a green badge until
  the health monitor caught it.)

### Tier 1 — single container blue-green

Today's container name is `runnable-<id8>`. New scheme: a generation suffix,
`runnable-<id8>-blue` / `runnable-<id8>-green`. `project.containerId` keeps
holding the **active** container's full name; the incoming deploy uses the
other color. (Migration: a running unsuffixed `runnable-<id8>` container is
treated as the active one and retired normally after the first blue-green
deploy. Same applies to legacy unsuffixed compose project names in tier 2.)

1. Status stays `DEPLOYING` (set by the caller) — the site is still up.
   `doDeploy` emits `DEPLOYING` to connected clients via `emitStatus`
   (callers only `repo.update` the DB; without an emit, live clients would
   see no status change until the final `RUNNING`). Also reset the health
   monitor's failure counter (`HealthMonitorService.reset`) for consistency
   with the manual start/stop/restart routes.
2. Sweep non-active generation containers (unsuffixed, `-blue`, `-green`
   other than `containerId`) — orphans from a crashed previous deploy. They
   were started with `--restart unless-stopped` and survive host reboots, so
   this sweep is load-bearing, not just tidiness. Two rules: (a) name
   matching must be **anchored** exact-name (`docker ps --filter name=` is
   an unanchored regex; follow the `^...$` precedent at
   `process.service.ts:646`); (b) a live non-active generation whose host
   port matches the port in the current on-disk proxy config is **adopted**
   (DB updated to name it) instead of removed — it is the survivor of a
   crash between proxy switch and DB persist, and removing it would take
   the serving container down.
3. Record the old container's **image ID** (`docker inspect`), then build
   exactly as today (build command + Railpack → `runnable-img-<id8>`).
   Re-tagging does not affect the running old container; its image becomes
   dangling.
4. `docker run` the incoming container (other color), dynamic host port, same
   flow as today.
5. Port-wait loop as today, **plus the HTTP health gate**: poll
   `http://127.0.0.1:<hostPort>/` (2 s timeout per attempt, 1 s between
   attempts). Any HTTP response — including 500 — counts as ready.
   - Container exits → fail (remove incoming container, throw
     `DeployError{stillServing: true}`).
   - No HTTP response after **180 s** but the container is still running →
     **degraded pass**: proceed with the cutover and log a prominent warning.
     Today's flow never verifies listening at all, so a slow-booting app
     (e.g. 3 minutes of migrations) must not become undeployable; degraded
     pass preserves "never worse than today".
6. **Write the new proxy config, reload Caddy via a strict reload that
   propagates failure, and only then persist `containerId`/`port`** (see
   ServerConfigService below). On reload failure: rewrite the config file
   back to the old port, best-effort reload again, remove the incoming
   container, throw `DeployError{stillServing: true}` — the DB was never
   touched, so it still names the old, healthy container and the health
   monitor keeps watching the right thing. (The config file lands on disk
   *before* the reload runs — `writeConfig` is a plain `fs.writeFile`,
   `serverConfig.service.ts:172-184` — and `reloadCaddy()` is global and
   invoked by every other project's lifecycle ops, so a stale new-port
   config left on disk would be silently activated by the next unrelated
   deploy. The rollback write keeps disk, Caddy, and DB all in agreement.)
7. Grace period (10 s), then `docker stop` (SIGTERM + Docker's 10 s grace)
   and `docker rm` the old container, then best-effort `docker rmi` of the
   recorded old image ID — skipped when old and new image IDs are equal
   (byte-identical rebuild, e.g. rollback to the deployed commit). No
   blanket `docker image prune` — that would nuke other projects' in-flight
   build layers. DB was already updated in step 6, so a crash here leaves
   only an idempotent retirement to redo — step 2 of the next deploy (or
   doStop) sweeps it.
8. Status → `RUNNING`, emit to clients.

**Cleanup is funneled:** *all* failure paths after `docker run` (run error,
port-wait timeout, container exit, reload failure) go through a single
try/finally that removes the incoming container — otherwise a missed path
leaves a `--restart unless-stopped` orphan, exactly the leak the step-2
sweep exists to backstop. On any failure after a successful build, the
just-built image is also best-effort `rmi`'d: the next successful build
would re-tag over it, leaving it dangling with nothing to collect it.

Caveat worth documenting in the UI/help: long-lived connections (websockets,
SSE) to the old container are terminated up to ~20 s after the switch (grace
period + docker stop grace). Inherent to blue-green.

### Tier 2 — compose blue-green

Same shape, with a generation-suffixed compose project name:
`runnable-<id8>-a` / `runnable-<id8>-b` (active name stored in
`containerId`, as today).

- `up --build -d` on the incoming project name while the old stack keeps
  running. No `down` first.
- Port discovery + HTTP health gate against the primary service's published
  port (same degraded-pass rule), then proxy switch with rollback-on-reload-
  failure, grace period, and `down --remove-orphans --rmi local` on the
  **old** project name (label-scoped to that project name — does not touch
  the new stack). `--rmi local` mirrors tier 1's image retirement: compose
  tags images per project name, so without it every compose project carries
  ~2× tagged images forever.
- The shared `.runnable.env` file is rewritten before `up`, same as today —
  the old stack interpolated its values at its own `up`, so this is safe.
- Failure: `down --rmi local` the incoming project name; old stack untouched.
- **Caveat (document in UI/help):** during the overlap window (seconds
  normally; up to 180 s + grace on a degraded pass) every service in the
  stack runs twice — including queue consumers, background workers, and
  entrypoint migrations against external resources. The safety detector can
  only see Docker-level state (volumes/ports/names/networks); app-level
  external side effects are invisible to it. The settings-card note should
  say so.

### Tier 3 — compose in-place diff update

For stacks that can't run twice (volumes / fixed ports / `container_name` /
shared networks):

- **Drop the `down`** that runs today (`process.service.ts:195-200`).
- Run `docker compose up --build -d --remove-orphans` on the *same* project
  name. Compose builds first (site still up), then recreates **only services
  whose config or image changed** — an unchanged Postgres is not touched at
  all. (Note: an env-var change in `.runnable.env` counts as a config change
  and cascades recreation to services that use it.) `--remove-orphans`
  cleans up services deleted from the compose file.
- Re-discover the primary service's host port (it changes if that service
  was recreated), regenerate proxy config, strict reload.
- Failure mode: if the build fails, compose leaves the running stack as-is —
  zero downtime, `DeployError{stillServing: true}`. If recreation of a
  service fails, that service is down (no old copy exists to fall back to);
  `DeployError{stillServing: false}` → caller sets `ERROR` as today. This is
  the inherent limit of single-copy stateful services.

## Crash recovery & boot reconciliation

- **Crash before the proxy switch:** old container still serving, DB still
  points at it. Boot reconciliation (`index.ts:98-113`) currently resets
  `DEPLOYING → ERROR` unconditionally; it changes to: if the `containerId`
  container/stack is alive, reconcile to `RUNNING` (the site is up — ERROR
  would stick forever since the health monitor doesn't sweep ERROR
  projects); otherwise `ERROR` as today. The liveness check must be
  **compose-aware** — for compose projects `containerId` holds a compose
  project name, which `docker inspect` cannot resolve; reuse
  `HealthMonitorService.isContainerRunning`
  (`healthMonitor.service.ts:79-95`), which already branches correctly.
  The orphaned incoming container is swept by the next deploy's step 2 or
  by `doStop`.
- **Crash between Caddy reload and DB persist** (milliseconds wide): proxy
  routes to the new container, DB still names the old one — both alive, the
  site is up serving the new version. Boot reconciliation keeps `RUNNING`.
  The step-2 adoption rule (live generation matching the on-disk config's
  port) ensures the next deploy adopts the serving container instead of
  sweeping it.
- **Crash between DB persist and retirement:** `containerId` already names
  the new container — boot reconciliation finds it alive → `RUNNING`. The
  not-yet-retired old container is swept as a non-active generation.
- **`doStop` / `destroy` sweep all generations:** today they remove only
  `project.containerId` (`process.service.ts:446-447`). They change to
  remove *every* generation name — `runnable-<id8>`, `-blue`, `-green`, and
  compose project names `runnable-<id8>`, `-a`, `-b` — idempotent and cheap.
  For compose generations, prefer **label-based cleanup**
  (`docker ps -q --filter label=com.docker.compose.project=<gen>` then
  `rm -f`, as the health monitor already does) over `compose down -f <file>`,
  which silently orphans everything if the compose file was deleted or
  renamed. `destroy()` additionally removes compose-built images
  (`down --rmi local` or by label) — today it only removes
  `runnable-img-<id8>` (`process.service.ts:480-481`). Without all this, a
  crashed deploy's orphan (with `--restart unless-stopped`) survives
  stop/restart/project-deletion forever and pins its image.

## Data model & API changes

- `Project.zeroDowntime: boolean` (default `true`) — new column + migration.
  Exposed via the existing `PUT /:id` settings route
  (`projects.routes.ts:169`) and a settings-card toggle in the UI
  ("Zero-downtime deploys", with a one-line note that stateful compose
  stacks use in-place updates).
- `Deployment.strategy?: string` — `'blue-green' | 'compose-inplace' |
  'recreate'`, recorded by callers from the `{ ran, strategy }` result.
  Nullable; old rows stay null.
- `ServiceStatus.DEPLOYING` already exists and is already set by redeploy
  callers. The client badge for it **already exists too** —
  `client/src/components/StatusBadge.tsx` handles `deploying` and
  `client/src/index.css` defines `--status-deploying` (amber) — so no
  badge work is needed; what's missing is only the live emit (tier 1,
  step 1).

## Components

- **`ProcessService.doDeploy(projectId)`** — orchestrates tier selection and
  the blue-green / in-place flows. Reuses `doStart`'s build logic, refactored
  so build/run/port-wait pieces are callable with an explicit container or
  compose-project name instead of hardcoding the active one.
- **`DeployError`** — typed error with `stillServing` and `strategy`; the
  caller contract above.
- **Compose safety detection** — pure function (in or beside
  `ComposePolicyService`): normalized compose config →
  `{ safeToParallel: boolean, reasons: string[] }`. Independently
  unit-testable.
- **`probeHttp(port, timeoutMs)`** — resolves true on any HTTP response.
- **`ServerConfigService` — changes** (contrary to rev 1): `reloadCaddy()`
  currently swallows all errors (`serverConfig.service.ts:194-204`). Add a
  strict variant (or an option) that throws on failure; `doDeploy` uses it
  so the config-rollback path in step 6 can exist. Existing callers keep the
  lenient behavior. APP projects always generate Caddy configs
  (`serverConfig.service.ts:48-52`), so only the Caddy reload path matters
  here.
- **`ProcessService.listContainers` / `getContainerLogs`** — currently
  filter on exactly `containerId` (`process.service.ts:646`); they widen to
  match all generation names so users can watch the *incoming* container's
  startup logs during a deploy.
- **`HealthMonitorService.reset(projectId)`** — already exists
  (`healthMonitor.service.ts:47`) and is already called by the manual
  lifecycle routes (`projects.routes.ts:346/357/368`); doDeploy calls it at
  start for consistency. (Not a bug fix: the monitor re-reads `containerId`
  fresh each sweep and needs two consecutive failures plus a pre-action
  status re-check, so a single stale snapshot cannot trigger action.)
- **Callers** — `github.service.ts` (`handlePushEvent`,
  `rollbackToDeployment`), `preview.service.ts` (`redeployExisting`):
  adopt the `DeployError.stillServing` contract and record
  `Deployment.strategy`.
- **Boot reconciliation** — `index.ts:98-113` as described above.

## Error handling summary

| Failure point | Result |
|---|---|
| Build fails (any tier) | Old version keeps serving; status `RUNNING`; deploy recorded failed; notification sent |
| New container exits before responding (tiers 1–2) | Incoming container/stack removed; old keeps serving; deploy failed (`stillServing: true`) |
| Health gate times out, container alive (tiers 1–2) | Degraded pass — cut over anyway, warning in build log |
| Proxy reload fails after config write | Config file rewritten back to old port, best-effort reload, incoming container removed, deploy failed (`stillServing: true`) |
| Server crashes mid-deploy | Boot reconciliation adopts whichever container `containerId` names if alive (→ `RUNNING`); orphaned generation swept on next deploy/stop |
| Tier 3: changed service fails to recreate | That service down, `stillServing: false` → status `ERROR` (inherent single-copy limit) |

## Out of scope (explicitly)

- Per-service blue-green *inside* a stateful compose stack (manually running
  a second copy of the app service on the stack network). Possible future
  enhancement; fragile today.
- Configurable health-check paths / expected status codes / timeouts — v1 is
  "any HTTP response, 180 s, degraded pass".
- Canary / weighted traffic shifting.
- Managed external databases as a way to make stateful stacks tier-2.
- Zero-downtime for websocket/SSE connections (old-container connections drop
  at retirement).

## Testing

- **Unit:** compose safety detection over fixture configs (named volume,
  external volume, anonymous volume [must NOT trigger], fixed port,
  `container_name`, external network, fixed-name network, clean stack);
  generation-name alternation incl. legacy unsuffixed migration; HTTP probe
  against a local listener (responds / refuses / hangs); DeployError
  contract in `handlePushEvent` (failed deploy with `stillServing` must
  record a *failed* Deployment row and status `RUNNING`, never a success
  row).
- **Integration (manual via `/verify`):** deploy a sample app, run
  `while true; do curl -sf ...; done` against it during a redeploy, confirm
  zero failed requests (tier 1), then repeat with a compose+postgres project
  and confirm the Postgres container ID is unchanged across the deploy and
  data survives. Verify tagged + dangling images don't accumulate across 3
  consecutive deploys — for **both** tier 1 and tier 2 (compose tags images
  per generation project name).
- **Failure path:** push a commit with a broken build; confirm the site
  stays up, status returns to `RUNNING`, and the deploy is recorded failed
  (not success).
