# Preview/PR Deployments — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the foundation for preview/PR deployments: add the preview-related columns to the `projects` table, make the GitHub webhook receiver resolve only the parent repo (so it isn't broken once multiple `GithubRepo` rows share a `repoUrl`), and extract two reusable services (`provisionProjectCore`, `ProjectTeardownService`) that Phase 2's `PreviewService` will call — while making project quota and the dashboard list exclude preview rows.

**Architecture:** A preview environment will (in later phases) be an ordinary `Project` row flagged `isPreview=true` with a `parentProjectId`. Phase 1 adds the schema and the seams. No preview is created yet; all changes are backward-compatible (new columns default to non-preview values, refactors are behavior-preserving for existing flows).

**Tech Stack:** TypeScript, Express 5, TypeORM 0.3 (PostgreSQL), Vitest + unplugin-swc (new, for tests). Migrations are registered explicitly in `server/src/config/data-source.ts` and run on boot (`migrationsRun: true`).

**Spec:** `docs/superpowers/specs/2026-06-11-preview-deployments-design.md`

**Working directory for all commands:** `/Users/araasryan/Projects/runnable/server` unless stated otherwise.

---

## File Structure (Phase 1)

- **Create** `server/vitest.config.ts` — Vitest config using the SWC plugin so TypeORM decorators/metadata work in tests.
- **Modify** `server/package.json` — add `test` script and dev dependencies.
- **Modify** `server/src/entities/Project.ts` — add preview columns + self-referential parent relation.
- **Create** `server/src/migrations/1772639000000-AddPreviewColumns.ts` — the schema change.
- **Modify** `server/src/config/data-source.ts` — register the new migration.
- **Create** `server/src/config/__tests__/migrations.test.ts` — assert the migration is registered.
- **Create** `server/src/services/projectProvisioning.service.ts` — `provisionProjectCore(...)` extracted from the route.
- **Modify** `server/src/routes/projects.routes.ts` — `provisionProject` delegates to the core; quota count excludes previews; dashboard list excludes previews; `DELETE /:id` uses the teardown service.
- **Create** `server/src/services/projectTeardown.service.ts` — `ProjectTeardownService.teardown(project, opts)` extracted from `DELETE /:id`.
- **Modify** `server/src/routes/webhooks.routes.ts` — resolve only the parent (`project.isPreview = false`) repo.

---

## Task 1: Test infrastructure (Vitest + SWC)

The server has no test runner. Vitest with `unplugin-swc` is the standard setup that supports TypeORM's `emitDecoratorMetadata` (esbuild alone does not emit decorator metadata).

**Files:**
- Modify: `server/package.json`
- Create: `server/vitest.config.ts`
- Create: `server/src/__tests__/smoke.test.ts`

- [ ] **Step 1: Install dev dependencies**

Run (in `server/`):
```bash
npm install -D vitest@^2 unplugin-swc@^1 @swc/core@^1
```
Expected: installs without error; `vitest`, `unplugin-swc`, `@swc/core` appear under `devDependencies` in `server/package.json`.

- [ ] **Step 2: Add the test script**

In `server/package.json`, add to the `"scripts"` object (keep the existing scripts):
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create the Vitest config**

Create `server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
    plugins: [
        // Compile TS with SWC so TypeORM's decorator metadata is emitted in tests.
        swc.vite({
            module: { type: 'es6' },
            jsc: {
                target: 'es2022',
                parser: { syntax: 'typescript', decorators: true },
                transform: { legacyDecorator: true, decoratorMetadata: true },
            },
        }),
    ],
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
});
```

- [ ] **Step 4: Write a smoke test**

Create `server/src/__tests__/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('test infrastructure', () => {
    it('runs', () => {
        expect(1 + 1).toBe(2);
    });
});
```

- [ ] **Step 5: Run the smoke test**

Run (in `server/`): `npm test`
Expected: PASS — 1 test passed, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/vitest.config.ts server/src/__tests__/smoke.test.ts
git commit -m "test: add vitest + swc test infrastructure to server"
```

---

## Task 2: Add preview columns to the Project entity

**Files:**
- Modify: `server/src/entities/Project.ts`

- [ ] **Step 1: Add the columns**

In `server/src/entities/Project.ts`, add these members inside the `Project` class, immediately **after** the existing `autoRestart` column (the block that ends `autoRestart: boolean;`) and **before** the `@ManyToOne(() => User, ...)` user relation:

```ts
    // ── Preview / PR deployments ──────────────────────────────────────────────

    /** Parent-project config: enable ephemeral per-PR preview environments */
    @Column({ default: false })
    previewsEnabled: boolean;

    /** Base domain previews are served under, e.g. "preview.example.com" */
    @Column({ nullable: true })
    previewBaseDomain?: string;

    /** Env vars that override inherited parent env when building a preview */
    @Column({ type: 'simple-json', nullable: true })
    previewEnvOverrides?: Record<string, string>;

    /** Tear a preview down after this many days with no new commits */
    @Column({ default: 7 })
    previewTtlDays: number;

    /** True when this row IS a preview environment (not a normal project) */
    @Column({ default: false })
    isPreview: boolean;

    /** For a preview row: the parent project it belongs to */
    @ManyToOne(() => Project, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'parentProjectId' })
    parentProject?: Project;

    @Column({ nullable: true })
    parentProjectId?: string;

    /** For a preview row: the GitHub PR number */
    @Column({ nullable: true })
    prNumber?: number;

    /** For a preview row: the PR head branch */
    @Column({ nullable: true })
    prBranch?: string;

    /** For a preview row: last deploy time, used by the TTL sweep */
    @Column({ type: 'timestamp', nullable: true })
    lastActivityAt?: Date;

    /**
     * Overrides config.hosting.baseDomain when generating this project's Caddy
     * config. Preview rows set this to the parent's previewBaseDomain; normal
     * projects leave it null.
     */
    @Column({ nullable: true })
    baseDomain?: string;
```

- [ ] **Step 2: Add `JoinColumn` to the imports**

At the top of `server/src/entities/Project.ts`, the import from `'typeorm'` already includes `ManyToOne` and `OneToOne`. Ensure `JoinColumn` is in that import list. Change:
```ts
import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToOne,
    OneToMany,
} from 'typeorm';
```
to add `JoinColumn`:
```ts
import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    OneToOne,
    OneToMany,
    JoinColumn,
} from 'typeorm';
```

- [ ] **Step 3: Type-check**

Run (in `server/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add server/src/entities/Project.ts
git commit -m "feat: add preview columns to Project entity"
```

---

## Task 3: Migration for the preview columns + registration

**Files:**
- Create: `server/src/migrations/1772639000000-AddPreviewColumns.ts`
- Modify: `server/src/config/data-source.ts`
- Create: `server/src/config/__tests__/migrations.test.ts`

- [ ] **Step 1: Write the migration**

Create `server/src/migrations/1772639000000-AddPreviewColumns.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPreviewColumns1772639000000 implements MigrationInterface {
    name = 'AddPreviewColumns1772639000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewsEnabled" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewBaseDomain" varchar NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewEnvOverrides" text NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "previewTtlDays" integer NOT NULL DEFAULT 7`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "isPreview" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "parentProjectId" uuid NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "prNumber" integer NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "prBranch" varchar NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "lastActivityAt" timestamp NULL`);
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "baseDomain" varchar NULL`);

        // Self-referential FK: deleting a parent cascades to its preview rows.
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD CONSTRAINT "FK_projects_parentProjectId"
            FOREIGN KEY ("parentProjectId") REFERENCES "projects"("id") ON DELETE CASCADE
        `);

        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_parentProjectId" ON "projects" ("parentProjectId")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_isPreview_lastActivityAt" ON "projects" ("isPreview", "lastActivityAt")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_isPreview_lastActivityAt"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_parentProjectId"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "FK_projects_parentProjectId"`);
        for (const col of ['baseDomain', 'lastActivityAt', 'prBranch', 'prNumber', 'parentProjectId', 'isPreview', 'previewTtlDays', 'previewEnvOverrides', 'previewBaseDomain', 'previewsEnabled']) {
            await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "${col}"`);
        }
    }
}
```

Note: `simple-json` columns are stored as `text` by TypeORM in Postgres, so the migration uses `text` for `previewEnvOverrides` (matches the existing `envVars`/`permissions` simple-json columns).

- [ ] **Step 2: Register the migration**

In `server/src/config/data-source.ts`, add the import after the existing `AddTokenVersion1772638000000` import:
```ts
import { AddPreviewColumns1772639000000 } from '../migrations/1772639000000-AddPreviewColumns';
```
Then append it to the `migrations` array (last element):
```ts
    migrations: [InitialSchema1709520000000, AddDomainRedirectTarget1772633000000, AddPermissions1772634000000, AddComposeSupport1772635000000, AddDeployments1772636000000, AddNotificationsAndAutoRestart1772637000000, AddTokenVersion1772638000000, AddPreviewColumns1772639000000],
```

- [ ] **Step 3: Write a test that the migration is registered**

Create `server/src/config/__tests__/migrations.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../data-source';
import { AddPreviewColumns1772639000000 } from '../../migrations/1772639000000-AddPreviewColumns';

describe('data-source migrations', () => {
    it('registers the preview-columns migration', () => {
        const migrations = AppDataSource.options.migrations as Function[];
        expect(migrations).toContain(AddPreviewColumns1772639000000);
    });
});
```

- [ ] **Step 4: Run the test**

Run (in `server/`): `npm test -- src/config/__tests__/migrations.test.ts`
Expected: PASS. (If it errors importing `data-source`, the SWC decorator config from Task 1 is missing — fix Task 1 first.)

- [ ] **Step 5: Type-check**

Run (in `server/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/migrations/1772639000000-AddPreviewColumns.ts server/src/config/data-source.ts server/src/config/__tests__/migrations.test.ts
git commit -m "feat: migration for preview columns on projects"
```

---

## Task 4: Extract `provisionProjectCore` and exclude previews from quota

`provisionProject` in `server/src/routes/projects.routes.ts` (currently lines ~58-139) bundles permission/quota checks with the actual provisioning. Phase 2's `PreviewService` needs the provisioning **without** those checks and **without** counting against `maxProjects`. Extract the core into a service.

**Files:**
- Create: `server/src/services/projectProvisioning.service.ts`
- Modify: `server/src/routes/projects.routes.ts`

- [ ] **Step 1: Create the provisioning service**

Create `server/src/services/projectProvisioning.service.ts`:
```ts
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project, ServerType, ServiceStatus, User } from '../entities';
import { AppError } from '../middleware/errorHandler';
import { SandboxService } from './sandbox.service';
import { config } from '../config';

/**
 * Core project provisioning shared by normal creation, one-click templates, and
 * (in a later phase) preview environments: subdomain validation + uniqueness,
 * container-port allocation, entity creation, and sandbox setup with rollback.
 *
 * This intentionally does NOT run user-permission, maxProjects, or server-type
 * checks — those belong to the user-facing create flow, not to system-initiated
 * provisioning (templates, previews). The caller passes the owning `User` and
 * any extra column values via `extras`.
 */
export class ProjectProvisioningService {
    static async provisionCore(
        owner: User,
        name: string,
        subdomain: string,
        serverType: ServerType,
        extras: Partial<Project> = {},
    ): Promise<Project> {
        // Validate subdomain format
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
            throw new AppError('Subdomain must be lowercase alphanumeric with hyphens', 400);
        }

        const projectRepo = AppDataSource.getRepository(Project);

        // Check uniqueness
        const existing = await projectRepo.findOne({ where: { subdomain } });
        if (existing) {
            throw new AppError('Subdomain is already taken', 409);
        }

        // Allocate the container-side port. Compose projects are excluded from the
        // watermark: their internalPort is a fixed image port (e.g. 27017) that
        // would poison allocation.
        const lastProject = await projectRepo
            .createQueryBuilder('project')
            .where('project.useCompose = :useCompose', { useCompose: false })
            .orderBy('project.internalPort', 'DESC', 'NULLS LAST')
            .getOne();
        const port = (lastProject?.internalPort || 8999) + 1;

        const directoryPath = path.join(config.hosting.servDir, subdomain);

        const project = projectRepo.create({
            name,
            subdomain,
            directoryPath,
            serverType,
            status: ServiceStatus.STOPPED,
            port,
            internalPort: port,
            userId: owner.id,
            ...extras,
        });

        // Save first to get the generated UUID
        await projectRepo.save(project);

        try {
            await SandboxService.createSandbox(project.id, directoryPath);
        } catch (error) {
            await projectRepo.remove(project);
            throw error;
        }

        return project;
    }
}
```

- [ ] **Step 2: Refactor `provisionProject` to delegate to the core**

In `server/src/routes/projects.routes.ts`, replace the entire `provisionProject` function (the block starting at the `/** Shared provisioning path ... */` comment through its closing `}` and `return project;`) with this thinner version that keeps the user-facing checks and delegates the rest:

```ts
/**
 * User-facing project creation: enforce global user permissions, the
 * maxProjects quota (previews excluded), and allowed server types, then
 * delegate to ProjectProvisioningService for the actual provisioning.
 */
async function provisionProject(
    user: User,
    name: string,
    subdomain: string,
    serverType: ServerType,
    extras: Partial<Project> = {},
): Promise<Project> {
    const userPerms = user.permissions ?? DEFAULT_USER_PERMISSIONS;
    if (!userPerms.canCreateProjects && user.role !== Role.ADMIN) {
        throw new AppError('You are not allowed to create projects', 403);
    }

    // Check maxProjects — count only the user's own NON-preview projects.
    if (userPerms.maxProjects !== null && userPerms.maxProjects !== undefined && user.role !== Role.ADMIN) {
        const projectRepo = AppDataSource.getRepository(Project);
        const count = await projectRepo.count({ where: { userId: user.id, isPreview: false } });
        if (count >= userPerms.maxProjects) {
            throw new AppError(`You have reached your maximum of ${userPerms.maxProjects} project(s)`, 403);
        }
    }

    if (userPerms.allowedServerTypes && userPerms.allowedServerTypes.length > 0 && user.role !== Role.ADMIN) {
        if (!userPerms.allowedServerTypes.includes(serverType)) {
            throw new AppError(`Server type "${serverType}" is not allowed for your account`, 403);
        }
    }

    return ProjectProvisioningService.provisionCore(user, name, subdomain, serverType, extras);
}
```

- [ ] **Step 3: Add the import**

In `server/src/routes/projects.routes.ts`, add near the other service imports (e.g. after the `ProcessService` import):
```ts
import { ProjectProvisioningService } from '../services/projectProvisioning.service';
```

- [ ] **Step 4: Type-check**

Run (in `server/`): `npx tsc --noEmit`
Expected: no output, exit code 0. The tsconfig does not set `noUnusedLocals`, so even if an import became unused it would not fail the build — no import changes are needed here (`ServiceStatus`, `SandboxService`, `config`, `path` all remain used elsewhere in the routes file).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/projectProvisioning.service.ts server/src/routes/projects.routes.ts
git commit -m "refactor: extract ProjectProvisioningService.provisionCore; exclude previews from quota"
```

---

## Task 5: Exclude previews from the dashboard project list

**Files:**
- Modify: `server/src/routes/projects.routes.ts`

- [ ] **Step 1: Filter the owned-projects query**

In `server/src/routes/projects.routes.ts`, in the `GET '/'` handler, change the owned-projects query's `where` to exclude previews:
```ts
        const ownedProjects = await projectRepo.find({
            where: { userId: req.user!.id, isPreview: false },
            relations: ['githubRepo', 'customDomains'],
            order: { createdAt: 'DESC' },
        });
```
(The collaborating-projects query needs no change: preview rows have no `ProjectCollaborator` entries, so they can never appear via collaborations.)

- [ ] **Step 2: Type-check**

Run (in `server/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/projects.routes.ts
git commit -m "feat: exclude preview rows from the project list"
```

---

## Task 6: Extract `ProjectTeardownService.teardown`

The full teardown (stop runtime, remove webhook, remove config, destroy sandbox, delete directory + logs, delete the row) currently lives inline in `DELETE /:id`. Phase 2's `PreviewService.destroy` needs the same teardown. Extract it.

**Files:**
- Create: `server/src/services/projectTeardown.service.ts`
- Modify: `server/src/routes/projects.routes.ts`

- [ ] **Step 1: Create the teardown service**

Create `server/src/services/projectTeardown.service.ts`:
```ts
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project } from '../entities';
import { ProcessService } from './process.service';
import { SandboxService } from './sandbox.service';
import { ServerConfigService } from './serverConfig.service';
import { GithubService } from './github.service';
import { config } from '../config';

/**
 * Tears down ALL runtime + persistent resources for a project and deletes its
 * row. Used by DELETE /projects/:id and (in a later phase) preview teardown.
 *
 * `removeWebhookToken` is the GitHub token to use when removing the project's
 * webhook (the acting user's token). Preview rows have no webhook, so callers
 * tearing down a preview pass undefined.
 */
export class ProjectTeardownService {
    static async teardown(project: Project, removeWebhookToken?: string): Promise<void> {
        // Stop container/compose stack and remove the built image. Unconditional
        // so leftover containers in ERROR/BUILDING states are also cleaned up.
        await ProcessService.destroy(project.id);

        // Remove the GitHub webhook so it stops firing at our API.
        if (project.githubRepo?.webhookId && removeWebhookToken) {
            await GithubService.removeWebhook(
                project.githubRepo.repoUrl,
                removeWebhookToken,
                project.githubRepo.webhookId,
            ).catch(() => { });
        }

        // Remove reverse-proxy config
        if (project.configPath) {
            await ServerConfigService.removeConfig(project.configPath);
        }

        // Destroy sandbox user
        await SandboxService.destroySandbox(project.id);

        // Remove project directory (cloned repo, build artifacts, .runnable.env)
        if (project.directoryPath) {
            await fs.rm(project.directoryPath, { recursive: true, force: true }).catch(() => { });
        }

        // Remove log files (build log + reverse-proxy access/error logs).
        const storageDir = path.resolve(config.hosting.servDir, '..');
        const logFiles = [
            path.join(storageDir, 'logs', `${project.subdomain}-build.log`),
            path.join(storageDir, 'logs', `${project.subdomain}-access.log`),
            path.join(storageDir, 'logs', `${project.subdomain}-error.log`),
            path.resolve('./storage/logs', `${project.subdomain}-build.log`),
            path.resolve('./storage/logs', `${project.subdomain}-access.log`),
            path.resolve('./storage/logs', `${project.subdomain}-error.log`),
            `/var/log/caddy/${project.subdomain}.log`,
        ];
        await Promise.all(logFiles.map(f => fs.rm(f, { force: true }).catch(() => { })));

        await AppDataSource.getRepository(Project).remove(project);
    }
}
```

- [ ] **Step 2: Use the service in the DELETE route**

In `server/src/routes/projects.routes.ts`, replace the body of the `DELETE /:id` handler's `try` block (from the `await ProcessService.destroy(project.id);` line through `await projectRepo.remove(project);`) with a single call, leaving the surrounding `try/catch` and the response line:
```ts
    try {
        const project = (req as any).project as Project;
        await ProjectTeardownService.teardown(project, req.user!.githubToken || undefined);
        res.json({ message: 'Project deleted' });
    } catch (error) {
        next(error);
    }
```

- [ ] **Step 3: Add the import**

In `server/src/routes/projects.routes.ts`, add near the other service imports:
```ts
import { ProjectTeardownService } from '../services/projectTeardown.service';
```

- [ ] **Step 4: Type-check**

Run (in `server/`): `npx tsc --noEmit`
Expected: no output, exit code 0. Note: `GithubService` was used **only** by the DELETE handler in this file, so it is now unused there — but `tsc` will not flag it (`noUnusedLocals` is off), so the build still passes. Optionally remove the now-dead `import { GithubService } ...` line from `projects.routes.ts` for tidiness; leave `ServerConfigService`, `SandboxService`, `fs`, and `config`, which other handlers in the file still use.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/projectTeardown.service.ts server/src/routes/projects.routes.ts
git commit -m "refactor: extract ProjectTeardownService.teardown from delete route"
```

---

## Task 7: Webhook receiver resolves the parent repo only

Once previews exist, multiple `GithubRepo` rows share a `repoUrl`. The receiver must select the parent (non-preview) row, whose `webhookSecret` is set. Preview rows have a null secret and would cause the existing null-secret check to 404 and drop a real event.

**Files:**
- Modify: `server/src/routes/webhooks.routes.ts`

- [ ] **Step 1: Filter the resolution query to the parent**

In `server/src/routes/webhooks.routes.ts`, find the `GithubRepo` lookup (the `createQueryBuilder('repo')` chain) and add an `.andWhere` on the joined project so only the non-preview row is selected:
```ts
        const githubRepo = await githubRepoRepo
            .createQueryBuilder('repo')
            .addSelect('repo.webhookSecret')
            .leftJoinAndSelect('repo.project', 'project')
            .where('repo.repoUrl = :repoUrl', { repoUrl })
            .andWhere('project.isPreview = :isPreview', { isPreview: false })
            .getOne();
```

- [ ] **Step 2: Type-check**

Run (in `server/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/webhooks.routes.ts
git commit -m "fix: webhook receiver resolves only the parent (non-preview) repo"
```

---

## Task 8: Phase 1 full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full server test suite**

Run (in `server/`): `npm test`
Expected: PASS — smoke test + migration-registration test, exit code 0.

- [ ] **Step 2: Server type-check**

Run (in `server/`): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Server build**

Run (in `server/`): `npm run build`
Expected: compiles to `dist/` with no errors, exit code 0.

- [ ] **Step 4: Client build (unchanged, sanity only)**

Run (in `/Users/araasryan/Projects/runnable/client`): `npm run build`
Expected: builds successfully (only the pre-existing chunk-size warning).

- [ ] **Step 5: Confirm clean tree**

Run (in repo root): `git status --short`
Expected: empty (all work committed).

---

## Phase 1 Done — Next

Phase 1 establishes the schema and seams with no behavior change to existing flows. **Phase 2 (Core lifecycle)** builds `PreviewService` on top of `ProjectProvisioningService.provisionCore` and `ProjectTeardownService.teardown`, adds `pull_request` event handling and per-PR serialization, and wires clone/redeploy/teardown + notifications. Write that plan from the spec when Phase 1 is merged.

---

## Self-Review Notes

- **Spec coverage (Phase 1 slice):** entity columns ✓ (Task 2), migration + registration ✓ (Task 3), parent-only webhook resolution ✓ (Task 7), `provisionProjectCore` extraction ✓ (Task 4), maxProjects excludes previews ✓ (Task 4), dashboard list excludes previews ✓ (Task 5), `ProjectTeardownService` extraction ✓ (Task 6). Phases 2–4 are out of this plan by design.
- **Type consistency:** service names used consistently — `ProjectProvisioningService.provisionCore` (Task 4), `ProjectTeardownService.teardown` (Task 6); migration class `AddPreviewColumns1772639000000` referenced identically in Tasks 3's migration file, data-source registration, and test.
- **No placeholders:** every code step contains full, paste-ready content; every run step states the exact command and expected result.
- **Risk note for the implementer:** Tasks 4 and 6 are behavior-preserving extractions of DB/IO-coupled code; they are verified by `tsc` + the existing app flows rather than new unit tests (mock-heavy interaction tests would be low-value here). The genuinely testable units (fork detection, subdomain derivation, env-merge, TTL selection) are pure functions introduced in Phase 2 and will be TDD'd there against the Vitest infra set up in Task 1.
