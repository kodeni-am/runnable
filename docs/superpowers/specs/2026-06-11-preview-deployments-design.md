# Preview / PR Deployments — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan

## Summary

Add ephemeral per-PR preview environments to Runnable. When a pull request is
opened against a GitHub-connected project that has previews enabled, Runnable
builds the PR branch and deploys it to a unique preview subdomain. New commits
to the PR redeploy it; closing or merging the PR tears it down. Previews are
**stateless** (app code only; any database service defined in the project's
own compose stack starts fresh with empty volumes — previews never touch
production data).

This reuses the existing build/run, sandboxing, dynamic-port, custom-domain,
deploy-history, logging, and notification machinery. A preview environment is
modeled as an ordinary `Project` row flagged as a preview, so almost no new
runtime surface is required.

## Goals

- Auto-create a preview environment on PR open, redeploy on push, tear down on close.
- Serve each preview at `pr-<n>-<parent-subdomain>.<previewBaseDomain>` over HTTPS.
- Opt-in per project; safe by default (skip fork PRs; TTL auto-expiry).
- Reuse existing deploy/rollback/logs/notifications for previews at no extra cost.

## Non-goals (deferred)

- Per-preview database copy/seed or migration handling (previews are stateless).
- Sharing a production/staging database with previews.
- Concurrency cap on simultaneous previews (explicitly out of MVP).
- GitHub PR status comments / checks API integration.
- DNS-provider automation (operator sets one wildcard record by hand).

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| DB/state | **Stateless** previews. No prod-data access, no migration logic. |
| Env/secrets | Inherit parent env ⊕ optional `previewEnvOverrides` ⊕ injected preview vars. |
| TLS | **Caddy on-demand TLS** gated by an internal ask endpoint; one-time wildcard DNS record. |
| Modeling | A preview is a `Project` row (`isPreview=true`, `parentProjectId`, `prNumber`). |
| Guardrails | Skip fork PRs; TTL auto-expiry; per-project opt-in + manual teardown. No concurrency cap. |

## Data model (one migration)

Add columns to the `projects` table.

Parent-project configuration:
- `previewsEnabled boolean NOT NULL DEFAULT false`
- `previewBaseDomain varchar NULL` — e.g. `preview.example.com`
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

## Lifecycle — `pull_request` webhook events

### Webhook subscription
- `GithubService.setupWebhook` requests `events: ['push', 'pull_request']`.
- Enabling previews on an already-connected repo ensures the existing GitHub
  webhook includes `pull_request` (PATCH the hook's events via the API). A
  helper `GithubService.ensureWebhookEvents(repoUrl, token, webhookId, events)`.

### Event handling (in `webhooks.routes.ts` → new `PreviewService`)
The webhook receiver already verifies the HMAC signature and resolves the
`GithubRepo`/parent project. For `x-github-event: pull_request`:

- **`opened` / `reopened`**: guard — parent `previewsEnabled` is true AND the PR
  is **not from a fork** (`pull_request.head.repo.full_name === pull_request.base.repo.full_name`).
  If guarded out, log and return 200. Otherwise `PreviewService.createOrUpdate(parent, pr)`:
  1. Derive subdomain `pr-<n>-<parent.subdomain>` (validated against the existing
     subdomain regex; truncate parent part if needed to stay within length).
  2. Provision a preview `Project` (reusing a shared `provisionProject`-style
     path) copying `serverType`, `buildCommand`, `startCommand`, `useCompose`,
     `composeFile`, `composeService`, `internalPort`; set `isPreview`,
     `parentProjectId`, `prNumber`, `prBranch = head.ref`, `baseDomain =
     parent.previewBaseDomain`; env = merge (see Env model).
  3. Create a `GithubRepo` row for the preview (same `repoUrl`, `branch = head.ref`,
     `isPrivate` inherited) with **no webhook of its own** — the parent's webhook
     drives it.
  4. Clone the head branch into the preview dir (parent's `githubToken`) and deploy
     via `ProcessService`. Set `lastActivityAt = now`.
- **`synchronize`** (new commits): find the preview by `(parentProjectId, prNumber)`;
  `git pull` the head branch and redeploy through `ProcessService.redeploy`
  (records to deploy history → per-preview rollback works); bump `lastActivityAt`.
- **`closed`** (merged or not): `PreviewService.destroy(preview)` via the existing
  project-destroy path (container/compose down, image rm, config removal + Caddy
  reload, sandbox destroy, directory + log cleanup, row delete).

The `push` flow is unchanged. `pull_request` events for repos Runnable doesn't
track, or with previews disabled, return 200 and do nothing.

### TTL auto-expiry
The existing periodic monitor sweep also selects previews where
`lastActivityAt < now - previewTtlDays` (parent's value) and destroys them. A
reopened PR with new activity provisions a fresh preview.

## TLS & config

- **On-demand TLS.** Setup adds to the global Caddyfile:
  ```
  {
    on_demand_tls { ask http://localhost:3001/api/internal/tls-check }
  }
  ```
  An internal `GET /api/internal/tls-check?domain=<host>` endpoint (bound to
  localhost, not behind auth — Caddy calls it server-side) returns 200 only when
  `<host>` matches a live preview project's full hostname, 404 otherwise. This
  prevents Caddy from issuing certs for arbitrary hostnames.
- `ServerConfigService.generateConfig` accepts a `baseDomain` override and, for
  preview sites, emits `tls { on_demand }` in the Caddy block so the cert is
  obtained lazily on first request.
- **One-time operator step (documented):** a wildcard DNS A/AAAA record
  `*.preview.example.com → server IP`. No DNS-provider API required.

## Env model

```
preview.envVars = parent.envVars
                ⊕ parent.previewEnvOverrides   (override wins)
                ⊕ { RUNNABLE_PREVIEW_URL, PR_NUMBER }   (injected, always win)
```

The owner scrubs/overrides production secrets via `previewEnvOverrides`; no
separate config is required for a preview to boot.

## UI

- **Parent project → Settings:** a "PR Previews" card — enable toggle, preview
  base domain field, TTL-days field, and a preview-env-overrides editor (the
  existing env-vars editor component). Shown for GitHub-connected projects.
- **Parent project → new "Previews" tab** (visible when enabled): list of live
  previews — PR #, branch, `StatusBadge`, preview URL, last activity, and a
  **Destroy** button. Reuses the deployments-list styling and existing
  project-action wiring.
- **Dashboard:** preview rows are filtered out of the main project list
  (`where isPreview = false`); they appear only under their parent's Previews tab.

## Error handling & edge cases

- Preview build/deploy failure → mark `ERROR`, fire the existing notification,
  surface in the Previews tab; never blocks other previews or production.
- `pull_request` event when previews disabled / from a fork / untracked repo →
  ignored and logged; webhook returns 200.
- PR reopened after teardown → fresh preview; no subdomain collision because
  teardown fully removes the prior row.
- Deleting a parent project cascades to its previews (FK `ON DELETE CASCADE` plus
  explicit runtime teardown of each preview's container/resources).
- Webhook signature/branch verification unchanged; `pull_request` payloads run
  through the same HMAC-verified path.

## Testing

- **Unit:** fork detection; subdomain derivation + length handling; env-merge
  precedence; TTL-expiry selection; `tls-check` live-preview lookup.
- **Integration:** simulated `pull_request` opened/synchronize/closed payloads
  driving create/redeploy/destroy against a stubbed `ProcessService`.
- Existing compose-policy and provisioning paths already covered.

## Reused vs. new

**Reused:** `provisionProject` (generalized for preview extras + `baseDomain`),
`GithubService.cloneRepo`/`pullLatest`/`setupWebhook`, `ProcessService`
build/run/redeploy/destroy, `ServerConfigService` (with `baseDomain` override),
`NotificationService`, deploy history/rollback, the periodic monitor sweep.

**New:** `PreviewService`; `pull_request` handling in `webhooks.routes.ts`;
`tls-check` internal endpoint; preview enable/disable + list routes; the entity
columns + migration; Settings card + Previews tab; dashboard filter; Caddyfile
`on_demand_tls` + docs.

## Open operator documentation

- Wildcard DNS record for the preview domain.
- `on_demand_tls`/`ask` block in the global Caddyfile (added by `setup.sh`).
