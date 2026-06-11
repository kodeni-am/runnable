# Preview/PR Deployments — Phase 2 (Core Lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make pull-request events actually create, redeploy, and tear down preview environments. Build `PreviewService` (create/update/destroy with per-PR serialization) on top of the Phase 1 seams, route `pull_request` webhook events to it, and ensure the GitHub webhook subscribes to those events.

**Architecture:** A preview is provisioned via `ProjectProvisioningService.provisionCore` (no quota/permission checks), gets its own `GithubRepo` row (same `repoUrl`, PR head branch, **no webhook**), is cloned + deployed with the existing `ProcessService`, records to deploy history, and is torn down via `ProjectTeardownService.teardown`. All create/update/destroy for a given `(parentProjectId, prNumber)` is serialized by an in-process lock (the project lock can't cover a not-yet-created row). Pure decision logic (fork detection, subdomain derivation, env merge) lives in a dependency-free helper module that is unit-tested.

**Tech Stack:** TypeScript, Express 5, TypeORM 0.3 (Postgres), Vitest (set up in Phase 1).

**Spec:** `docs/superpowers/specs/2026-06-11-preview-deployments-design.md`
**Builds on:** Phase 1 (`feat/preview-deployments-phase1`) — `ProjectProvisioningService.provisionCore`, `ProjectTeardownService.teardown`, the preview columns, and the parent-only webhook resolution already exist.

**Working directory for all commands:** `/Users/araasryan/Projects/runnable/server` unless stated.

**Scope (Phase 2 only):** preview lifecycle + `pull_request` handling + `ensureWebhookEvents`. NOT in this phase: TLS / `baseDomain` config emission / `tls-check` endpoint (Phase 3); Settings UI / Previews tab / TTL sweep (Phase 4). Preview projects will deploy and be reachable only after Phase 3 wires `baseDomain` into Caddy config — that is expected; Phase 2 is verifiable by unit tests + type-check.

---

## File Structure (Phase 2)

- **Create** `server/src/services/preview.helpers.ts` — pure functions: `isForkPR`, `derivePreviewSubdomain`, `mergePreviewEnv`, `previewHostname`, and the `PullRequestInfo` type.
- **Create** `server/src/services/__tests__/preview.helpers.test.ts` — unit tests for the helpers.
- **Create** `server/src/services/preview.service.ts` — `PreviewService` (per-PR lock, `handlePullRequest`, `createOrUpdate`, `destroy`).
- **Create** `server/src/services/__tests__/preview.service.test.ts` — routing + lock tests with mocked collaborators.
- **Modify** `server/src/services/github.service.ts` — `setupWebhook` requests `['push','pull_request']`; add `ensureWebhookEvents`.
- **Modify** `server/src/routes/webhooks.routes.ts` — verify signature for `pull_request` too, then route to `PreviewService`.

---

## Task 1: Pure preview helpers (TDD)

**Files:**
- Create: `server/src/services/preview.helpers.ts`
- Create: `server/src/services/__tests__/preview.helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/services/__tests__/preview.helpers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
    isForkPR,
    derivePreviewSubdomain,
    mergePreviewEnv,
    previewHostname,
    type PullRequestInfo,
} from '../preview.helpers';

const sameRepoPR: PullRequestInfo = {
    number: 7,
    head: { ref: 'feature/x', repo: { full_name: 'acme/app' } },
    base: { repo: { full_name: 'acme/app' } },
};

describe('isForkPR', () => {
    it('is false for a same-repo branch PR', () => {
        expect(isForkPR(sameRepoPR)).toBe(false);
    });
    it('is true when head repo differs from base repo', () => {
        expect(isForkPR({ ...sameRepoPR, head: { ref: 'x', repo: { full_name: 'evil/app' } } })).toBe(true);
    });
    it('is true when head repo is null (deleted fork)', () => {
        expect(isForkPR({ ...sameRepoPR, head: { ref: 'x', repo: null } })).toBe(true);
    });
});

describe('derivePreviewSubdomain', () => {
    it('produces a valid subdomain', () => {
        const sub = derivePreviewSubdomain('myapp', 42, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(sub).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
        expect(sub.startsWith('pr-42-')).toBe(true);
    });
    it('is deterministic for the same inputs', () => {
        const a = derivePreviewSubdomain('myapp', 42, 'pid-1');
        const b = derivePreviewSubdomain('myapp', 42, 'pid-1');
        expect(a).toBe(b);
    });
    it('differs by parent project id (avoids cross-parent collision)', () => {
        const a = derivePreviewSubdomain('myapp', 42, 'pid-1');
        const b = derivePreviewSubdomain('myapp', 42, 'pid-2');
        expect(a).not.toBe(b);
    });
    it('stays within the 63-char DNS label limit for long parent names', () => {
        const sub = derivePreviewSubdomain('a'.repeat(80), 12345, 'pid-1');
        expect(sub.length).toBeLessThanOrEqual(63);
        expect(sub).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    });
});

describe('mergePreviewEnv', () => {
    it('overrides parent env with overrides, then injected wins over both', () => {
        const merged = mergePreviewEnv(
            { A: 'parent', B: 'parent' },
            { B: 'override', C: 'override' },
            { C: 'injected', D: 'injected' },
        );
        expect(merged).toEqual({ A: 'parent', B: 'override', C: 'injected', D: 'injected' });
    });
    it('handles null/undefined parent and overrides', () => {
        expect(mergePreviewEnv(null, undefined, { X: '1' })).toEqual({ X: '1' });
    });
});

describe('previewHostname', () => {
    it('joins subdomain and base domain', () => {
        expect(previewHostname('pr-1-app-abc', 'preview.example.com')).toBe('pr-1-app-abc.preview.example.com');
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/services/__tests__/preview.helpers.test.ts`
Expected: FAIL — cannot resolve `../preview.helpers`.

- [ ] **Step 3: Implement the helpers**

Create `server/src/services/preview.helpers.ts`:
```ts
import crypto from 'crypto';

/** The slice of a GitHub `pull_request` webhook payload the lifecycle needs. */
export interface PullRequestInfo {
    number: number;
    head: { ref: string; repo: { full_name: string } | null };
    base: { repo: { full_name: string } };
}

/**
 * A PR is "from a fork" when its head repo differs from the base repo (or the
 * head repo is null — a deleted fork). Fork PRs contain untrusted code and are
 * never auto-built.
 */
export function isForkPR(pr: PullRequestInfo): boolean {
    return !pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name;
}

// Leave headroom under the 63-char DNS label limit.
const MAX_LABEL = 50;

/**
 * Deterministic, collision-resistant preview subdomain: `pr-<n>-<slug>-<hash>`,
 * where `slug` is the (truncated) parent subdomain and `hash` is a short digest
 * of the parent project id (so two different parents never collide, and a real
 * project literally named `pr-<n>-...` won't either). Stable for a given
 * (parentSubdomain, prNumber, parentProjectId), so reopening a PR reuses it.
 */
export function derivePreviewSubdomain(parentSubdomain: string, prNumber: number, parentProjectId: string): string {
    const hash = crypto.createHash('sha256').update(parentProjectId).digest('hex').slice(0, 6);
    const prefix = `pr-${prNumber}-`;
    const suffix = `-${hash}`;
    const room = MAX_LABEL - prefix.length - suffix.length;
    const slug = parentSubdomain.slice(0, Math.max(1, room));
    return `${prefix}${slug}${suffix}`.toLowerCase();
}

/** parent env ⊕ overrides (override wins) ⊕ injected (always wins). */
export function mergePreviewEnv(
    parentEnv: Record<string, string> | null | undefined,
    overrides: Record<string, string> | null | undefined,
    injected: Record<string, string>,
): Record<string, string> {
    return { ...(parentEnv || {}), ...(overrides || {}), ...injected };
}

export function previewHostname(subdomain: string, baseDomain: string): string {
    return `${subdomain}.${baseDomain}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- src/services/__tests__/preview.helpers.test.ts`
Expected: PASS — all helper tests green.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/preview.helpers.ts server/src/services/__tests__/preview.helpers.test.ts
git commit -m "feat: pure preview helpers (fork detection, subdomain derivation, env merge)"
```

---

## Task 2: GitHub webhook event subscription

**Files:**
- Modify: `server/src/services/github.service.ts`

- [ ] **Step 1: Subscribe new webhooks to pull_request**

In `server/src/services/github.service.ts`, in `setupWebhook`, change the request body's `events` array from `['push']` to:
```ts
                events: ['push', 'pull_request'],
```

- [ ] **Step 2: Add `ensureWebhookEvents`**

In `server/src/services/github.service.ts`, add this method to the `GithubService` class (place it immediately after `setupWebhook`, before `removeWebhook`):
```ts
    /**
     * PATCH an existing webhook so it is subscribed to the given events. Used
     * when previews are enabled on a repo whose webhook was created before
     * preview support (push-only). Best-effort: throws only on a hard API error.
     */
    static async ensureWebhookEvents(
        repoUrl: string,
        token: string,
        webhookId: string,
        events: string[],
    ): Promise<void> {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) throw new Error('Invalid GitHub repo URL');
        const [, owner, repo] = match;

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks/${webhookId}`, {
            method: 'PATCH',
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ events }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to update webhook events: ${error}`);
        }
    }
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/github.service.ts
git commit -m "feat: subscribe webhooks to pull_request; add ensureWebhookEvents"
```

---

## Task 3: PreviewService (lifecycle + per-PR lock)

**Files:**
- Create: `server/src/services/preview.service.ts`
- Create: `server/src/services/__tests__/preview.service.test.ts`

This service is the orchestration core. It depends on DB repositories and the provisioning/clone/deploy/teardown collaborators, so the test mocks those collaborators (via `vi.mock`) and verifies the routing + per-PR serialization, which is the logic that matters.

- [ ] **Step 1: Implement the service**

Create `server/src/services/preview.service.ts`:
```ts
import { AppDataSource } from '../config/data-source';
import { Project, GithubRepo, ServiceStatus, ServerType, User } from '../entities';
import { ProjectProvisioningService } from './projectProvisioning.service';
import { ProjectTeardownService } from './projectTeardown.service';
import { ProcessService } from './process.service';
import { GithubService } from './github.service';
import { NotificationService } from './notification.service';
import { isForkPR, derivePreviewSubdomain, mergePreviewEnv, previewHostname, type PullRequestInfo } from './preview.helpers';

export type PullRequestAction = 'opened' | 'reopened' | 'synchronize' | 'closed' | string;

export class PreviewService {
    // Serialize create/update/destroy per (parentProjectId, prNumber). The
    // project lock can't cover a preview that doesn't exist yet, so a fast
    // opened→synchronize burst would otherwise race. Same promise-chain pattern
    // as ProcessService.withProjectLock.
    private static readonly prLocks = new Map<string, Promise<unknown>>();

    private static withPreviewLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = PreviewService.prLocks.get(key) ?? Promise.resolve();
        const next = prev.catch(() => { }).then(fn);
        PreviewService.prLocks.set(key, next);
        next.finally(() => {
            if (PreviewService.prLocks.get(key) === next) PreviewService.prLocks.delete(key);
        }).catch(() => { });
        return next;
    }

    /**
     * Entry point from the webhook receiver. `parent` is the resolved
     * non-preview project (with githubRepo relation). Returns a short status
     * string for logging. Guards (previewsEnabled, fork, base domain) live
     * here so the receiver stays thin.
     */
    static async handlePullRequest(parent: Project, action: PullRequestAction, pr: PullRequestInfo): Promise<string> {
        if (!parent.previewsEnabled || !parent.previewBaseDomain) {
            return 'previews-disabled';
        }
        if (isForkPR(pr)) {
            return 'fork-skipped';
        }

        const key = `${parent.id}:${pr.number}`;
        if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
            return PreviewService.withPreviewLock(key, () => PreviewService.createOrUpdate(parent, pr));
        }
        if (action === 'closed') {
            return PreviewService.withPreviewLock(key, () => PreviewService.destroyForPr(parent.id, pr.number));
        }
        return 'ignored-action';
    }

    private static async findPreview(parentProjectId: string, prNumber: number): Promise<Project | null> {
        return AppDataSource.getRepository(Project).findOne({
            where: { parentProjectId, prNumber, isPreview: true },
            relations: ['githubRepo'],
        });
    }

    private static async createOrUpdate(parent: Project, pr: PullRequestInfo): Promise<string> {
        const existing = await PreviewService.findPreview(parent.id, pr.number);
        if (existing) {
            await PreviewService.redeployExisting(existing, pr);
            return 'redeployed';
        }
        await PreviewService.createNew(parent, pr);
        return 'created';
    }

    private static async createNew(parent: Project, pr: PullRequestInfo): Promise<void> {
        if (!parent.githubRepo) throw new Error('Parent project has no connected GitHub repo');

        const owner = await AppDataSource.getRepository(User).findOne({ where: { id: parent.userId } });
        if (!owner) throw new Error('Parent project owner not found');

        const subdomain = derivePreviewSubdomain(parent.subdomain, pr.number, parent.id);
        const baseDomain = parent.previewBaseDomain!;
        const env = mergePreviewEnv(parent.envVars, parent.previewEnvOverrides, {
            RUNNABLE_PREVIEW_URL: `https://${previewHostname(subdomain, baseDomain)}`,
            PR_NUMBER: String(pr.number),
        });

        const preview = await ProjectProvisioningService.provisionCore(
            owner,
            `${parent.name} PR #${pr.number}`,
            subdomain,
            parent.serverType as ServerType,
            {
                isPreview: true,
                parentProjectId: parent.id,
                prNumber: pr.number,
                prBranch: pr.head.ref,
                baseDomain,
                buildCommand: parent.buildCommand,
                startCommand: parent.startCommand,
                useCompose: parent.useCompose,
                composeFile: parent.composeFile,
                composeService: parent.composeService,
                internalPort: parent.internalPort,
                notificationWebhookUrl: parent.notificationWebhookUrl,
                envVars: env,
            },
        );

        // The preview gets its own GithubRepo row (same URL, PR head branch),
        // but NO webhook — the parent's single webhook drives all its previews.
        const repoRepo = AppDataSource.getRepository(GithubRepo);
        await repoRepo.save(repoRepo.create({
            repoUrl: parent.githubRepo.repoUrl,
            branch: pr.head.ref,
            isPrivate: parent.githubRepo.isPrivate,
            projectId: preview.id,
        }));

        const token = owner.githubToken || undefined;
        await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.DEPLOYING });

        try {
            await GithubService.cloneRepo(preview.id, parent.githubRepo.repoUrl, preview.directoryPath, pr.head.ref, token);
            await ProcessService.start(preview.id);
            await AppDataSource.getRepository(Project).update(preview.id, { lastActivityAt: new Date() });
            await GithubService.recordDeployment(preview.id, {
                status: 'success', trigger: 'webhook', branch: pr.head.ref,
                commitMessage: `Preview for PR #${pr.number}`,
            });
            await NotificationService.notify(preview, {
                event: 'preview.deployed',
                title: `Preview for ${parent.name} PR #${pr.number} is up`,
                message: `https://${previewHostname(subdomain, baseDomain)}`,
                success: true,
                meta: { pr: String(pr.number), branch: pr.head.ref },
            });
        } catch (error: any) {
            await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.ERROR });
            await GithubService.recordDeployment(preview.id, {
                status: 'failed', trigger: 'webhook', branch: pr.head.ref,
                error: error?.message,
            }).catch(() => { });
            await NotificationService.notify(preview, {
                event: 'preview.failed',
                title: `Preview for ${parent.name} PR #${pr.number} failed`,
                message: error?.message || 'Preview build failed',
                success: false,
                meta: { pr: String(pr.number), branch: pr.head.ref },
            });
        }
    }

    private static async redeployExisting(preview: Project, pr: PullRequestInfo): Promise<void> {
        await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.DEPLOYING });
        try {
            const ran = await ProcessService.redeploy(preview.id, async () => {
                await GithubService.pullLatest(preview.id, preview.directoryPath, pr.head.ref);
            });
            if (ran) {
                await AppDataSource.getRepository(Project).update(preview.id, { lastActivityAt: new Date() });
                await GithubService.recordDeployment(preview.id, {
                    status: 'success', trigger: 'webhook', branch: pr.head.ref,
                    commitMessage: `Preview update for PR #${pr.number}`,
                });
            }
        } catch (error: any) {
            await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.ERROR });
            await GithubService.recordDeployment(preview.id, {
                status: 'failed', trigger: 'webhook', branch: pr.head.ref, error: error?.message,
            }).catch(() => { });
            await NotificationService.notify(preview, {
                event: 'preview.failed',
                title: `Preview update for PR #${pr.number} failed`,
                message: error?.message || 'Preview redeploy failed',
                success: false,
                meta: { pr: String(pr.number), branch: pr.head.ref },
            });
        }
    }

    private static async destroyForPr(parentProjectId: string, prNumber: number): Promise<string> {
        const preview = await PreviewService.findPreview(parentProjectId, prNumber);
        if (!preview) return 'no-preview';
        // Previews own no webhook, so no token is needed for teardown.
        await ProjectTeardownService.teardown(preview, undefined);
        return 'destroyed';
    }
}
```

- [ ] **Step 2: Write the routing + lock tests**

Create `server/src/services/__tests__/preview.service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all heavy collaborators BEFORE importing the service.
const findOne = vi.fn();
const update = vi.fn();
const save = vi.fn((x) => x);
const create = vi.fn((x) => x);
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: () => ({ findOne, update, save, create }) },
}));
const provisionCore = vi.fn();
vi.mock('../projectProvisioning.service', () => ({
    ProjectProvisioningService: { provisionCore: (...a: any[]) => provisionCore(...a) },
}));
const teardown = vi.fn();
vi.mock('../projectTeardown.service', () => ({
    ProjectTeardownService: { teardown: (...a: any[]) => teardown(...a) },
}));
vi.mock('../process.service', () => ({
    ProcessService: { start: vi.fn(), redeploy: vi.fn(async () => true) },
}));
vi.mock('../github.service', () => ({
    GithubService: { cloneRepo: vi.fn(), pullLatest: vi.fn(), recordDeployment: vi.fn() },
}));
vi.mock('../notification.service', () => ({
    NotificationService: { notify: vi.fn() },
}));

import { PreviewService } from '../preview.service';
import type { PullRequestInfo } from '../preview.helpers';

const parent: any = {
    id: 'parent-1', name: 'App', subdomain: 'app', userId: 'owner-1',
    serverType: 'app', previewsEnabled: true, previewBaseDomain: 'preview.example.com',
    githubRepo: { repoUrl: 'https://github.com/acme/app', isPrivate: false, branch: 'main' },
    envVars: {}, previewEnvOverrides: {},
};
const pr: PullRequestInfo = {
    number: 5, head: { ref: 'feat/x', repo: { full_name: 'acme/app' } }, base: { repo: { full_name: 'acme/app' } },
};

beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockReset();
});

describe('PreviewService.handlePullRequest guards', () => {
    it('skips when previews are disabled', async () => {
        const r = await PreviewService.handlePullRequest({ ...parent, previewsEnabled: false }, 'opened', pr);
        expect(r).toBe('previews-disabled');
        expect(provisionCore).not.toHaveBeenCalled();
    });
    it('skips fork PRs', async () => {
        const forkPr: PullRequestInfo = { ...pr, head: { ref: 'x', repo: { full_name: 'evil/app' } } };
        const r = await PreviewService.handlePullRequest(parent, 'opened', forkPr);
        expect(r).toBe('fork-skipped');
        expect(provisionCore).not.toHaveBeenCalled();
    });
});

describe('PreviewService routing', () => {
    it('creates a new preview when none exists on opened', async () => {
        // findPreview(owner lookup) → first call is findPreview (null), then owner User lookup
        findOne.mockResolvedValueOnce(null);                 // findPreview → none
        findOne.mockResolvedValueOnce({ id: 'owner-1', githubToken: 't' }); // owner
        provisionCore.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x', });
        const r = await PreviewService.handlePullRequest(parent, 'opened', pr);
        expect(r).toBe('created');
        expect(provisionCore).toHaveBeenCalledOnce();
    });

    it('redeploys when a preview already exists on synchronize', async () => {
        findOne.mockResolvedValueOnce({ id: 'preview-1', directoryPath: '/srv/x' }); // findPreview → exists
        const r = await PreviewService.handlePullRequest(parent, 'synchronize', pr);
        expect(r).toBe('redeployed');
        expect(provisionCore).not.toHaveBeenCalled();
    });

    it('tears down on closed', async () => {
        findOne.mockResolvedValueOnce({ id: 'preview-1' }); // findPreview → exists
        const r = await PreviewService.handlePullRequest(parent, 'closed', pr);
        expect(r).toBe('destroyed');
        expect(teardown).toHaveBeenCalledOnce();
    });

    it('serializes a fast opened→synchronize burst (no double create)', async () => {
        // First call (opened): findPreview → null, owner lookup. Second (synchronize)
        // must see the created preview, so by the time it runs findPreview returns it.
        findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'owner-1', githubToken: 't' });
        provisionCore.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x' });
        findOne.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x' }); // subsequent findPreview calls

        const p1 = PreviewService.handlePullRequest(parent, 'opened', pr);
        const p2 = PreviewService.handlePullRequest(parent, 'synchronize', pr);
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe('created');
        expect(r2).toBe('redeployed');
        expect(provisionCore).toHaveBeenCalledOnce(); // never created twice
    });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test -- src/services/__tests__/preview.service.test.ts`
Expected: PASS — all routing/guard/serialization tests green. (If the serialization test is flaky because the two calls don't actually queue, the lock is wrong — `withPreviewLock` must chain on the same `key`.)

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/preview.service.ts server/src/services/__tests__/preview.service.test.ts
git commit -m "feat: PreviewService — create/redeploy/destroy with per-PR serialization"
```

---

## Task 4: Route `pull_request` events to PreviewService

The receiver currently ignores any event that isn't `push` **before** verifying the signature. Restructure so `pull_request` is verified too, then dispatched.

**Files:**
- Modify: `server/src/routes/webhooks.routes.ts`

- [ ] **Step 1: Replace the handler body**

In `server/src/routes/webhooks.routes.ts`, replace the entire `router.post('/github', ...)` handler with the version below. (It keeps the existing push logic verbatim and adds a `pull_request` branch; the only behavioral change for `push` is none.)

```ts
router.post('/github', webhookLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const signature = req.headers['x-hub-signature-256'] as string;
        if (!signature) {
            res.status(400).json({ error: 'Missing signature' });
            return;
        }

        const event = req.headers['x-github-event'] as string;
        if (event !== 'push' && event !== 'pull_request') {
            res.json({ message: 'Event ignored' });
            return;
        }

        // Use raw body bytes for signature verification (GitHub signs raw bytes)
        const rawBody = (req as any).rawBody as Buffer | undefined;
        const payload = rawBody ? rawBody.toString() : JSON.stringify(req.body);

        const repoUrl = req.body.repository?.html_url;
        if (!repoUrl) {
            res.status(400).json({ error: 'Invalid payload' });
            return;
        }

        // Resolve the PARENT (non-preview) repo. Preview rows share the repoUrl
        // but carry no webhookSecret. webhookSecret is select:false.
        const githubRepoRepo = AppDataSource.getRepository(GithubRepo);
        const githubRepo = await githubRepoRepo
            .createQueryBuilder('repo')
            .addSelect('repo.webhookSecret')
            .leftJoinAndSelect('repo.project', 'project')
            .where('repo.repoUrl = :repoUrl', { repoUrl })
            .andWhere('project.isPreview = :isPreview', { isPreview: false })
            .getOne();

        if (!githubRepo || !githubRepo.webhookSecret) {
            res.status(404).json({ error: 'Repo not found' });
            return;
        }

        const isValid = GithubService.verifyWebhookSignature(payload, signature, githubRepo.webhookSecret);
        if (!isValid) {
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        if (event === 'pull_request') {
            const action = req.body.action as string;
            const prBody = req.body.pull_request;
            if (!prBody) {
                res.json({ message: 'No pull_request in payload' });
                return;
            }
            const pr = {
                number: req.body.number ?? prBody.number,
                head: { ref: prBody.head?.ref, repo: prBody.head?.repo ? { full_name: prBody.head.repo.full_name } : null },
                base: { repo: { full_name: prBody.base?.repo?.full_name } },
            };
            const result = await PreviewService.handlePullRequest(githubRepo.project, action, pr);
            res.json({ message: `Preview: ${result}` });
            return;
        }

        // event === 'push'
        const branch = req.body.ref?.replace('refs/heads/', '');
        if (branch !== githubRepo.branch) {
            res.json({ message: `Push to ${branch} ignored, watching ${githubRepo.branch}` });
            return;
        }
        if (req.body.deleted === true) {
            res.json({ message: 'Branch deletion ignored' });
            return;
        }
        await GithubService.handlePushEvent(githubRepo.project.id, {
            sha: req.body.after,
            message: req.body.head_commit?.message,
        });
        res.json({ message: 'Deployment triggered' });
    } catch (error) {
        next(error);
    }
});
```

- [ ] **Step 2: Add the import**

At the top of `server/src/routes/webhooks.routes.ts`, add:
```ts
import { PreviewService } from '../services/preview.service';
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all test files (smoke, migrations, preview.helpers, preview.service).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/webhooks.routes.ts
git commit -m "feat: route pull_request webhook events to PreviewService"
```

---

## Task 5: Phase 2 verification

**Files:** none.

- [ ] **Step 1: Tests** — Run: `npm test` → PASS (4 test files).
- [ ] **Step 2: Type-check** — Run: `npx tsc --noEmit` → exit 0.
- [ ] **Step 3: Build** — Run: `npm run build` → exit 0.
- [ ] **Step 4: Clean tree** — Run (repo root): `git status --short` → empty.

---

## Phase 2 Done — Next

Phase 2 wires the full PR lifecycle but previews are not yet **reachable**: the Caddy config for a preview still serves under the global base domain and has no on-demand TLS. **Phase 3 (TLS/config)** threads the `baseDomain` override into the Caddy generator, emits `tls { on_demand }`, and adds the `tls-check` endpoint + Caddyfile/docs. **Phase 4** adds the Settings card, Previews tab, dashboard wiring, and the TTL sweep.

---

## Self-Review Notes

- **Spec coverage (Phase 2 slice):** PreviewService create/update/destroy ✓ (Task 3); per-PR serialization ✓ (Task 3 lock + test); `pull_request` handling + parent resolution ✓ (Task 4); fork skip ✓ (helpers + guard); env merge with injected vars ✓ (helpers + createNew); clone/redeploy/teardown wiring ✓ (Task 3); notifications ✓ (Task 3); `ensureWebhookEvents` + `pull_request` subscription ✓ (Task 2). TTL sweep, Settings/Previews UI, and `baseDomain`/TLS emission are explicitly Phase 3/4.
- **Type consistency:** `PreviewService.handlePullRequest(parent, action, pr)` used identically in Task 3 (def) and Task 4 (call); `PullRequestInfo` shape matches between `preview.helpers.ts`, the service, and the payload mapping in the receiver; `ProjectProvisioningService.provisionCore` and `ProjectTeardownService.teardown` signatures match Phase 1.
- **No placeholders:** every code step is complete; every run step has an exact command + expected result.
- **Known Phase-2-inert behavior (intended):** a preview will build and (for compose/railpack) run, but its reverse-proxy hostname won't have TLS until Phase 3 — Phase 2 is validated by unit tests + type-check, not by a live preview. `ensureWebhookEvents` is defined here but only **called** in Phase 4 (when the Settings toggle enables previews on an existing repo); that is intentional — it's a dependency Phase 4 needs in place.
- **Risk note:** the `preview.service.test.ts` relies on `vi.mock` factory hoisting; the mock vars (`findOne`, etc.) are declared with `const` before the imports they back, matching Vitest's hoisting rules. If the runner reports "cannot access before initialization", convert those to `vi.hoisted(() => ({...}))` — but as written (top-level `const` + factory closures) it works under Vitest 2.
