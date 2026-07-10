# Manual GitHub Sync — Design

Date: 2026-07-09
Status: Approved

## Problem

A project connected to GitHub only ever redeploys in response to a webhook
delivery (`POST /api/webhooks/github` → `GithubService.handlePushEvent`). When
that delivery never arrives — GitHub failed to send it, the hook was deleted or
misconfigured, or the Runnable host was down at the moment of the push — the
project silently stays on an old commit. There is no way to say "pull the
branch tip and deploy it now."

The adjacent actions don't fill the gap:

- **Restart** (`POST /:id/restart`) recreates the container from the working
  tree as it stands. It never fetches, so it redeploys the stale commit.
- **Rollback** (`POST /:id/deployments/:deploymentId/rollback`) deploys a commit
  that Runnable already recorded. A commit that was never delivered by webhook
  has no `Deployment` row, so it cannot be selected.

## Goal

A manual "Check for updates" action on a GitHub-connected project: fetch the
tracked branch, and if there is anything new — or if the project is not
currently healthy — reset to the branch tip and redeploy through the existing
zero-downtime engine.

## Decisions

- **Scope: pull + redeploy only.** The button does not inspect or repair the
  GitHub webhook. Webhook repair (verifying the hook still exists, re-creating
  it) is a separate concern with its own failure modes and API surface;
  disconnect/reconnect already covers it. Rejected: bundling hook repair into
  the same click, which would make a deploy action silently mutate remote
  GitHub state.

- **Skip when there is genuinely nothing to do.** If the checked-out commit
  already equals the branch tip *and* the project status is `RUNNING`, report
  "already up to date" and do not rebuild. This keeps the button safe to click
  on a healthy project.

- **But deploy anyway when the project is unhealthy.** If the SHA is unchanged
  and the status is anything other than `RUNNING` (`ERROR`, `STOPPED`, or a
  stale `DEPLOYING`/`BUILDING` left behind by a crashed process), redeploy.
  This is the motivating case: the host went down mid-build, so the working
  tree is already at the tip but nothing is serving. A pure SHA comparison
  would refuse to act exactly when the button is most needed.

- **Never coalesce.** Use `ProcessService.redeployExclusive`, not `redeploy`.
  A burst of webhook pushes may be collapsed into one deploy because the queued
  run picks up the latest code anyway; a human clicking a button must get a
  deploy or an explicit answer, never a silent drop.

- **Permission: `CAN_START`.** Matches rollback. Both swap the running code of
  a project; neither edits configuration.

- **No migration.** `deployments.trigger` is already a `varchar`
  (`1772636000000-AddDeployments.ts:15`); adding a `'manual'` value touches
  only the TypeScript union.

## Components

### 1. `DeploymentTrigger` — `server/src/entities/Deployment.ts:13`

```ts
export type DeploymentTrigger = 'webhook' | 'rollback' | 'manual';
```

Mirrored in the client's `Deployment` type (`client/src/api/projects.ts:108`).

### 2. `ProcessService.redeployExclusive` — `server/src/services/process.service.ts:1141`

Today `prepare` returns `Promise<void>` and `deployOrRecreate` always follows.
Widen it to `Promise<void | boolean>`; an explicit `false` short-circuits and
resolves to `{ ran: false }` without deploying.

```ts
static redeployExclusive(projectId: string, prepare: () => Promise<void | boolean>): Promise<RedeployResult> {
    return ProcessService.withProjectLock(projectId, async () => {
        if (await prepare() === false) return { ran: false };
        const result = await ProcessService.deployOrRecreate(projectId);
        return { ran: true, ...result };
    });
}
```

This reuses the `RedeployResult.ran` contract that already exists for coalesced
pushes, rather than inventing a second "nothing happened" channel. `=== false`
(not falsiness) keeps the existing `void`-returning caller — `rollbackToDeployment`
— deploying as before.

### 3. `GithubService.syncLatest(projectId)` — `server/src/services/github.service.ts`

The manual sibling of `handlePushEvent`. Takes no commit argument: there is no
webhook payload, so the deployed commit is whatever the fetch resolves.

Preconditions, before taking the lock:
- Load the project with its `githubRepo` relation. No repo connected → `AppError(400)`.

Inside `redeployExclusive`'s `prepare`, under the project lock:
1. `git fetch --depth 1 origin <branch>` — updates `FETCH_HEAD` and the remote
   ref without touching the working tree. Non-zero exit → throw.
2. `git rev-parse HEAD` and `git rev-parse FETCH_HEAD`.
3. If the two SHAs match and `project.status === ServiceStatus.RUNNING`,
   return `false`. No `Deployment` row is written, no notification is sent, and
   the project status is left untouched.
4. Otherwise `git reset --hard FETCH_HEAD`, set status to `DEPLOYING` (and emit
   it), resolve the new HEAD sha and subject via `git log -1 --pretty=%H%n%s`,
   and set `githubRepo.lastDeployAt`.

The status write happens *inside* `prepare`, after the skip decision — unlike
`handlePushEvent`, which sets `DEPLOYING` up front. Setting it earlier would
leave a skipped sync stuck displaying `DEPLOYING`.

Return value:

```ts
{ deployed: boolean; upToDate: boolean; commitSha?: string; deployment?: Deployment }
```

On a deploy that ran: record a `Deployment` with `trigger: 'manual'` and notify
`deploy.success`. On failure: identical semantics to `handlePushEvent` — a
`DeployError` carrying `stillServing` means the previous version is still
serving, so the project status becomes `RUNNING` (not `ERROR`), a failed
`Deployment` row is recorded with `stillServing: true`, and the notification
says visitors saw nothing.

### 4. Route — `server/src/routes/github.routes.ts`

```
POST /:id/github/sync    requireProjectAccess(ProjectPermission.CAN_START)
```

Thin wrapper: calls `GithubService.syncLatest(project.id)` and returns its
result as JSON. Errors flow to the existing `errorHandler`.

### 5. Client

- `projectsApi.syncGithub(id)` in `client/src/api/projects.ts`.
- A "Check for updates" button in the GitHub tab of
  `client/src/pages/ProjectDetail.tsx`, disabled while in flight and while the
  project is mid-deploy.
- On `upToDate`, surface "Already up to date — `<sha7>`". On a deploy, the
  existing `DeployActivityCard` socket stream renders progress; no new UI.
- A `manual` chip in the deployments history, alongside the existing `rollback`
  chip (`ProjectDetail.tsx:680`).

## Data Flow

```
click "Check for updates"
  → POST /api/projects/:id/github/sync           [CAN_START]
    → GithubService.syncLatest
      → ProcessService.redeployExclusive         [project lock held]
        → prepare:
            git fetch --depth 1 origin <branch>
            HEAD == FETCH_HEAD && status == RUNNING ?
              yes → return false ──────────────► { ran: false }
              no  → git reset --hard FETCH_HEAD
                    status = DEPLOYING
                    resolve sha/message, lastDeployAt
        → deployOrRecreate                       [blue-green / compose / recreate]
      → recordDeployment(trigger: 'manual') + notify
  ← { deployed, upToDate, commitSha, deployment? }
```

## Error Handling

| Condition | Result |
|---|---|
| No GitHub repo connected | `AppError(400)`, nothing runs |
| `git fetch` fails (network, auth, deleted branch) | Throws; no reset, no deploy; working tree untouched |
| Deploy fails, old version still serving | Status `RUNNING`, failed `Deployment` with `stillServing: true` |
| Deploy fails, nothing serving | Status `ERROR`, failed `Deployment` |
| Concurrent deploy in flight | Blocks on the project lock, then runs; the fetch sees whatever that deploy left |

A private repo whose fetch needs credentials relies on the remote URL written
at clone time, exactly as `pullLatest` already does. This design introduces no
new token handling.

## Testing

`server/src/__tests__/` currently holds only a 7-line smoke test, so there is
no established service-test pattern to follow. Vitest is configured.

Add `server/src/__tests__/githubSync.test.ts` with `SandboxService.exec`,
`AppDataSource`, and `ProcessService.deployOrRecreate` mocked, covering the
three branches that carry the logic:

1. SHA unchanged + status `RUNNING` → no deploy, `{ deployed: false, upToDate: true }`, no `Deployment` row written.
2. SHA unchanged + status `ERROR` → deploys, records a `Deployment` with `trigger: 'manual'`.
3. SHA changed → resets to `FETCH_HEAD`, deploys, records the new SHA.

Plus one regression test that `redeployExclusive` still deploys when `prepare`
returns `undefined`, protecting the rollback path from the widened signature.

## Amendment (2026-07-10): force rebuild

The skip rule has a blind spot. When a zero-downtime deploy fails but the old
container keeps serving, the design deliberately leaves the project at status
`RUNNING` with the working tree already reset to the new tip. A later
"Check for updates" then sees `HEAD == FETCH_HEAD && RUNNING` and reports
"already up to date" — even though that commit never went live. The skip rule
is faithful to this spec; the spec was wrong.

A **force rebuild** control resolves it, and every other stuck state the skip
rule can't see:

- `GithubService.syncLatest(projectId, opts?: { force?: boolean })`. When
  `force` is true, the SHA/status comparison is skipped entirely: the fetch,
  the `git reset --hard FETCH_HEAD`, and the rebuild always run. `upToDate` is
  then always `false` in the result.
- Force still **fetches and resets to the branch tip**. It is "check for
  updates, but always rebuild", not "rebuild whatever is checked out". A forced
  click therefore can never deploy something older than the tip.
- `trigger` stays `'manual'` — a forced sync is a manual deploy. The history
  does not distinguish the two, because the deployed commit is what matters.
- Route: `POST /:id/github/sync` accepts an optional `{ force?: boolean }` body,
  gated on the same `CAN_START`. A non-boolean `force` is a 400.
- UI: a secondary "Force rebuild" button beside "Check for updates", behind a
  confirm dialog (it rebuilds a site that may be serving fine).

This supersedes the "force-rebuild-at-current-commit control" line struck from
Out of Scope below.

## Out of Scope

- Webhook health checks, repair, or re-registration.
- Manual sync for preview environments — previews are driven by
  `pull_request` events and have no tracked branch of their own.
- Syncing a branch other than the one recorded on `githubRepo.branch`.
