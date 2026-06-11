# Preview / PR Deployments — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming), revised after code-level review — pending implementation plan

## Summary

Add ephemeral per-PR preview environments to Runnable. When a pull request is
opened against a GitHub-connected project that has previews enabled, Runnable
builds the PR branch and deploys it to a unique preview subdomain. New commits
to the PR redeploy it; closing or merging the PR tears it down. Previews are
**stateless** (app code only; any database service defined in the project's
own compose stack starts fresh with empty volumes — previews never touch
production data).

A preview environment is modeled as an ordinary `Project` row flagged as a
preview, reusing the existing build/run, sandboxing, dynamic-port, deploy-history,
logging, and notification machinery. Several existing reuse points need small,
named refactors (below) rather than working as-is — this revision makes those
explicit.

## Goals

- Auto-create a preview on PR open, redeploy on push, tear down on close.
- Serve each preview at `pr-<n>-<parent-subdomain>.<previewBaseDomain>` over HTTPS.
- Opt-in per project; safe by default (skip fork PRs; TTL auto-expiry).
- Reuse existing deploy/rollback/logs/notifications for previews.

## Non-goals (deferred)

- Per-preview database copy/seed or migration handling (previews are stateless).
- Sharing a production/staging database with previews.
- Concurrency cap on simultaneous previews (accepted resource risk — see Risks).
- GitHub PR status comments / checks API integration.
- DNS-provider automation (operator sets one wildcard record by hand).

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| DB/state | **Stateless** previews. No prod-data access, no migration logic. |
| Env/secrets | Inherit parent env ⊕ optional `previewEnvOverrides` ⊕ injected preview vars. |
| TLS | **Caddy on-demand TLS** gated by an internal ask endpoint; one-time wildcard DNS. |
| Modeling | A preview is a `Project` row (`isPreview=true`, `parentProjectId`, `prNumber`). |
| Guardrails | Skip fork PRs; TTL auto-expiry; per-project opt-in + manual teardown. No concurrency cap. |

## Data model (one migration)

Add columns to the `projects` table.

Parent-project configuration:
- `previewsEnabled boolean NOT NULL DEFAULT false`
- `previewBaseDomain varchar NULL` — e.g. `preview.example.com`; validated with the
  existing `ServerConfigService.sanitizeDomain` rules when set.
- `previewEnvOverrides` simple-json (`Record<string,string>`) NULL — wins over inherited env
- `previewTtlDays integer NOT NULL DEFAULT 7`

Preview-instance fields:
- `isPreview boolean NOT NULL DEFAULT false`
- `parentProjectId uuid NULL` (FK → projects.id, ON DELETE CASCADE)
- `prNumber integer NULL`
- `prBranch varchar NULL`
- `lastActivityAt timestamp NULL` — set on each deploy; drives TTL expiry

Config-generation override:
- `baseDomain varchar NULL` — when set, overrides `config.hosting.baseDomain` for this
  project's reverse-proxy config. Preview projects set this to the parent's
  `previewBaseDomain`; normal projects leave it null.

Indexes: `parentProjectId`, and `(isPreview, lastActivityAt)` for the TTL sweep.

Note: `GithubRepo.repoUrl` is intentionally **non-unique** — parent and each
preview hold a row with the same `repoUrl`. Do not add a unique index on it.

## Lifecycle — `pull_request` webhook events

### Webhook subscription
- `GithubService.setupWebhook` requests `events: ['push', 'pull_request']`.
- Enabling previews on an already-connected repo calls a new
  `GithubService.ensureWebhookEvents(repoUrl, token, webhookId, events)` to PATCH
  the existing GitHub hook so it includes `pull_request`.

### Webhook receiver resolution (CHANGED — blocking fix)
Today `webhooks.routes.ts` handles only `push` and resolves the `GithubRepo` by
`repoUrl` via `getOne()`. Once previews exist, **multiple `GithubRepo` rows share
a `repoUrl`** (parent + previews), so `getOne()` could return a preview row (which
has a null `webhookSecret`) and drop a real event.

The receiver must:
- Resolve **only the parent** repo: join to the project and filter
  `project.isPreview = false` (previews never own a webhook, but this is belt-and-suspenders),
  selecting the parent's `webhookSecret` explicitly (it is `select:false`).
- Handle both `push` (unchanged behavior) and `pull_request` (new).

### Event handling (new `PreviewService`, called from `webhooks.routes.ts`)
For `x-github-event: pull_request`, after HMAC verification against the parent's
secret:

- **`opened` / `reopened`**: guard — parent `previewsEnabled` is true, parent has a
  `previewBaseDomain`, and the PR is **not from a fork**
  (`pull_request.head.repo?.full_name === pull_request.base.repo.full_name`; treat a
  null `head.repo` as a fork/deleted-repo → skip). If guarded out, log and 200.
  Otherwise `PreviewService.createOrUpdate(parent, pr)` (serialized — see below):
  1. Derive subdomain (deterministic, collision-resistant — see below).
  2. Provision a preview `Project` via the extracted core provisioner (below),
     copying `serverType`, `buildCommand`, `startCommand`, `useCompose`,
     `composeFile`, `composeService`, `internalPort`; set `isPreview`,
     `parentProjectId`, `prNumber`, `prBranch = head.ref`, `userId =
     parent.userId`, `baseDomain = parent.previewBaseDomain`; env = merge (below).
  3. Create a `GithubRepo` row for the preview (same `repoUrl`, `branch = head.ref`,
     `isPrivate` inherited, `webhookId = null`, `webhookSecret = null`).
  4. Clone the head branch into the preview dir (parent owner's `githubToken`) and
     deploy via `ProcessService`. Set `lastActivityAt = now`.
- **`synchronize`** (new commits): find the preview by `(parentProjectId, prNumber)`;
  `git pull` the head branch and redeploy through `ProcessService.redeploy`
  (records to deploy history → per-preview rollback works); bump `lastActivityAt`.
- **`closed`** (merged or not): `PreviewService.destroy(preview)` — full teardown (below).

The `push` flow is unchanged. `pull_request` events for untracked repos or with
previews disabled return 200 and do nothing.

### Per-PR serialization (blocking fix)
`ProcessService.withProjectLock` is keyed by `projectId` and cannot cover a
preview that does not exist yet, so a fast `opened`→`synchronize` burst could
double-create or race. `PreviewService` maintains its own in-process lock keyed by
`${parentProjectId}:${prNumber}` (same promise-chain pattern as `withProjectLock`)
wrapping create/update/destroy. Once the preview row exists, redeploys also use
the project lock as usual.

### Subdomain derivation (blocking detail)
`subdomain` is globally unique and DNS labels cap at 63 chars. Derive:
`pr-<n>-<parentSlug>` where `parentSlug` is the parent subdomain truncated so the
whole label ≤ ~50 chars, plus a short hash suffix of `parentProjectId` to keep it
deterministic and collision-resistant across different parents and against a
real project literally named `pr-<n>-...`. The derivation is stable for a given
`(parentProjectId, prNumber)` so reopen reuses the same name.

### Provisioning core (blocking refactor)
`provisionProject` currently bundles permission checks, the **maxProjects quota
count (which counts ALL rows, including previews)**, server-type checks, subdomain
validation/uniqueness, port allocation, entity creation, and sandbox creation.
Split it:
- `provisionProjectCore(owner, name, subdomain, serverType, extras)` — subdomain
  validation/uniqueness + port allocation + entity create + sandbox create.
- The existing `POST /projects` keeps the permission/quota/server-type checks, then
  calls the core.
- `PreviewService` calls the **core directly** under the parent owner's `User`
  (`parent.userId`), skipping permission/quota/server-type checks (the parent
  already passed them). Previews therefore do **not** consume the owner's
  `maxProjects` quota.
- Independently, the `maxProjects` count query and the dashboard list filter must
  both exclude previews: `where userId = :id AND isPreview = false`.

### Full teardown (blocking fix)
`ProcessService.destroy` only stops the container/compose stack and removes the
image. The complete teardown (config removal + Caddy reload, sandbox destroy,
directory + log removal, row delete, GithubRepo cascade) currently lives **inline
in the `DELETE /projects/:id` route handler**. Extract that into a reusable
`ProjectTeardownService.teardown(project)` used by both the route and
`PreviewService.destroy`. (The preview's `GithubRepo` row is removed by FK cascade
when the preview Project row is deleted.)

### TTL auto-expiry (out-of-band)
The existing monitor sweep also selects previews where
`lastActivityAt < now - parent.previewTtlDays` and tears them down **without
awaiting** (mirroring the not-awaited `restartIfStillError` pattern), so a batch of
expirations never stalls health checks. `previewTtlDays` lives on the parent, so
the sweep joins each preview to its parent (via `parentProjectId`) to read it.

## TLS & config

- **On-demand TLS.** `setup.sh` adds to the global Caddyfile:
  ```
  {
    on_demand_tls { ask http://localhost:3001/api/internal/tls-check }
  }
  ```
- **`tls-check` endpoint (separate, unauthenticated router).** A new router mounted
  in `index.ts` **outside** the `authenticate` chain (alongside `webhookRoutes`),
  with a reused rate limiter. `GET /api/internal/tls-check?domain=<host>` returns
  200 only when `<host>` equals `<subdomain>.<baseDomain>` of a live preview
  project, 404 otherwise. This gates Caddy cert issuance to known preview
  hostnames. "localhost" here is the host trust boundary (the API binds
  `127.0.0.1` in production and Caddy calls it locally) — not network isolation;
  the rate limit prevents hostname-probing abuse.
- **Config generation.** Add `baseDomain?: string` and `onDemandTls?: boolean` to
  `ServerConfigOptions`; `generateConfig`/`generateCaddyConfig` use the override
  instead of reading `config.hosting.baseDomain` directly, and emit `tls { on_demand }`
  for preview (APP/Caddy-type) sites. The three call sites that build the options
  object (`process.service.ts` doStart, `projects.routes.ts` reload-proxy,
  `domain.service.ts` regenerate) pass the project's `baseDomain`. The override
  only needs to thread through the **Caddy generator** — previews are APP-type, so
  the Nginx/Apache generators (which also read `config.hosting.baseDomain`) are
  never reached for previews and can keep reading the global value.
- **One-time operator step (documented):** wildcard DNS `*.preview.example.com →
  server IP`. The lingering on-demand cert for a torn-down hostname stays in
  Caddy's storage harmlessly; no per-preview DNS or cert cleanup needed.

## Env model

```
preview.envVars = parent.envVars
                ⊕ parent.previewEnvOverrides   (override wins)
                ⊕ { RUNNABLE_PREVIEW_URL, PR_NUMBER }   (injected, always win)
```

**Security note (surface in the UI):** production secrets in the parent's
`envVars` flow into previews unless scrubbed via `previewEnvOverrides`. This is a
defensible default for same-repo PRs (the committer already has repo write
access) and fork PRs are skipped entirely, but the Settings card must warn about it.

## Access control & permissions

- Enabling/configuring previews (`previewsEnabled`, `previewBaseDomain`,
  `previewEnvOverrides`, `previewTtlDays`) is a config change → requires
  `CAN_EDIT_CONFIG` on the parent, like other settings.
- A preview Project has `userId = parent.userId` but **no collaborator rows** of
  its own, so collaborators can't reach it through the generic `/api/projects/:id`
  routes. All preview operations are addressed **through the parent**:
  - `GET /api/projects/:id/previews` — list previews for parent `:id` (gated by
    `requireProjectAccess`, view permission).
  - `POST /api/projects/:id/previews/:previewId/destroy` — manual teardown (gated by
    `requireProjectAccess(CAN_START)` on the parent; verifies the preview's
    `parentProjectId === :id`).
  Preview project-ids are never exposed to the generic project routes.

## UI

- **Parent project → Settings:** a "PR Previews" card — enable toggle, preview base
  domain field, TTL-days field, a preview-env-overrides editor (the existing
  env-vars editor component), and the secret-inheritance warning. Shown for
  GitHub-connected projects; gated on `canEditConfig`.
- **Parent project → new "Previews" tab** (visible when enabled): list of live
  previews — PR #, branch, `StatusBadge`, preview URL, last activity, and a
  **Destroy** button. Data from `GET /:id/previews`; reuses the deployments-list
  styling.
- **Dashboard:** preview rows are filtered out of the main project list
  (`where isPreview = false`).

## Error handling & edge cases

- Preview build/deploy failure → mark `ERROR`, fire the existing notification,
  surface in the Previews tab; never blocks other previews or production.
- `pull_request` event when previews disabled / from a fork / null `head.repo` /
  untracked repo → ignored and logged; webhook returns 200.
- PR reopened after teardown → fresh preview with the same derived subdomain (stable
  derivation), no collision.
- Subdomain collision against a real project → the hash suffix makes it
  vanishingly unlikely; if it still occurs, `provisionProjectCore` surfaces the
  409 and the event is logged rather than 500.
- Deleting a parent cascades to its previews (FK `ON DELETE CASCADE`) plus runtime
  teardown of each preview's container/resources via `ProjectTeardownService`.
- A preview stuck in BUILDING at a crash is reset to ERROR on boot (existing
  reconcile) and reaped by TTL.
- Webhook signature/branch verification unchanged; `pull_request` payloads run
  through the same HMAC-verified path against the parent secret.

## Testing

- **Unit:** fork detection (incl. null `head.repo`); subdomain derivation
  (determinism, length, hash suffix); env-merge precedence; TTL-expiry selection;
  `tls-check` live-preview lookup; webhook resolution filtering preview rows.
- **Integration:** simulated `pull_request` opened/synchronize/closed payloads
  driving create/redeploy/destroy against a stubbed `ProcessService`; per-PR
  serialization under a fast opened→synchronize burst.

## Reused vs. new

**Reused:** `GithubService.cloneRepo`/`pullLatest`/`setupWebhook`,
`ProcessService` build/run/redeploy, `NotificationService`, deploy
history/rollback, the periodic monitor sweep, the env-vars editor component, the
deployments-list UI.

**New / refactored:** `PreviewService` (with per-PR lock); `pull_request` handling
+ parent-only resolution in `webhooks.routes.ts`; `provisionProjectCore` extracted
from `provisionProject`; `ProjectTeardownService` extracted from the delete route;
`GithubService.ensureWebhookEvents`; `tls-check` internal router; preview
list/destroy routes; `ServerConfigOptions` `baseDomain`/`onDemandTls`; the entity
columns + migration; Settings card + Previews tab; dashboard + quota-count filters;
Caddyfile `on_demand_tls` + operator docs.

## Implementation phases (split for separate plans)

1. **Foundation:** entity columns + migration; webhook-receiver resolution fix
   (`isPreview=false` filter, parent secret); `provisionProjectCore` extraction +
   quota/dashboard preview filters; `ProjectTeardownService` extraction. Independently
   valuable and de-risks the resolution change.
2. **Core lifecycle:** `PreviewService` (create/update/destroy) with per-PR
   serialization; `pull_request` event handling; clone/redeploy/teardown wiring;
   notifications; `ensureWebhookEvents`.
3. **TLS/config:** `ServerConfigOptions` override + `on_demand` emission across the
   three call sites; `tls-check` router; Caddyfile + operator docs.
4. **UI + TTL:** Settings card, Previews tab, dashboard filter; TTL sweep in the
   monitor (out-of-band teardown).

## Risks (accepted for MVP)

- No concurrency cap: a repo with many simultaneous open PRs auto-builds many
  previews, bounded only by TTL. One-line addition later if needed.
- Secret inheritance into previews (mitigated by overrides + fork skip + UI warning).
