# Manual GitHub Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Check for updates" action that fetches a GitHub-connected project's tracked branch and redeploys the tip, so a missed webhook delivery can be recovered manually.

**Architecture:** A new `GithubService.syncLatest(projectId)` is the manual sibling of the existing webhook handler `handlePushEvent`. It runs under the project lock via `ProcessService.redeployExclusive`, fetches the branch, and short-circuits with "already up to date" only when the checked-out SHA equals the branch tip *and* the project is `RUNNING`. A new `POST /:id/github/sync` route exposes it; the GitHub tab of `ProjectDetail.tsx` calls it.

**Tech Stack:** TypeScript, Express 5, TypeORM (Postgres), Vitest (server tests, SWC transform for decorators), React 19 + Vite, axios.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-manual-github-sync-design.md`
- **No database migration.** `deployments.trigger` is already `varchar` (`server/src/migrations/1772636000000-AddDeployments.ts:15`); adding `'manual'` touches only TypeScript unions.
- **Never coalesce a manual sync.** Use `ProcessService.redeployExclusive`, never `ProcessService.redeploy`.
- **Permission for the route: `ProjectPermission.CAN_START`** — matches rollback.
- Server code style: 4-space indent, no semicolon omission, `AppError(message, statusCode)` for client-facing errors.
- Run server tests with `npm test --workspace=server` (Vitest, `include: ['src/**/*.test.ts']`).
- Typecheck with `npm run build --workspace=server` and `npm run build --workspace=client`.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/entities/Deployment.ts` | Modify: add `'manual'` to `DeploymentTrigger` |
| `server/src/services/process.service.ts` | Modify: `redeployExclusive` accepts a `prepare` that returns `false` to skip the deploy |
| `server/src/services/github.service.ts` | Modify: extract `recordDeployFailure()`; add `SyncResult` interface + `syncLatest()` |
| `server/src/routes/github.routes.ts` | Modify: add `POST /:id/github/sync` |
| `server/src/__tests__/redeployExclusive.test.ts` | Create: covers the `prepare` short-circuit contract |
| `server/src/__tests__/deployFailure.test.ts` | Create: covers `recordDeployFailure`'s two kinds |
| `server/src/__tests__/githubSync.test.ts` | Create: covers `syncLatest`'s logic branches |
| `client/src/api/projects.ts` | Modify: `'manual'` trigger, `SyncResult` type, `syncGithub()` |
| `client/src/pages/ProjectDetail.tsx` | Modify: "Check for updates" button + `Manual` history chip |

Six tasks, each independently reviewable and testable: the lock primitive, the failure-path extraction, the service, the route, the client, and end-to-end verification.

## Amendment (2026-07-09)

The spec's `syncLatest` failure path is a near-verbatim copy of the catch blocks
in `handlePushEvent` and `rollbackToDeployment`. Rather than add a third copy,
Task 2 extracts the shared behaviour into `GithubService.recordDeployFailure()`
first, as a behaviour-preserving refactor, and Task 3's `syncLatest` calls it.

---

### Task 1: `redeployExclusive` honours a skipping `prepare`

`ProcessService.redeployExclusive` currently always calls `deployOrRecreate` after `prepare()`. Widen `prepare` to return `void | boolean`, where an explicit `false` means "nothing to do" and resolves to `{ ran: false }` without deploying. This reuses the existing `RedeployResult.ran` contract (`process.service.ts:1127` already returns `{ ran: false }` for coalesced pushes).

Testing `=== false` rather than falsiness is load-bearing: the existing caller `rollbackToDeployment` passes a `prepare` that returns `undefined`, and it must keep deploying.

**Files:**
- Modify: `server/src/services/process.service.ts:1141-1147`
- Test: `server/src/__tests__/redeployExclusive.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ProcessService.redeployExclusive(projectId: string, prepare: () => Promise<void | boolean>): Promise<RedeployResult>`, where `RedeployResult` is `{ ran: boolean; strategy?: DeployStrategy; healthGate?: HealthGateResult; strategyReason?: string; durationMs?: number }` (already exported at `process.service.ts:44`).

- [ ] **Step 1: Write the failing test**

`deployOrRecreate` is a TypeScript-private static, which at runtime is an ordinary property on the class, so the test replaces it with a stub. `withProjectLock` runs for real — it is pure in-process promise chaining.

Create `server/src/__tests__/redeployExclusive.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessService } from '../services/process.service';

describe('ProcessService.redeployExclusive', () => {
    let deployOrRecreate: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // `deployOrRecreate` is private only to TypeScript; at runtime it is a
        // plain static property, so we can swap it for a stub.
        deployOrRecreate = vi.fn(async () => ({ strategy: 'recreate' as const }));
        (ProcessService as any).deployOrRecreate = deployOrRecreate;
    });

    it('skips the deploy when prepare returns false', async () => {
        const result = await ProcessService.redeployExclusive('p1', async () => false);

        expect(result).toEqual({ ran: false });
        expect(deployOrRecreate).not.toHaveBeenCalled();
    });

    it('deploys when prepare returns true', async () => {
        const result = await ProcessService.redeployExclusive('p2', async () => true);

        expect(result.ran).toBe(true);
        expect(deployOrRecreate).toHaveBeenCalledWith('p2');
    });

    it('deploys when prepare returns undefined (rollback path)', async () => {
        const result = await ProcessService.redeployExclusive('p3', async () => { /* void */ });

        expect(result.ran).toBe(true);
        expect(deployOrRecreate).toHaveBeenCalledWith('p3');
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=server -- redeployExclusive`

Expected: the first test FAILS — `deployOrRecreate` was called and `result` is `{ ran: true, strategy: 'recreate' }`, not `{ ran: false }`. The other two PASS (current behaviour already deploys). If the whole file fails to compile with `Type 'boolean' is not assignable to type 'void'`, that is also an acceptable failure for this step.

- [ ] **Step 3: Write the minimal implementation**

In `server/src/services/process.service.ts`, replace `redeployExclusive` (currently lines 1137-1147, including its doc comment):

```ts
    /**
     * Like redeploy(), but never coalesced. Used for rollbacks and manual
     * syncs, where dropping the request would leave the project on the wrong
     * commit or silently do nothing. `prepare` may return `false` to mean
     * "nothing to do" — the deploy is then skipped and { ran: false } is
     * returned. Only an explicit `false` skips; a void-returning `prepare`
     * deploys as before.
     */
    static redeployExclusive(projectId: string, prepare: () => Promise<void | boolean>): Promise<RedeployResult> {
        return ProcessService.withProjectLock(projectId, async () => {
            if (await prepare() === false) return { ran: false };
            const result = await ProcessService.deployOrRecreate(projectId);
            return { ran: true, ...result };
        });
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace=server -- redeployExclusive`
Expected: 3 passed.

Run: `npm run build --workspace=server`
Expected: exit 0. `rollbackToDeployment` still typechecks against the widened signature.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/process.service.ts server/src/__tests__/redeployExclusive.test.ts
git commit -m "feat: let redeployExclusive's prepare skip the deploy by returning false"
```

---

### Task 2: Extract `GithubService.recordDeployFailure`

A behaviour-preserving refactor, done before `syncLatest` exists so that the new
code has one failure path to call rather than a third copy to write.

`handlePushEvent` (`github.service.ts:255-286`) and `rollbackToDeployment`
(`:377-407`) end with catch blocks that differ only in the notification copy and
the recorded `trigger`. Both do the same four things: decide `stillServing`,
update the project status (`RUNNING` when the old version survived, else
`ERROR`), record a failed `Deployment`, and notify.

Extract that into one private static. The two call sites' observable behaviour —
status writes, deployment rows, notification payloads — must not change.

**Files:**
- Modify: `server/src/services/github.service.ts` (add `FAILURE_COPY` + `recordDeployFailure`; rewrite both catch blocks)
- Test: `server/src/__tests__/deployFailure.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GithubService.recordDeployFailure(project: Project, opts: DeployFailureOpts, error: any): Promise<boolean>` — returns `stillServing`. Task 3 calls it.

```ts
interface DeployFailureOpts {
    kind: 'deploy' | 'rollback';
    trigger: DeploymentTrigger;
    branch: string;
    commitSha?: string;
    commitMessage?: string;
}
```

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/deployFailure.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/sandbox.service', () => ({ SandboxService: { exec: vi.fn() } }));
vi.mock('../services/process.service', () => ({
    ProcessService: { redeployExclusive: vi.fn(), redeploy: vi.fn(), emitStatus: vi.fn() },
}));
vi.mock('../services/notification.service', () => ({ NotificationService: { notify: vi.fn() } }));
vi.mock('../config/data-source', () => ({ AppDataSource: { getRepository: vi.fn() } }));

import { GithubService } from '../services/github.service';
import { ProcessService } from '../services/process.service';
import { NotificationService } from '../services/notification.service';
import { AppDataSource } from '../config/data-source';
import { DeployError } from '../services/deployError';
import { Project, Deployment, ServiceStatus } from '../entities';

const SHA = 'c'.repeat(40);
const project = { id: 'proj-1', name: 'demo' } as any;

let projectRepo: any;
let deployRepo: any;

beforeEach(() => {
    vi.clearAllMocks();
    projectRepo = { update: vi.fn(async () => undefined) };
    deployRepo = { create: vi.fn((d: any) => d), save: vi.fn(async (d: any) => ({ id: 'dep-1', ...d })) };
    vi.mocked(AppDataSource.getRepository).mockImplementation((entity: any) => {
        if (entity === Project) return projectRepo;
        if (entity === Deployment) return deployRepo;
        throw new Error('unexpected repository');
    });
});

const call = (opts: any, error: any) => (GithubService as any).recordDeployFailure(project, opts, error);

describe('GithubService.recordDeployFailure', () => {
    it('marks the project errored and records the failure when nothing is serving', async () => {
        const stillServing = await call(
            { kind: 'deploy', trigger: 'webhook', branch: 'main', commitSha: SHA },
            new Error('build blew up'),
        );

        expect(stillServing).toBe(false);
        expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: ServiceStatus.ERROR });
        expect(ProcessService.emitStatus).not.toHaveBeenCalled();
        expect(deployRepo.create).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed', trigger: 'webhook', branch: 'main', commitSha: SHA,
            error: 'build blew up', stillServing: false,
        }));
        expect(NotificationService.notify).toHaveBeenCalledWith(project, expect.objectContaining({
            event: 'deploy.failed', title: 'demo deploy failed', success: false,
        }));
    });

    it('keeps the project running when the old version still serves', async () => {
        const err = new DeployError('health gate failed', { stillServing: true, strategy: 'blue-green' } as any);
        const stillServing = await call({ kind: 'deploy', trigger: 'manual', branch: 'main' }, err);

        expect(stillServing).toBe(true);
        expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: ServiceStatus.RUNNING });
        expect(ProcessService.emitStatus).toHaveBeenCalledWith('proj-1', ServiceStatus.RUNNING);
        expect(deployRepo.create).toHaveBeenCalledWith(expect.objectContaining({
            trigger: 'manual', stillServing: true, strategy: 'blue-green',
        }));
        expect(NotificationService.notify).toHaveBeenCalledWith(project, expect.objectContaining({
            message: expect.stringContaining('previous version kept serving'),
        }));
    });

    it('uses rollback copy for the rollback kind', async () => {
        const err = new DeployError('rollback broke', { stillServing: true, strategy: 'recreate' } as any);
        await call({ kind: 'rollback', trigger: 'rollback', branch: 'main', commitSha: SHA }, err);

        expect(NotificationService.notify).toHaveBeenCalledWith(project, expect.objectContaining({
            event: 'rollback.failed',
            title: 'demo rollback failed',
            message: expect.stringContaining('current version kept serving'),
        }));
    });

    it('does not throw when recording the deployment row fails', async () => {
        deployRepo.save = vi.fn(async () => { throw new Error('db down'); });

        await expect(call({ kind: 'deploy', trigger: 'webhook', branch: 'main' }, new Error('x'))).resolves.toBe(false);
    });
});
```

**Before writing the test, confirm `DeployError`'s real constructor signature** by reading `server/src/services/deployError.ts`, and adjust the two `new DeployError(...)` calls to match it. The `as any` casts above are a placeholder for whatever that signature turns out to be — do not leave a call that does not typecheck.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=server -- deployFailure`
Expected: FAIL — `recordDeployFailure is not a function`.

- [ ] **Step 3: Write the implementation**

In `server/src/services/github.service.ts`, add above `export class GithubService {`:

```ts
/** Notification wording for a failed deploy, by kind. */
const FAILURE_COPY = {
    deploy: {
        event: 'deploy.failed',
        title: (name: string) => `${name} deploy failed`,
        fallback: 'Deployment failed',
        keptServing: 'previous version kept serving, visitors saw nothing.',
    },
    rollback: {
        event: 'rollback.failed',
        title: (name: string) => `${name} rollback failed`,
        fallback: 'Rollback failed',
        keptServing: 'current version kept serving, visitors saw nothing.',
    },
} as const;

interface DeployFailureOpts {
    kind: keyof typeof FAILURE_COPY;
    trigger: DeploymentTrigger;
    branch: string;
    commitSha?: string;
    commitMessage?: string;
}
```

`DeploymentTrigger` is already imported as a type at line 5. Add `recordDeployFailure` as a private static on `GithubService`:

```ts
    /**
     * The shared failure path for every deploy trigger. A failed zero-downtime
     * deploy leaves the OLD version serving — status must then say RUNNING, not
     * ERROR, or the UI lies and the health monitor "fixes" a healthy site.
     * Updates only the status: the deploy may have persisted fresh
     * containerId/port values that a stale entity must not overwrite.
     *
     * Returns whether the previous version kept serving.
     */
    private static async recordDeployFailure(
        project: Project,
        opts: DeployFailureOpts,
        error: any,
    ): Promise<boolean> {
        const copy = FAILURE_COPY[opts.kind];
        const stillServing = error instanceof DeployError && error.stillServing;

        await AppDataSource.getRepository(Project).update(project.id, {
            status: stillServing ? ServiceStatus.RUNNING : ServiceStatus.ERROR,
        });
        if (stillServing) ProcessService.emitStatus(project.id, ServiceStatus.RUNNING);

        await GithubService.recordDeployment(project.id, {
            status: 'failed',
            trigger: opts.trigger,
            branch: opts.branch,
            commitSha: opts.commitSha,
            commitMessage: opts.commitMessage,
            error: error?.message,
            stillServing,
            strategy: error instanceof DeployError ? error.strategy : undefined,
        }).catch(() => { });

        await NotificationService.notify(project, {
            event: copy.event,
            title: copy.title(project.name),
            message: stillServing
                ? `${error?.message || copy.fallback} — ${copy.keptServing}`
                : error?.message || copy.fallback,
            success: false,
            meta: { branch: opts.branch, commit: opts.commitSha?.slice(0, 7) },
        });

        return stillServing;
    }
```

Then replace the catch block of `handlePushEvent` (currently lines 255-286) so its body is:

```ts
        } catch (error: any) {
            await GithubService.recordDeployFailure(project, {
                kind: 'deploy',
                trigger: 'webhook',
                branch: githubRepo.branch,
                commitSha: deployed.sha,
                commitMessage: deployed.message,
            }, error);
            throw error;
        }
```

And the catch block of `rollbackToDeployment` (currently lines 377-407):

```ts
        } catch (error: any) {
            await GithubService.recordDeployFailure(project, {
                kind: 'rollback',
                trigger: 'rollback',
                branch: project.githubRepo.branch,
                commitSha,
                commitMessage: target.commitMessage,
            }, error);
            throw error;
        }
```

If `NotificationService.notify`'s `event` parameter is a narrow string-literal
union, `copy.event` (typed by `as const`) will satisfy it; if it does not
typecheck, widen `FAILURE_COPY`'s `event` to that union type rather than to
`string`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace=server -- deployFailure`
Expected: 4 passed.

Run: `npm test --workspace=server && npm run build --workspace=server`
Expected: all tests pass, build exits 0.

- [ ] **Step 5: Verify no behaviour drift**

Run: `git diff -U3 server/src/services/github.service.ts`

Confirm by eye that the two rewritten catch blocks produce the same status
writes, the same `Deployment` fields, and the same notification `event`/`title`/
`message` strings as the code they replaced. This is a refactor: any difference
is a bug.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/github.service.ts server/src/__tests__/deployFailure.test.ts
git commit -m "refactor: extract GithubService.recordDeployFailure from the deploy and rollback paths"
```

---

### Task 3: `GithubService.syncLatest`

The core of the feature. Fetches the tracked branch under the project lock, decides whether anything needs deploying, and records/notifies exactly as the webhook path does.

Two behaviours that are easy to get wrong and that the tests pin down:

1. **The `DEPLOYING` status write happens *after* the skip decision**, inside `prepare`. `handlePushEvent` sets it up front (`github.service.ts:201`); doing that here would leave a skipped sync displaying `DEPLOYING` forever.
2. **A `git fetch` failure must not mark a healthy project `ERROR`.** The `started` flag tracks whether we got as far as mutating the working tree; failures before that point rethrow without touching status or writing a `Deployment` row.

**Files:**
- Modify: `server/src/entities/Deployment.ts:13`
- Modify: `server/src/services/github.service.ts` (add `SyncResult` + `syncLatest`, after `rollbackToDeployment`, before the closing `}` of the class)
- Test: `server/src/__tests__/githubSync.test.ts` (create)

**Interfaces:**
- Consumes: `ProcessService.redeployExclusive(projectId, prepare: () => Promise<void | boolean>)` from Task 1; `GithubService.recordDeployFailure(project, opts, error)` from Task 2.
- Produces:
  - `export type DeploymentTrigger = 'webhook' | 'rollback' | 'manual'`
  - `export interface SyncResult { deployed: boolean; upToDate: boolean; commitSha?: string; deployment?: Deployment }`
  - `GithubService.syncLatest(projectId: string): Promise<SyncResult>`

- [ ] **Step 1: Widen the trigger union**

In `server/src/entities/Deployment.ts`, replace line 13:

```ts
export type DeploymentTrigger = 'webhook' | 'rollback' | 'manual';
```

No migration: the column is `@Column({ type: 'varchar' })` (line 42-43) and the migration created it as `"trigger" varchar NOT NULL`.

- [ ] **Step 2: Write the failing test**

`ProcessService` is mocked, so `redeployExclusive` never really deploys — the stub invokes `prepare` and mirrors the Task 1 contract. That keeps the test focused on `syncLatest`'s decision logic.

Create `server/src/__tests__/githubSync.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/sandbox.service', () => ({
    SandboxService: { exec: vi.fn() },
}));
vi.mock('../services/process.service', () => ({
    ProcessService: { redeployExclusive: vi.fn(), emitStatus: vi.fn() },
}));
vi.mock('../services/notification.service', () => ({
    NotificationService: { notify: vi.fn() },
}));
vi.mock('../config/data-source', () => ({
    AppDataSource: { getRepository: vi.fn() },
}));

import { GithubService } from '../services/github.service';
import { SandboxService } from '../services/sandbox.service';
import { ProcessService } from '../services/process.service';
import { AppDataSource } from '../config/data-source';
import { Project, GithubRepo, Deployment, ServiceStatus } from '../entities';

const LOCAL_SHA = 'a'.repeat(40);
const REMOTE_SHA = 'b'.repeat(40);

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

/** Fake `git` that answers from the given local/remote SHAs. */
function stubGit(localSha: string, remoteSha: string) {
    vi.mocked(SandboxService.exec).mockImplementation(async (_p: any, _cmd: any, args: any) => {
        const a = (args as string[]).join(' ');
        if (a.startsWith('fetch')) return ok();
        if (a === 'rev-parse HEAD') return ok(`${localSha}\n`);
        if (a === 'rev-parse FETCH_HEAD') return ok(`${remoteSha}\n`);
        if (a.startsWith('reset')) return ok();
        if (a.startsWith('log')) return ok(`${remoteSha}\nnew commit subject\n`);
        throw new Error(`unexpected git invocation: ${a}`);
    });
}

let projectRepo: any;
let githubRepoRepo: any;
let deployRepo: any;

function stubProject(status: ServiceStatus) {
    projectRepo = {
        findOne: vi.fn(async () => ({
            id: 'proj-1',
            name: 'demo',
            status,
            directoryPath: '/srv/demo',
            githubRepo: { branch: 'main', repoUrl: 'https://github.com/o/r' },
        })),
        update: vi.fn(async () => undefined),
    };
    githubRepoRepo = { save: vi.fn(async (x: any) => x) };
    deployRepo = {
        create: vi.fn((d: any) => d),
        save: vi.fn(async (d: any) => ({ id: 'dep-1', ...d })),
    };
    vi.mocked(AppDataSource.getRepository).mockImplementation((entity: any) => {
        if (entity === Project) return projectRepo;
        if (entity === GithubRepo) return githubRepoRepo;
        if (entity === Deployment) return deployRepo;
        throw new Error('unexpected repository');
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    // Mirror the real redeployExclusive contract from Task 1.
    vi.mocked(ProcessService.redeployExclusive).mockImplementation(async (_id: any, prepare: any) => {
        if (await prepare() === false) return { ran: false };
        return { ran: true, strategy: 'blue-green', durationMs: 1234, healthGate: 'passed' };
    });
});

describe('GithubService.syncLatest', () => {
    it('skips the deploy when the branch tip is already checked out and the project is running', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, LOCAL_SHA);

        const result = await GithubService.syncLatest('proj-1');

        expect(result).toEqual({ deployed: false, upToDate: true, commitSha: LOCAL_SHA });
        expect(deployRepo.save).not.toHaveBeenCalled();
        expect(projectRepo.update).not.toHaveBeenCalled();
        const gitCalls = vi.mocked(SandboxService.exec).mock.calls.map((c: any) => (c[2] as string[])[0]);
        expect(gitCalls).not.toContain('reset');
    });

    it('deploys at the same commit when the project is not running', async () => {
        stubProject(ServiceStatus.ERROR);
        stubGit(LOCAL_SHA, LOCAL_SHA);

        const result = await GithubService.syncLatest('proj-1');

        expect(result.deployed).toBe(true);
        expect(result.upToDate).toBe(false);
        expect(deployRepo.save).toHaveBeenCalledOnce();
        expect(deployRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'manual', status: 'success', branch: 'main' }),
        );
    });

    it('resets to the branch tip and deploys when there is a new commit', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, REMOTE_SHA);

        const result = await GithubService.syncLatest('proj-1');

        expect(result.deployed).toBe(true);
        expect(result.commitSha).toBe(REMOTE_SHA);
        expect(SandboxService.exec).toHaveBeenCalledWith(
            'proj-1', 'git', ['reset', '--hard', 'FETCH_HEAD'], '/srv/demo',
        );
        expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: ServiceStatus.DEPLOYING });
        expect(deployRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'manual', commitSha: REMOTE_SHA, commitMessage: 'new commit subject' }),
        );
    });

    it('rethrows a fetch failure without marking the project errored', async () => {
        stubProject(ServiceStatus.RUNNING);
        vi.mocked(SandboxService.exec).mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'could not read Username' });

        await expect(GithubService.syncLatest('proj-1')).rejects.toThrow(/Git fetch failed/);
        expect(projectRepo.update).not.toHaveBeenCalled();
        expect(deployRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a project with no GitHub repo connected', async () => {
        stubProject(ServiceStatus.RUNNING);
        projectRepo.findOne = vi.fn(async () => ({ id: 'proj-1', status: ServiceStatus.RUNNING, directoryPath: '/srv/demo' }));

        await expect(GithubService.syncLatest('proj-1')).rejects.toThrow(/No GitHub repo connected/);
        expect(ProcessService.redeployExclusive).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test --workspace=server -- githubSync`
Expected: FAIL — `GithubService.syncLatest is not a function` (or a TypeScript error that the property does not exist).

- [ ] **Step 4: Write the implementation**

In `server/src/services/github.service.ts`, add the result type just above `export class GithubService {` (line 12):

```ts
export interface SyncResult {
    /** True when a build actually ran. */
    deployed: boolean;
    /** True when nothing was deployed because the tip was already serving. */
    upToDate: boolean;
    commitSha?: string;
    deployment?: Deployment;
}
```

Then add `syncLatest` as the last method of the class, after `rollbackToDeployment`:

```ts
    /**
     * Manual counterpart to handlePushEvent, for when a webhook delivery never
     * arrived. Fetches the tracked branch and redeploys its tip. Takes no
     * commit argument — there is no payload to trust, so the deployed commit is
     * whatever the fetch resolves.
     *
     * Skips the build when the tip is already checked out AND the project is
     * running. A project sitting at the tip in any other state (ERROR, STOPPED,
     * or a DEPLOYING left stale by a crash) is redeployed: that is the case
     * this button exists for.
     */
    static async syncLatest(projectId: string): Promise<SyncResult> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: ['githubRepo'],
        });
        if (!project) throw new AppError('Project not found', 404);
        if (!project.githubRepo) throw new AppError('No GitHub repo connected to this project', 400);

        const githubRepo = project.githubRepo;
        const branch = githubRepo.branch;
        const dir = project.directoryPath;

        const deployed: { sha?: string; message?: string } = {};
        let upToDate = false;
        // Guards the catch block: a failure before we touch the working tree
        // (e.g. a fetch that can't authenticate) must not mark a healthy
        // project ERROR or record a deployment that never started.
        let started = false;

        try {
            const result = await ProcessService.redeployExclusive(projectId, async () => {
                const fetchResult = await SandboxService.exec(
                    projectId, 'git',
                    ['fetch', '--depth', '1', 'origin', branch],
                    dir,
                );
                if (fetchResult.exitCode !== 0) {
                    throw new Error(`Git fetch failed: ${fetchResult.stderr}`);
                }

                const local = await SandboxService.exec(projectId, 'git', ['rev-parse', 'HEAD'], dir);
                const remote = await SandboxService.exec(projectId, 'git', ['rev-parse', 'FETCH_HEAD'], dir);
                const localSha = local.stdout.trim();
                const remoteSha = remote.stdout.trim();

                if (localSha && localSha === remoteSha && project.status === ServiceStatus.RUNNING) {
                    upToDate = true;
                    deployed.sha = localSha;
                    return false;
                }

                const resetResult = await SandboxService.exec(
                    projectId, 'git',
                    ['reset', '--hard', 'FETCH_HEAD'],
                    dir,
                );
                if (resetResult.exitCode !== 0) {
                    throw new Error(`Git reset failed: ${resetResult.stderr}`);
                }

                started = true;
                await projectRepo.update(projectId, { status: ServiceStatus.DEPLOYING });
                ProcessService.emitStatus(projectId, ServiceStatus.DEPLOYING);

                const head = await SandboxService.exec(
                    projectId, 'git',
                    ['log', '-1', '--pretty=%H%n%s'],
                    dir,
                );
                if (head.exitCode === 0) {
                    const [sha, message] = head.stdout.trim().split('\n');
                    if (sha) {
                        deployed.sha = sha;
                        deployed.message = message;
                    }
                }

                githubRepo.lastDeployAt = new Date();
                await AppDataSource.getRepository(GithubRepo).save(githubRepo);
                return true;
            });

            if (!result.ran) {
                return { deployed: false, upToDate, commitSha: deployed.sha };
            }

            const deployment = await GithubService.recordDeployment(projectId, {
                status: 'success',
                trigger: 'manual',
                branch,
                commitSha: deployed.sha,
                commitMessage: deployed.message,
                strategy: result.strategy,
                durationMs: result.durationMs,
                healthGate: result.healthGate,
                strategyReason: result.strategyReason,
            });
            await NotificationService.notify(project, {
                event: 'deploy.success',
                title: `${project.name} deployed`,
                message: deployed.message || 'Deployed latest commit',
                success: true,
                meta: { branch, commit: deployed.sha?.slice(0, 7) },
            });
            return { deployed: true, upToDate: false, commitSha: deployed.sha, deployment };
        } catch (error: any) {
            // A failure before the working tree was touched (e.g. a fetch that
            // can't authenticate) must not mark a healthy project ERROR or
            // record a deployment that never started.
            if (!started) throw error;

            await GithubService.recordDeployFailure(project, {
                kind: 'deploy',
                trigger: 'manual',
                branch,
                commitSha: deployed.sha,
                commitMessage: deployed.message,
            }, error);
            throw error;
        }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace=server -- githubSync`
Expected: 5 passed.

Run: `npm test --workspace=server`
Expected: all passed (smoke + redeployExclusive + githubSync).

Run: `npm run build --workspace=server`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/entities/Deployment.ts server/src/services/github.service.ts server/src/__tests__/githubSync.test.ts
git commit -m "feat: GithubService.syncLatest — manual fetch + redeploy of the branch tip"
```

---

### Task 4: `POST /:id/github/sync` route

**Files:**
- Modify: `server/src/routes/github.routes.ts` (insert after the `disconnect` route, before the deployments routes at line 119)

**Interfaces:**
- Consumes: `GithubService.syncLatest(projectId: string): Promise<SyncResult>` from Task 3.
- Produces: `POST /api/projects/:id/github/sync` → `200 { deployed, upToDate, commitSha?, deployment? }`.

- [ ] **Step 1: Add the route**

The router already applies `authenticate, requireApproval` to every route (line 16), and is mounted at `/api/projects` alongside `projects.routes.ts`. Insert:

```ts
// Manually fetch the tracked branch and deploy its tip. The escape hatch for a
// webhook that never arrived. Lifecycle op → canStart, same as rollback.
router.post('/:id/github/sync', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const result = await GithubService.syncLatest(project.id);
        res.json(result);
    } catch (error) {
        next(error);
    }
});
```

No new imports: `ProjectPermission`, `GithubService`, `Project`, `AuthRequest`, `requireProjectAccess` are all already imported (lines 3-7).

- [ ] **Step 2: Verify it typechecks**

Run: `npm run build --workspace=server`
Expected: exit 0.

- [ ] **Step 3: Verify the route is registered**

Run: `grep -n "github/sync" server/dist/routes/github.routes.js`
Expected: one match, confirming the compiled router carries the path.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/github.routes.ts
git commit -m "feat: POST /:id/github/sync route for manual GitHub sync"
```

---

### Task 5: Client — button and history chip

**Files:**
- Modify: `client/src/api/projects.ts:108` (trigger union), `:116` (add `SyncResult`), `:148` (add `syncGithub`)
- Modify: `client/src/pages/ProjectDetail.tsx` — imports (line 14), state (near line 62), handler (after `handleRollback`, line 209), GitHub tab UI (line 597), history chip (line 684)

**Interfaces:**
- Consumes: `POST /api/projects/:id/github/sync` from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the API types and call**

In `client/src/api/projects.ts`, change line 108 to:

```ts
    trigger: 'webhook' | 'rollback' | 'manual';
```

Add after the `Deployment` interface (after line 116):

```ts
export interface SyncResult {
    deployed: boolean;
    upToDate: boolean;
    commitSha?: string;
    deployment?: Deployment;
}
```

Add to `projectsApi`, directly after `disconnectGithub` (line 148):

```ts
    syncGithub: (id: string) => api.post<SyncResult>(`/projects/${id}/github/sync`),
```

- [ ] **Step 2: Add the handler and state to `ProjectDetail.tsx`**

Extend the lucide import on line 14 with `RefreshCw`:

```tsx
    ArrowLeft, Play, Square, RotateCcw, Trash2, Globe,
    FolderGit2, Plus, CheckCircle2, XCircle, ExternalLink, Link, Edit, Users, UserPlus, RefreshCw
```

Add state next to `rollbackLoading` (line 62):

```tsx
    const [syncing, setSyncing] = useState(false);
    const [syncMessage, setSyncMessage] = useState('');
```

Add the handler after `handleRollback` (after line 209):

```tsx
    const handleGithubSync = async () => {
        if (!id) return;
        setSyncing(true);
        setSyncMessage('');
        try {
            const { data } = await projectsApi.syncGithub(id);
            setSyncMessage(
                data.upToDate
                    ? `Already up to date${data.commitSha ? ` — ${data.commitSha.slice(0, 7)}` : ''}`
                    : `Deployed ${data.commitSha?.slice(0, 7) || 'latest commit'}`,
            );
            await Promise.all([loadDeployments(), fetchProject(id)]);
        } catch (err: any) {
            setSyncMessage(err.response?.data?.error || 'Sync failed');
        }
        setSyncing(false);
    };
```

- [ ] **Step 3: Add the button to the GitHub tab**

In the connected-repo block, replace the lone Disconnect button (line 597) with a button row, and render the result message under the repo info. Replace lines 596-598:

```tsx
                                    </div>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                        {canStart && (
                                            <button className="btn btn-secondary" onClick={handleGithubSync} disabled={syncing}>
                                                {syncing ? <span className="spinner" /> : <RefreshCw size={16} />} Check for updates
                                            </button>
                                        )}
                                        {canEditConfig && <button className="btn btn-danger" onClick={handleGithubDisconnect}>Disconnect</button>}
                                    </div>
                                </div>
                                {syncMessage && (
                                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>{syncMessage}</div>
                                )}
```

(`canStart` is defined at `ProjectDetail.tsx:111`; the `spinner` class is the same one the rollback button uses at line 723.)

- [ ] **Step 4: Add the `Manual` chip to deployment history**

After the `rollback` chip (after line 684), add:

```tsx
                                                {d.trigger === 'manual' && (
                                                    <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, background: 'rgba(160, 160, 255, 0.15)', color: '#a0a0ff' }}>
                                                        Manual
                                                    </span>
                                                )}
```

- [ ] **Step 5: Verify it builds**

Run: `npm run build --workspace=client`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/api/projects.ts client/src/pages/ProjectDetail.tsx
git commit -m "feat: 'Check for updates' button and Manual deploy chip"
```

---

### Task 6: End-to-end verification

Unit tests mock away git and Docker, so nothing so far has proven the button works against a real repo.

**Files:** none modified.

- [ ] **Step 1: Verify the full suite and both builds**

```bash
npm test --workspace=server && npm run build --workspace=server && npm run build --workspace=client
```
Expected: all tests pass, both builds exit 0.

- [ ] **Step 2: Drive the real flow**

Use the `verify` skill, or manually against a dev server with a GitHub-connected project:

1. Click **Check for updates** on a running project already at the branch tip → "Already up to date — `<sha7>`", no new row in Deployment History, project stays `running`.
2. Push a commit to the tracked branch with the webhook disabled (or the hook deleted in GitHub's UI), then click → the project rebuilds, `DeployActivityCard` shows progress, and a new history row appears carrying the **Manual** chip and the new SHA.
3. Stop the project (so status is `stopped`), click without pushing anything → it redeploys at the same commit rather than reporting up-to-date.

Report the observed outcome of each. Do not mark this task complete on the basis of the unit tests alone.

---

## Notes for the Implementer

- **Do not** set `ServiceStatus.DEPLOYING` before the skip check. That is the single most likely mistake, because `handlePushEvent` (the function you are mirroring) does exactly that — it can afford to, because a webhook push always deploys.
- **Do not** use `ProcessService.redeploy`. It coalesces, meaning a click can be silently dropped when a deploy is already queued.
- **Do not** add a database migration. The `trigger` column is already a `varchar`.
- The `started` flag in `syncLatest` exists so a `git fetch` failure (bad credentials, deleted branch) rethrows cleanly without flipping a healthy, running project to `ERROR`.
