# Preview/PR Deployments — Phase 4 (UI + TTL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish the feature: let owners enable PR previews per project (Settings card), see and destroy live previews (Previews tab), and automatically reap previews idle past their TTL.

**Architecture:** The lifecycle (Phase 2) and HTTPS reachability (Phase 3) exist; this phase adds the enable/write path and visibility. Enabling previews persists `previewsEnabled`/`previewBaseDomain`/`previewEnvOverrides`/`previewTtlDays` and upgrades an existing push-only webhook to also receive `pull_request` (`ensureWebhookEvents`). Previews are addressed through their parent (`GET /:id/previews`, `POST /:id/previews/:previewId/destroy`) since they have no collaborator rows. The TTL reaper runs alongside the health-monitor interval, out-of-band.

**Tech Stack:** TypeScript, Express 5, TypeORM 0.3, React + Zustand, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-11-preview-deployments-design.md`
**Builds on:** Phases 1–3 on branch `feat/preview-deployments`.

> **Concurrency note:** another session is committing build-cache/system work on this branch. Phase 4 touches `projects.routes.ts`, `preview.service.ts`, `preview.helpers.ts`, `healthMonitor.service.ts`, `client/src/api/projects.ts`, `client/src/pages/ProjectDetail.tsx`. Implementers must **read each file fresh before editing** and locate code by the anchors named here (not line numbers), since lines shift. Do not touch `system.routes.ts`, `buildCache.service.ts`, `appSettings.service.ts`, or the `.claire/` dir.

**Working directory:** `/Users/araasryan/Projects/runnable/server` for server tasks, `/Users/araasryan/Projects/runnable/client` for client tasks.

---

## File Structure (Phase 4)

- **Modify** `server/src/services/preview.helpers.ts` (+ test) — add `isPreviewExpired`.
- **Modify** `server/src/services/preview.service.ts` — add `listForParent`, `destroyPreview`, `reapExpired`.
- **Modify** `server/src/services/healthMonitor.service.ts` — call `reapExpired` from the interval.
- **Modify** `server/src/routes/projects.routes.ts` — preview fields on `PUT /:id` (+ `ensureWebhookEvents`); `GET /:id/previews`; `POST /:id/previews/:previewId/destroy`.
- **Modify** `client/src/api/projects.ts` — `Project` preview fields; `listPreviews`/`destroyPreview`.
- **Modify** `client/src/pages/ProjectDetail.tsx` — "PR Previews" settings card; Previews tab.

---

## Task 1: TTL expiry helper (TDD)

**Files:**
- Modify: `server/src/services/preview.helpers.ts`
- Modify: `server/src/services/__tests__/preview.helpers.test.ts`

- [ ] **Step 1: Add failing tests**

In `server/src/services/__tests__/preview.helpers.test.ts`, add `isPreviewExpired` to the import from `../preview.helpers`, and append this describe block at the end of the file:
```ts
describe('isPreviewExpired', () => {
    const now = Date.parse('2026-06-11T00:00:00Z');
    it('is false when there is no last activity', () => {
        expect(isPreviewExpired(null, 7, now)).toBe(false);
        expect(isPreviewExpired(undefined, 7, now)).toBe(false);
    });
    it('is false when within the TTL window', () => {
        const sixDaysAgo = new Date(now - 6 * 24 * 3600 * 1000);
        expect(isPreviewExpired(sixDaysAgo, 7, now)).toBe(false);
    });
    it('is true when older than the TTL window', () => {
        const eightDaysAgo = new Date(now - 8 * 24 * 3600 * 1000);
        expect(isPreviewExpired(eightDaysAgo, 7, now)).toBe(true);
    });
});
```

- [ ] **Step 2: Run → fail**

Run: `npm test -- src/services/__tests__/preview.helpers.test.ts`
Expected: FAIL — `isPreviewExpired` is not exported.

- [ ] **Step 3: Implement**

In `server/src/services/preview.helpers.ts`, add at the end:
```ts
/** True when a preview has been idle longer than its TTL (in days). */
export function isPreviewExpired(
    lastActivityAt: Date | string | null | undefined,
    ttlDays: number,
    nowMs: number,
): boolean {
    if (!lastActivityAt) return false;
    const ageMs = nowMs - new Date(lastActivityAt).getTime();
    return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}
```

- [ ] **Step 4: Run → pass**

Run: `npm test -- src/services/__tests__/preview.helpers.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → exit 0.
```bash
git add server/src/services/preview.helpers.ts server/src/services/__tests__/preview.helpers.test.ts
git commit -m "feat: isPreviewExpired TTL helper"
```

---

## Task 2: PreviewService — list, manual destroy, TTL reap

**Files:**
- Modify: `server/src/services/preview.service.ts`

- [ ] **Step 1: Add the import**

In `server/src/services/preview.service.ts`, add `isPreviewExpired` to the existing import from `./preview.helpers` (it already imports `isForkPR, derivePreviewSubdomain, mergePreviewEnv, previewHostname, type PullRequestInfo`). The line becomes:
```ts
import { isForkPR, derivePreviewSubdomain, mergePreviewEnv, previewHostname, isPreviewExpired, type PullRequestInfo } from './preview.helpers';
```

- [ ] **Step 2: Add three methods**

In `server/src/services/preview.service.ts`, add these methods to the `PreviewService` class (e.g. right before the closing `}` of the class, after `destroyForPr`):
```ts
    /** List a parent's preview environments, newest first. */
    static async listForParent(parentProjectId: string): Promise<Project[]> {
        return AppDataSource.getRepository(Project).find({
            where: { parentProjectId, isPreview: true },
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Manually destroy one preview (from the Previews tab). Verifies it belongs
     * to the parent, then tears it down under the per-PR lock so it can't race
     * a concurrent webhook event for the same PR. Returns false if not found.
     */
    static async destroyPreview(parentProjectId: string, previewId: string): Promise<boolean> {
        const preview = await AppDataSource.getRepository(Project).findOne({
            where: { id: previewId, parentProjectId, isPreview: true },
            relations: ['githubRepo'],
        });
        if (!preview) return false;
        const key = `${parentProjectId}:${preview.prNumber}`;
        await PreviewService.withPreviewLock(key, () => ProjectTeardownService.teardown(preview, undefined));
        return true;
    }

    /**
     * Tear down previews idle longer than their parent's previewTtlDays.
     * Fire-and-forget per preview (serialized per PR) so a batch never stalls
     * the caller (the health-monitor interval).
     */
    static async reapExpired(nowMs: number): Promise<void> {
        const previews = await AppDataSource.getRepository(Project).find({
            where: { isPreview: true },
            relations: ['parentProject', 'githubRepo'],
        });
        for (const preview of previews) {
            const ttl = preview.parentProject?.previewTtlDays ?? 7;
            if (isPreviewExpired(preview.lastActivityAt, ttl, nowMs)) {
                const key = `${preview.parentProjectId}:${preview.prNumber}`;
                PreviewService.withPreviewLock(key, () => ProjectTeardownService.teardown(preview, undefined))
                    .catch((err) => console.error(`Failed to reap preview ${preview.id}:`, err));
            }
        }
    }
```

- [ ] **Step 3: Type-check + tests + commit**

Run: `npx tsc --noEmit` → exit 0. Run: `npm test` → all pass.
```bash
git add server/src/services/preview.service.ts
git commit -m "feat: PreviewService list/destroy/reap for previews"
```

---

## Task 3: Wire the TTL reaper into the health monitor

**Files:**
- Modify: `server/src/services/healthMonitor.service.ts`

- [ ] **Step 1: Import PreviewService**

In `server/src/services/healthMonitor.service.ts`, add near the other service imports:
```ts
import { PreviewService } from './preview.service';
```

- [ ] **Step 2: Call reapExpired from the interval**

Find the `start()` method's `setInterval(...)` callback (it currently calls `HealthMonitorService.checkAll()`). Add a not-awaited reap call alongside it so the callback body runs both:
```ts
        HealthMonitorService.timer = setInterval(() => {
            HealthMonitorService.checkAll().catch(err =>
                console.error('Health monitor sweep failed:', err)
            );
            PreviewService.reapExpired(Date.now()).catch(err =>
                console.error('Preview TTL reap failed:', err)
            );
        }, CHECK_INTERVAL_MS);
```
(If the existing callback differs, preserve the existing `checkAll` call exactly and just add the `PreviewService.reapExpired(Date.now()).catch(...)` line next to it.)

- [ ] **Step 3: Type-check + commit**

Run: `npx tsc --noEmit` → exit 0. (Watch for an import cycle error — there is none: PreviewService does not import healthMonitor.)
```bash
git add server/src/services/healthMonitor.service.ts
git commit -m "feat: reap expired previews on the health-monitor interval"
```

---

## Task 4: Routes — enable previews + list + destroy

**Files:**
- Modify: `server/src/routes/projects.routes.ts`

- [ ] **Step 1: Re-add the GithubService import**

In `server/src/routes/projects.routes.ts`, ensure `GithubService` is imported (it was removed in Phase 1 as dead; it is needed again). Add near the other service imports if absent:
```ts
import { GithubService } from '../services/github.service';
```
Also ensure `PreviewService` is imported:
```ts
import { PreviewService } from '../services/preview.service';
```

- [ ] **Step 2: Accept preview fields in `PUT /:id`**

In the `PUT '/:id'` handler, find the destructuring of `req.body` (currently ends with `..., notificationWebhookUrl, autoRestart } = req.body;`). Add the four preview fields:
```ts
        const { name, serverType, buildCommand, startCommand, envVars, port, internalPort,
                useCompose, composeFile, composeService, notificationWebhookUrl, autoRestart,
                previewsEnabled, previewBaseDomain, previewEnvOverrides, previewTtlDays } = req.body;
```
Then, immediately AFTER the `if (autoRestart !== undefined) project.autoRestart = Boolean(autoRestart);` line and BEFORE the `const projectRepo = AppDataSource.getRepository(Project);` + `save`, add:
```ts
        if (previewBaseDomain !== undefined) {
            if (previewBaseDomain === null || previewBaseDomain === '') {
                project.previewBaseDomain = null as any;
            } else {
                const d = String(previewBaseDomain).trim().toLowerCase();
                if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d)) {
                    throw new AppError('previewBaseDomain must be a valid domain', 400);
                }
                project.previewBaseDomain = d;
            }
        }
        if (previewTtlDays !== undefined) {
            const n = Number(previewTtlDays);
            if (!Number.isInteger(n) || n < 1 || n > 365) {
                throw new AppError('previewTtlDays must be an integer between 1 and 365', 400);
            }
            project.previewTtlDays = n;
        }
        if (previewEnvOverrides !== undefined) {
            if (previewEnvOverrides === null) {
                project.previewEnvOverrides = null as any;
            } else {
                if (typeof previewEnvOverrides !== 'object' || Array.isArray(previewEnvOverrides)) {
                    throw new AppError('previewEnvOverrides must be an object of string values', 400);
                }
                const clean: Record<string, string> = {};
                for (const [key, value] of Object.entries(previewEnvOverrides)) {
                    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
                        throw new AppError(`previewEnvOverrides.${key} must be a string`, 400);
                    }
                    clean[key] = String(value);
                }
                project.previewEnvOverrides = clean;
            }
        }
        if (previewsEnabled !== undefined) project.previewsEnabled = Boolean(previewsEnabled);

        // Enabling previews requires a base domain to serve them under.
        if (project.previewsEnabled && !project.previewBaseDomain) {
            throw new AppError('A preview base domain is required to enable PR previews', 400);
        }
```
Then, immediately AFTER the existing `await projectRepo.save(project);` line (and before `res.json(project);`), add:
```ts
        // If previews are enabled and the repo's webhook predates preview
        // support (push only), upgrade it to also receive pull_request events.
        if (project.previewsEnabled && project.githubRepo?.webhookId && req.user!.githubToken) {
            await GithubService.ensureWebhookEvents(
                project.githubRepo.repoUrl,
                req.user!.githubToken,
                project.githubRepo.webhookId,
                ['push', 'pull_request'],
            ).catch(() => { /* best-effort; previews still work on the next reconnect */ });
        }
```

- [ ] **Step 3: Add the previews list + destroy routes**

In `server/src/routes/projects.routes.ts`, add these two routes. Place them after the `DELETE '/:id'` handler (or anywhere among the `/:id/...` routes, but NOT before `GET '/:id'`). Note `ProjectPermission` is already imported.
```ts
// List preview environments for a project
router.get('/:id/previews', requireProjectAccess(ProjectPermission.CAN_VIEW_GITHUB), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const previews = await PreviewService.listForParent(project.id);
        res.json(previews);
    } catch (error) {
        next(error);
    }
});

// Manually destroy a preview environment
router.post('/:id/previews/:previewId/destroy', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const destroyed = await PreviewService.destroyPreview(project.id, req.params.previewId as string);
        if (!destroyed) throw new AppError('Preview not found', 404);
        res.json({ message: 'Preview destroyed' });
    } catch (error) {
        next(error);
    }
});
```

- [ ] **Step 4: Type-check + commit**

Run (server/): `npx tsc --noEmit` → exit 0.
```bash
git add server/src/routes/projects.routes.ts
git commit -m "feat: enable-previews write path + previews list/destroy routes"
```

---

## Task 5: Client API — preview fields + endpoints

**Files:**
- Modify: `client/src/api/projects.ts`

- [ ] **Step 1: Add preview fields to the `Project` interface**

In `client/src/api/projects.ts`, in the `Project` interface, after the `autoRestart?: boolean;` line, add:
```ts
    previewsEnabled?: boolean;
    previewBaseDomain?: string | null;
    previewEnvOverrides?: Record<string, string> | null;
    previewTtlDays?: number;
    isPreview?: boolean;
    parentProjectId?: string;
    prNumber?: number;
    prBranch?: string;
    baseDomain?: string | null;
```

- [ ] **Step 2: Add the two endpoints**

In the `projectsApi` object, near the other GitHub/deployment methods, add:
```ts
    listPreviews: (id: string) => api.get<Project[]>(`/projects/${id}/previews`),
    destroyPreview: (id: string, previewId: string) =>
        api.post(`/projects/${id}/previews/${previewId}/destroy`),
```

- [ ] **Step 3: Type-check (client) + commit**

Run (client/): `npx tsc -b --noEmit` → exit 0.
```bash
git add client/src/api/projects.ts
git commit -m "feat: client API for preview fields + list/destroy"
```

---

## Task 6: Client — "PR Previews" settings card

**Files:**
- Modify: `client/src/pages/ProjectDetail.tsx`

READ the file first. The Settings tab is rendered under `{tab === 'settings' && ...}`; it already has cards (e.g. a "Notifications & Health" card with inline styles) and a `handleSaveSettings` that builds an `update(...)` payload from local state. Follow those existing patterns exactly.

- [ ] **Step 1: Add local state**

Near the other settings state (e.g. where `notificationWebhookUrl`/`autoRestart` state is declared), add:
```ts
    const [previewsEnabled, setPreviewsEnabled] = useState(false);
    const [previewBaseDomain, setPreviewBaseDomain] = useState('');
    const [previewTtlDays, setPreviewTtlDays] = useState('7');
    const [previewEnvOverridesText, setPreviewEnvOverridesText] = useState('');
```

- [ ] **Step 2: Initialize from the loaded project**

In the effect/`.then` that seeds settings state from the fetched project (where `setNotificationWebhookUrl(p.notificationWebhookUrl || '')` etc. are set), add:
```ts
                    setPreviewsEnabled(p.previewsEnabled || false);
                    setPreviewBaseDomain(p.previewBaseDomain || '');
                    setPreviewTtlDays(p.previewTtlDays != null ? String(p.previewTtlDays) : '7');
                    setPreviewEnvOverridesText(
                        Object.entries(p.previewEnvOverrides || {}).map(([k, v]) => `${k}=${v}`).join('\n')
                    );
```

- [ ] **Step 3: Include preview fields in the save payload**

In `handleSaveSettings`, where the `projectsApi.update(id, { ... })` payload is built, add these keys (parse the overrides text into an object the same way the env-vars editor does — split lines on the first `=`):
```ts
                previewsEnabled,
                previewBaseDomain: previewBaseDomain.trim() || null,
                previewTtlDays: Number(previewTtlDays) || 7,
                previewEnvOverrides: previewEnvOverridesText
                    .split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !l.startsWith('#') && l.includes('='))
                    .reduce((acc, line) => {
                        const eq = line.indexOf('=');
                        acc[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                        return acc;
                    }, {} as Record<string, string>),
```

- [ ] **Step 4: Render the card**

In the Settings tab JSX, after the "Notifications & Health" card (and only when the project has a connected GitHub repo and is an app — `p.githubRepo && p.serverType === 'app'`), add a "PR Previews" card matching the existing card styling (the bordered `div` with inline styles used by the compose/notifications cards). It must contain: an enable checkbox bound to `previewsEnabled`/`setPreviewsEnabled` (disabled when `!canEditConfig`); a text input for the base domain (`previewBaseDomain`, placeholder `preview.example.com`); a number input for TTL days (`previewTtlDays`, min 1 max 365); a textarea for `previewEnvOverridesText` (one `KEY=value` per line); and this exact warning line:
```tsx
<p style={{ fontSize: 12, color: 'var(--status-error)', marginTop: 4 }}>
    Production env vars are inherited by previews unless overridden here. Scrub or replace any secrets you don't want in ephemeral PR environments.
</p>
```
Wrap the card so it is only shown for `p.githubRepo && p.serverType === 'app'`. Use the same label/input classNames the other settings inputs use (`form-group`, `form-input`).

- [ ] **Step 5: Build (client) + commit**

Run (client/): `npm run build` → succeeds.
```bash
git add client/src/pages/ProjectDetail.tsx
git commit -m "feat: PR Previews settings card"
```

---

## Task 7: Client — Previews tab

**Files:**
- Modify: `client/src/pages/ProjectDetail.tsx`

READ the file. Model this on the existing **Deployments** tab (the `'deployments'` tab in the `tab` union, `availableTabs.push('deployments')`, the `loadDeployments()` loader called from the `useEffect` keyed on `tab`, and the `{tab === 'deployments' && (...)}` render block).

- [ ] **Step 1: Add `'previews'` to the tab union**

In the `useState<'overview' | 'files' | 'github' | 'deployments' | ...>` declaration, add `'previews'` to the union.

- [ ] **Step 2: Add state + loader**

Near the deployments state, add:
```ts
    const [previews, setPreviews] = useState<Project[]>([]);
    const [previewsLoading, setPreviewsLoading] = useState(false);
```
Add a loader alongside `loadDeployments`:
```ts
    const loadPreviews = async () => {
        if (!id) return;
        setPreviewsLoading(true);
        try {
            const { data } = await projectsApi.listPreviews(id);
            setPreviews(data);
        } catch { /* surfaced as empty */ }
        setPreviewsLoading(false);
    };
```
In the `useEffect` that calls `loadDeployments()` when `tab === 'deployments'`, add a sibling:
```ts
        if (id && tab === 'previews') loadPreviews();
```

- [ ] **Step 3: Add the tab to availableTabs**

After the `if (canViewGithub && p?.githubRepo) availableTabs.push('deployments');` line, add:
```ts
    if (canViewGithub && p?.githubRepo && p?.previewsEnabled) availableTabs.push('previews');
```

- [ ] **Step 4: Add a destroy handler**

Near `handleRollback`/other handlers, add:
```ts
    const handleDestroyPreview = async (previewId: string) => {
        if (!id || !confirm('Destroy this preview environment?')) return;
        try {
            await projectsApi.destroyPreview(id, previewId);
            loadPreviews();
        } catch (err: any) {
            alert(err.response?.data?.error || 'Failed to destroy preview');
        }
    };
```

- [ ] **Step 5: Render the tab**

After the `{tab === 'deployments' && (...)}` block, add a `{tab === 'previews' && (...)}` block that mirrors the deployments-list styling. For each preview render: `PR #{p.prNumber}`, the branch (`p.prBranch`), a `<StatusBadge status={p.status} />`, the preview URL as a link (`https://{p.subdomain}.{p.baseDomain}` when `p.baseDomain` is set), the `Last activity` (`p.lastActivityAt`), and a **Destroy** button calling `handleDestroyPreview(p.id)` (shown only when `canStart`). When `previewsLoading` show the spinner; when empty show an empty-state ("No active previews. Open a pull request to create one.").

- [ ] **Step 6: Build (client) + commit**

Run (client/): `npm run build` → succeeds.
```bash
git add client/src/pages/ProjectDetail.tsx
git commit -m "feat: Previews tab — list + destroy preview environments"
```

---

## Task 8: Phase 4 verification + push

**Files:** none (verification + integration).

- [ ] **Step 1: Server tests + type-check + build** — Run (server/): `npm test` → PASS; `npx tsc --noEmit` → 0; `npm run build` → 0.
- [ ] **Step 2: Client build** — Run (client/): `npm run build` → succeeds.
- [ ] **Step 3: Script syntax** — Run (repo root): `bash -n setup.sh` → 0.
- [ ] **Step 4: Integrate concurrent commits** — Run (repo root): `git pull --ff-only origin feat/preview-deployments` if the remote branch exists and has the other session's commits; resolve fast-forward. (If the branch isn't pushed yet, skip.) Then re-run Step 1–2 builds to confirm the merged tree is green.
- [ ] **Step 5: Push** — Run (repo root): `git push -u origin feat/preview-deployments`.

---

## Phase 4 Done — Feature Complete

With Phase 4, an owner can enable PR previews on a GitHub-connected app project, each PR gets an ephemeral HTTPS environment that redeploys on push and is torn down on close (or after the TTL), and the Previews tab lists and can destroy them. The four phases together deliver the full preview/PR-deployments feature from the spec.

---

## Self-Review Notes

- **Spec coverage (Phase 4 slice):** enable/configure write path + `ensureWebhookEvents` ✓ (Task 4); `CAN_EDIT_CONFIG`-gated (PUT already requires it); previews addressed via parent with `CAN_VIEW_GITHUB`/`CAN_START` ✓ (Task 4); Settings card with secret-inheritance warning ✓ (Task 6); Previews tab + destroy ✓ (Task 7); TTL reaper out-of-band on the monitor interval ✓ (Tasks 1–3); dashboard already excludes previews (Phase 1). 
- **Type consistency:** `PreviewService.listForParent` / `destroyPreview` / `reapExpired` defined (Task 2) and used (Tasks 3–4); `isPreviewExpired` defined (Task 1) and used (Task 2); client `listPreviews`/`destroyPreview` defined (Task 5) and used (Tasks 6–7).
- **Concurrency:** all edits are additive and anchored to landmarks; no Phase-4 file overlaps the other session's build-cache/system files. Task 8 integrates before pushing.
- **Security:** the enable path is gated by `CAN_EDIT_CONFIG`; destroy by `CAN_START`; the manual destroy verifies `parentProjectId` ownership and runs under the per-PR lock; the secret-inheritance warning is surfaced in the card.
- **Risk note:** `ensureWebhookEvents` is best-effort (`.catch`) so a transient GitHub error doesn't fail the settings save; previews still upgrade on the next reconnect.
