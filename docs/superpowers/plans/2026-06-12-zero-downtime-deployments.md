# Zero-Downtime Deployments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redeploys keep the old version serving until the new one is built and responding, then switch Caddy routing; a failed deploy never takes the site down.

**Architecture:** Blue-green for single containers and volume-free compose stacks (generation-suffixed names, HTTP health gate, strict Caddy reload with config rollback); in-place `up` (no `down`) for stateful compose stacks. Typed `DeployError{stillServing}` contract between `ProcessService` and the callers that own Deployment rows/notifications. Client gets socket wiring, a Deploy Activity Card, and history/settings updates.

**Spec:** `docs/superpowers/specs/2026-06-11-zero-downtime-deployments-design.md` (rev 4)

**Tech Stack:** Express + TypeORM + PostgreSQL, Docker/Compose via `SandboxService.exec`, Caddy, vitest; React + zustand + socket.io-client.

---

## File map

| File | Change |
|---|---|
| `server/src/entities/Project.ts` | add `zeroDowntime` |
| `server/src/entities/Deployment.ts` | add `strategy`, `stillServing`, `durationMs`, `healthGate`, `strategyReason` |
| `server/src/migrations/1772641000000-AddZeroDowntime.ts` | new |
| `server/src/config/data-source.ts` | register migration |
| `server/src/services/composeSafety.ts` | new — parallel-safety detector (pure) |
| `server/src/services/httpProbe.ts` | new — `probeHttp` (pure-ish) |
| `server/src/services/deployNames.ts` | new — generation naming (pure) |
| `server/src/services/deployError.ts` | new — `DeployError`, `DeployStrategy` |
| `server/src/services/serverConfig.service.ts` | strict reload option |
| `server/src/services/healthMonitor.service.ts` | `isContainerRunning` → public |
| `server/src/services/process.service.ts` | helper extraction, `doDeploy`, sweeps, redeploy routing, emits, widened stop/list |
| `server/src/services/github.service.ts` | DeployError contract, new Deployment fields |
| `server/src/services/preview.service.ts` | same for `redeployExisting` |
| `server/src/index.ts` | liveness-aware boot reconciliation |
| `server/src/routes/projects.routes.ts` | `zeroDowntime` in PUT, `GET /:id/build-log` |
| `client/src/api/projects.ts` | types + `buildLog` method |
| `client/src/hooks/useProjectSocket.ts` | new |
| `client/src/components/DeployActivityCard.tsx` | new |
| `client/src/pages/ProjectDetail.tsx` | card mount, history rows, Current pill, settings toggle |
| `client/src/index.css` | deploy-card styles, `.status-building` |

### Task 1: Schema & shared types

**Files:** Modify `server/src/entities/Project.ts`, `server/src/entities/Deployment.ts`, `server/src/config/data-source.ts`, `server/src/routes/projects.routes.ts`, `client/src/api/projects.ts`; Create `server/src/migrations/1772641000000-AddZeroDowntime.ts`; Test `server/src/config/__tests__/migrations.test.ts`.

- [ ] **1.1** Add to `Project.ts` after the `autoRestart` column:

```ts
    /** Blue-green deploys: keep the old container serving while the new one builds */
    @Column({ default: true })
    zeroDowntime: boolean;
```

- [ ] **1.2** Add to `Deployment.ts` before `createdAt` (and export the types):

```ts
export type DeployStrategyValue = 'blue-green' | 'compose-inplace' | 'recreate';
export type HealthGateValue = 'passed' | 'degraded';
```
```ts
    /** How the deploy ran. Null for rows predating zero-downtime deploys. */
    @Column({ type: 'varchar', nullable: true })
    strategy?: DeployStrategyValue;

    /** For failed rows: did the previous version keep serving? */
    @Column({ type: 'boolean', nullable: true })
    stillServing?: boolean;

    @Column({ type: 'integer', nullable: true })
    durationMs?: number;

    @Column({ type: 'varchar', nullable: true })
    healthGate?: HealthGateValue;

    /** Tier-3 fallback reason, e.g. "service db mounts named volume pgdata" */
    @Column({ type: 'text', nullable: true })
    strategyReason?: string;
```

- [ ] **1.3** Create migration `1772641000000-AddZeroDowntime.ts` (follow the `IF NOT EXISTS` house style):

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddZeroDowntime1772641000000 implements MigrationInterface {
    name = 'AddZeroDowntime1772641000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "zeroDowntime" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "strategy" character varying`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "stillServing" boolean`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "durationMs" integer`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "healthGate" character varying`);
        await queryRunner.query(`ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "strategyReason" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "strategyReason"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "healthGate"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "durationMs"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "stillServing"`);
        await queryRunner.query(`ALTER TABLE "deployments" DROP COLUMN IF EXISTS "strategy"`);
        await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "zeroDowntime"`);
    }
}
```

- [ ] **1.4** Register in `data-source.ts`: import `AddZeroDowntime1772641000000` and append to the `migrations` array. Add a test in `migrations.test.ts` mirroring the existing two (`expect(migrations).toContain(AddZeroDowntime1772641000000)`).
- [ ] **1.5** In `projects.routes.ts` PUT `/:id` (line ~169): add `zeroDowntime` to the destructured body and, with the other boolean fields: `if (zeroDowntime !== undefined) project.zeroDowntime = Boolean(zeroDowntime);`
- [ ] **1.6** In `client/src/api/projects.ts`: add `zeroDowntime?: boolean;` to `Project`; add to `Deployment`: `strategy?: 'blue-green' | 'compose-inplace' | 'recreate' | null; stillServing?: boolean | null; durationMs?: number | null; healthGate?: 'passed' | 'degraded' | null; strategyReason?: string | null;`
- [ ] **1.7** Run `npm test --workspace=server` (expect pass incl. new migration test) and `npm run build --workspace=server`. Commit: `feat: zero-downtime schema — Project.zeroDowntime + Deployment deploy-metadata columns`

### Task 2: Compose parallel-safety detector (TDD)

**Files:** Create `server/src/services/composeSafety.ts`, `server/src/services/__tests__/composeSafety.test.ts`.

Input is the **parsed output of `docker compose config`** (normalized long form), same contract as `ComposePolicyService.validate`.

- [ ] **2.1** Write failing tests covering: named volume → unsafe; external volume (long-form `{type:'volume',source:...}` whose top-level entry has `external: true`) → unsafe; **anonymous volume (no `source`) → safe**; tmpfs → safe; fixed host port (`published`) → unsafe; published `0` → safe; no `published` → safe; `container_name` → unsafe; external network → unsafe; fixed-`name:` network → unsafe; default network → safe; clean stack → `{ safeToParallel: true, reasons: [] }`; bind mount → unsafe (defense-in-depth).
- [ ] **2.2** Run `npm test --workspace=server -- composeSafety` — expect FAIL (module not found).
- [ ] **2.3** Implement:

```ts
export interface ParallelSafety {
    safeToParallel: boolean;
    reasons: string[];
}

/**
 * Decide whether a compose stack can run twice in parallel (blue-green tier 2)
 * or must be updated in place (tier 3). Input is the parsed output of
 * `docker compose config` — long-form, interpolated, anchors resolved — the
 * same normalization contract ComposePolicyService.validate relies on.
 */
export function assessParallelSafety(doc: any): ParallelSafety {
    const reasons: string[] = [];
    const services = (doc?.services && typeof doc.services === 'object') ? doc.services : {};

    for (const [name, svcRaw] of Object.entries(services)) {
        const svc = svcRaw as Record<string, any>;
        if (!svc || typeof svc !== 'object') continue;

        if (svc.container_name) {
            reasons.push(`service "${name}" sets container_name "${svc.container_name}" (container names are daemon-global)`);
        }

        for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
            const published = (p && typeof p === 'object') ? p.published
                : (typeof p === 'string' && p.includes(':')) ? p.split(':')[0] : undefined;
            if (published !== undefined && String(published) !== '0' && String(published) !== '') {
                reasons.push(`service "${name}" publishes fixed host port ${published}`);
            }
        }

        for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
            if (v && typeof v === 'object') {
                if (v.type === 'volume' && v.source) {
                    reasons.push(`service "${name}" mounts named volume "${v.source}"`);
                } else if (v.type === 'bind') {
                    reasons.push(`service "${name}" uses a bind mount (${v.source})`);
                }
                // type 'volume' without source = anonymous (per-stack) — safe; tmpfs — safe
            } else if (typeof v === 'string' && v.includes(':')) {
                // Defensive: short form shouldn't survive `compose config`
                reasons.push(`service "${name}" mounts volume "${v.split(':')[0]}"`);
            }
        }
    }

    const networks = (doc?.networks && typeof doc.networks === 'object') ? doc.networks : {};
    for (const [name, netRaw] of Object.entries(networks)) {
        const net = (netRaw ?? {}) as Record<string, any>;
        if (net.external) {
            reasons.push(`network "${name}" is external (would be shared by both stacks)`);
        } else if (net.name) {
            reasons.push(`network "${name}" has a fixed name "${net.name}" (would be shared by both stacks)`);
        }
    }

    return { safeToParallel: reasons.length === 0, reasons };
}
```

- [ ] **2.4** Run tests — expect PASS. Commit: `feat: compose parallel-safety detector for blue-green tier selection`

### Task 3: HTTP probe (TDD)

**Files:** Create `server/src/services/httpProbe.ts`, `server/src/services/__tests__/httpProbe.test.ts`.

- [ ] **3.1** Failing tests: server responding 200 → true; server responding 500 → true; closed port → false; server that accepts but never writes → false within ~timeout (use 300ms timeout in test). Use `http.createServer` on port 0.
- [ ] **3.2** Implement:

```ts
import http from 'http';

/**
 * True when ANYTHING speaking HTTP answers on 127.0.0.1:port — any status
 * code counts (a 500 is still "the app is up"). False on connection refused,
 * reset, or no response within timeoutMs.
 */
export function probeHttp(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}
```

- [ ] **3.3** Tests pass → commit: `feat: probeHttp health-gate helper`

### Task 4: Generation naming (TDD)

**Files:** Create `server/src/services/deployNames.ts`, `server/src/services/__tests__/deployNames.test.ts`.

- [ ] **4.1** Failing tests: next from unsuffixed/`null`/`-green` → `-blue`; next from `-blue` → `-green`; generations list contains legacy base + both colors; compose equivalents with `-a`/`-b`.
- [ ] **4.2** Implement:

```ts
/** Naming for blue-green generations. containerId always stores the ACTIVE full name. */

export function containerGenerations(base: string): string[] {
    return [base, `${base}-blue`, `${base}-green`];
}

export function nextContainerGeneration(base: string, active?: string | null): string {
    return active === `${base}-blue` ? `${base}-green` : `${base}-blue`;
}

export function composeGenerations(base: string): string[] {
    return [base, `${base}-a`, `${base}-b`];
}

export function nextComposeGeneration(base: string, active?: string | null): string {
    return active === `${base}-a` ? `${base}-b` : `${base}-a`;
}
```

- [ ] **4.3** Tests pass → commit: `feat: blue-green generation naming helpers`

### Task 5: DeployError, strict Caddy reload, shared liveness

**Files:** Create `server/src/services/deployError.ts`; Modify `server/src/services/serverConfig.service.ts:194-204`, `server/src/services/healthMonitor.service.ts:79`.

- [ ] **5.1** `deployError.ts`:

```ts
export type DeployStrategy = 'blue-green' | 'compose-inplace' | 'recreate';
export type HealthGateResult = 'passed' | 'degraded';

export type DeployPhase =
    | 'building' | 'starting' | 'health-check' | 'switching'
    | 'updating-services' | 'retiring' | 'done';

/**
 * Thrown by ProcessService.doDeploy. stillServing is VERIFIED at throw time
 * (same liveness check as the eligibility gate), never assumed — callers use
 * it to decide RUNNING vs ERROR.
 */
export class DeployError extends Error {
    constructor(
        message: string,
        public readonly stillServing: boolean,
        public readonly strategy: DeployStrategy,
    ) {
        super(message);
        this.name = 'DeployError';
    }
}
```

- [ ] **5.2** `serverConfig.service.ts` — make reload failure observable without changing lenient callers:

```ts
    static async reloadCaddy(options?: { strict?: boolean }): Promise<void> {
        try {
            const { execFile } = await import('child_process');
            const { promisify } = await import('util');
            const execFileAsync = promisify(execFile);
            await execFileAsync('sudo', ['-n', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
            console.log('✅ Caddy reloaded successfully');
        } catch (error: any) {
            console.error('Failed to reload Caddy:', error);
            if (options?.strict) {
                throw new Error(`Caddy reload failed: ${error?.stderr?.trim() || error?.message || 'unknown error'}`);
            }
        }
    }
```

- [ ] **5.3** `healthMonitor.service.ts:79`: change `private static async isContainerRunning` to `static async isContainerRunning` (compose-aware liveness; reused by doDeploy gate and boot reconciliation).
- [ ] **5.4** `npm run build --workspace=server` + `npm test --workspace=server` pass → commit: `feat: DeployError contract, strict Caddy reload, shared container liveness check`

### Task 6: ProcessService helper extraction (pure refactor, no behavior change)

**Files:** Modify `server/src/services/process.service.ts`.

Extract `doStart`'s APP-branch internals into private statics so `doDeploy` can run them against generation names. After this task `doStart` behaves identically (same commands, same order, same logs).

- [ ] **6.1** Add private statics (code moved verbatim from `doStart`, parameterized by name):

```ts
    private static buildLogPathFor(project: Project): string {
        const storageDir = path.resolve(config.hosting.servDir, '..');
        return path.join(storageDir, 'logs', `${project.subdomain}-build.log`);
    }

    private static async appendLog(buildLogPath: string, text: string): Promise<void> {
        await fs.appendFile(buildLogPath, text);
    }

    private static composeBaseArgs(project: Project, composeName: string): string[] {
        const composeFile = project.composeFile || 'docker-compose.yml';
        const envFilePath = path.join(project.directoryPath, '.runnable.env');
        return ['compose', '-p', composeName, '--env-file', envFilePath, '-f', composeFile];
    }
```

`validateComposeAndWriteEnv(project, userEnv, buildLogPath): Promise<any>` — moves lines 124-193 (composeService check, path confinement, `validateRawReferences`, env-file write, `docker compose config` + `ComposePolicyService.validate`); **returns the parsed config doc** (`parseYaml(configResult.stdout)`) so tier selection can reuse it without a second `config` run.

`composeUpAndWaitForPort(project, composeName, buildLogPath, extraUpArgs: string[] = []): Promise<number>` — moves lines 202-249 (`up --build -d` streaming via `SandboxService.spawn` with `...extraUpArgs` appended, then the 15-attempt port loop); throws the existing errors.

`buildAppImage(project, effectiveBuildCommand, userEnv, buildLogPath): Promise<void>` — moves lines 260-293 (BuildKit ensure, build command, railpack streaming build).

`runAppContainerAndWaitForPort(project, containerName, userEnv, buildLogPath): Promise<number>` — moves lines 298-364 (`docker run` with `-p 0:internalPort` + env + optional startCommand, then the 10-attempt state/port loop). **Does not** include the old `docker rm -f` (line 296) — callers do their own pre-clean.

- [ ] **6.2** Rewrite `doStart`'s APP branch to call them in the same order; the single-container path keeps its `docker rm -f containerName` pre-clean before `runAppContainerAndWaitForPort`; the compose path keeps `down --remove-orphans` between validate and up. Set `project.containerId`/`project.port` exactly as before.
- [ ] **6.3** `npm run build --workspace=server` + `npm test --workspace=server` pass → commit: `refactor: extract doStart build/run helpers for reuse by doDeploy`

### Task 7: Generation sweeps with adoption

**Files:** Modify `server/src/services/process.service.ts` (imports: `containerGenerations`, `composeGenerations` from `./deployNames`).

- [ ] **7.1** Add:

```ts
    /**
     * Read the port the on-disk proxy config currently routes to. Used by the
     * sweep's adoption rule. Returns null when unknown.
     */
    private static async configuredProxyPort(project: Project): Promise<number | null> {
        if (!project.configPath) return null;
        try {
            const content = await fs.readFile(project.configPath, 'utf-8');
            const m = content.match(/localhost:(\d+)/);
            return m ? parseInt(m[1], 10) : null;
        } catch {
            return null;
        }
    }

    /**
     * Remove orphaned blue/green generation containers (crashed deploys leave
     * them behind with --restart unless-stopped, so they even survive
     * reboots). A live orphan that the on-disk proxy config points at is
     * ADOPTED instead (survivor of a crash between proxy switch and DB
     * persist) — removing it would take the serving container down.
     * Returns the adopted name, if any.
     */
    private static async sweepContainerGenerations(
        project: Project,
        keep: string[],
        adopt: boolean,
    ): Promise<string | null> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        const proxyPort = adopt ? await ProcessService.configuredProxyPort(project) : null;
        let adopted: string | null = null;

        for (const name of containerGenerations(base)) {
            if (keep.includes(name)) continue;
            // Anchored filter: `name=` is an unanchored regex and would match suffixed names
            const ps = await SandboxService.exec(project.id, 'docker',
                ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}']);
            if (!ps.stdout.trim()) continue;

            if (adopt && proxyPort && ps.stdout.trim() === 'running') {
                const internalPort = project.internalPort || 8080;
                const portRes = await SandboxService.exec(project.id, 'docker', ['port', name, String(internalPort)]);
                const m = portRes.stdout.match(/:(\d+)/);
                if (m && parseInt(m[1], 10) === proxyPort) {
                    adopted = name;
                    continue;
                }
            }
            await SandboxService.exec(project.id, 'docker', ['rm', '-f', name]).catch(() => { });
        }
        return adopted;
    }

    /**
     * Tear down one compose generation. Prefers a full `down` (networks +
     * locally built images via --rmi local); falls back to label-based
     * container removal when the compose file is gone or unparseable.
     */
    private static async removeComposeGeneration(project: Project, genName: string): Promise<void> {
        const composeFile = project.composeFile || 'docker-compose.yml';
        const envFilePath = path.join(project.directoryPath, '.runnable.env');
        const envFileArgs: string[] = [];
        try {
            await fs.access(envFilePath);
            envFileArgs.push('--env-file', envFilePath);
        } catch { /* not written yet */ }

        const down = await SandboxService.exec(
            project.id, 'docker',
            ['compose', '-p', genName, ...envFileArgs, '-f', composeFile,
                'down', '--remove-orphans', '--rmi', 'local'],
            project.directoryPath,
        ).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
        if (down.exitCode === 0) return;

        const ps = await SandboxService.exec(project.id, 'docker',
            ['ps', '-aq', '--filter', `label=com.docker.compose.project=${genName}`]);
        const ids = ps.stdout.trim().split('\n').filter(Boolean);
        if (ids.length) {
            await SandboxService.exec(project.id, 'docker', ['rm', '-f', ...ids]).catch(() => { });
        }
    }

    private static async sweepComposeGenerations(project: Project, keep: string[]): Promise<void> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        for (const name of composeGenerations(base)) {
            if (keep.includes(name)) continue;
            await ProcessService.removeComposeGeneration(project, name);
        }
    }
```

- [ ] **7.2** Widen `doStop` (`process.service.ts:432-453`): after the existing containerId teardown, run `await ProcessService.sweepContainerGenerations(project, [], false)` for non-compose and `await ProcessService.sweepComposeGenerations(project, [])` for compose (both inside `if (project.containerId)` is wrong — run them **unconditionally** for APP projects: orphans exist precisely when containerId is stale). In the single-container branch keep the existing stop/rm of `project.containerId` first (graceful), then the sweep.
- [ ] **7.3** `destroy()` already calls `stop()`, which now sweeps. Keep its `rmi -f runnable-img-<id8>` as-is.
- [ ] **7.4** In `doStart`'s single-container path, replace the lone `docker rm -f containerName` pre-clean with `await ProcessService.sweepContainerGenerations(project, [], false)`; in the compose path, after the existing `down`, add `await ProcessService.sweepComposeGenerations(project, [composeName])`.
- [ ] **7.5** Widen `listContainers` (`process.service.ts:644-648`): for non-compose, filter `name=^runnable-<id8>(-blue|-green)?$`; for compose, query all three generation project names and concat (label filter per generation). Build + tests pass → commit: `feat: generation sweeps with crash-recovery adoption; widened stop/list cleanup`

### Task 8: doDeploy — tiers 1/2/3

**Files:** Modify `server/src/services/process.service.ts` (imports: `assessParallelSafety`, `probeHttp`, `nextContainerGeneration`, `nextComposeGeneration`, `DeployError`, `DeployStrategy`, `HealthGateResult`, `DeployPhase`, `HealthMonitorService`).

Constants: `const HEALTH_GATE_TIMEOUT_MS = 180_000; const HEALTH_PROBE_INTERVAL_MS = 1_000; const RETIRE_GRACE_MS = 10_000;`

- [ ] **8.1** Emit helpers + result type:

```ts
export interface DeployOutcome {
    strategy: DeployStrategy;
    healthGate: HealthGateResult;
    strategyReason?: string;
}

    static emitDeployProgress(projectId: string, phase: DeployPhase, strategy: DeployStrategy, message?: string) {
        ProcessService.io?.to(`project:${projectId}`).emit('deploy:progress',
            { projectId, phase, strategy, message, ts: Date.now() });
    }

    static emitDeployFinished(projectId: string, payload: {
        outcome: 'success' | 'failed-still-serving' | 'failed-down';
        strategy?: DeployStrategy;
        durationMs: number;
        healthGate?: HealthGateResult;
    }) {
        ProcessService.io?.to(`project:${projectId}`).emit('deploy:finished', { projectId, ...payload });
    }
```

- [ ] **8.2** Liveness + health gate:

```ts
    /** Compose-aware "is the active container/stack actually up". */
    private static async isActiveLive(project: Project): Promise<boolean> {
        try {
            return await HealthMonitorService.isContainerRunning(project);
        } catch {
            return false;
        }
    }

    /**
     * Health gate: any HTTP response on the published port. 'degraded' when
     * nothing answered within HEALTH_GATE_TIMEOUT_MS but the workload is
     * still alive — we cut over anyway ("never worse than today": the legacy
     * path never verified listening at all). Throws when the workload died.
     */
    private static async healthGate(
        project: Project,
        hostPort: number,
        stillAlive: () => Promise<boolean>,
        buildLogPath: string,
        strategy: DeployStrategy,
    ): Promise<HealthGateResult> {
        ProcessService.emitDeployProgress(project.id, 'health-check', strategy);
        const deadline = Date.now() + HEALTH_GATE_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (await probeHttp(hostPort)) {
                await ProcessService.appendLog(buildLogPath, `[Health gate] HTTP response on :${hostPort} — ready\n`);
                return 'passed';
            }
            if (!(await stillAlive())) {
                throw new Error('New container exited before responding to HTTP');
            }
            await new Promise(r => setTimeout(r, HEALTH_PROBE_INTERVAL_MS));
        }
        await ProcessService.appendLog(buildLogPath,
            `[Health gate] ⚠ No HTTP response after ${HEALTH_GATE_TIMEOUT_MS / 1000}s but the container is running — ` +
            `switching traffic anyway (degraded pass)\n`);
        return 'degraded';
    }
```

- [ ] **8.3** Proxy switch (write → strict reload → rollback file on failure; DB untouched here):

```ts
    /** Regenerate + write the proxy config for the given port. */
    private static async writeProxyConfig(project: Project, port: number): Promise<string> {
        const customDomains = (project.customDomains || [])
            .filter(d => d.verified)
            .map(d => ({ domain: d.domain, redirectTarget: d.redirectTarget || null }));
        const content = await ServerConfigService.generateConfig({
            subdomain: project.subdomain,
            directoryPath: project.directoryPath,
            port,
            serverType: project.serverType,
            customDomains,
            baseDomain: project.baseDomain || undefined,
            onDemandTls: project.isPreview === true,
        });
        return ServerConfigService.writeConfig(project.subdomain, content, project.serverType);
    }

    /**
     * Atomic-ish cutover: config file → strict reload. On reload failure the
     * file is rolled back to the old port and best-effort reloaded — the
     * on-disk config must never disagree with what Caddy serves, because any
     * other project's lifecycle op reloads globally and would activate it.
     */
    private static async switchProxy(project: Project, newPort: number, oldPort: number): Promise<void> {
        await ProcessService.writeProxyConfig(project, newPort);
        try {
            await ServerConfigService.reloadCaddy({ strict: true });
        } catch (err) {
            await ProcessService.writeProxyConfig(project, oldPort).catch(() => { });
            await ServerConfigService.reloadCaddy();
            throw err;
        }
    }
```

- [ ] **8.4** `doDeploy` orchestrator + tier bodies. Structure (full code):

```ts
    /**
     * Zero-downtime deploy: the active container/stack keeps serving while
     * the new version builds. Throws DeployError; never records Deployment
     * rows or notifications (callers own those).
     */
    static async doDeploy(projectId: string): Promise<DeployOutcome> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: ['customDomains'],
        });
        if (!project) throw new Error('Project not found');

        HealthMonitorService.reset(projectId);
        ProcessService.emitStatus(projectId, ServiceStatus.DEPLOYING);

        const buildLogPath = ProcessService.buildLogPathFor(project);
        await fs.mkdir(path.dirname(buildLogPath), { recursive: true });
        await fs.writeFile(buildLogPath, `Deploying project ${project.name} (${projectId}) — zero-downtime\n`);

        const detection = await DetectService.detect(project.directoryPath);
        const userEnv = typeof project.envVars === 'string'
            ? JSON.parse(project.envVars)
            : (project.envVars || {});
        const useCompose = project.useCompose || detection.useCompose;

        let strategy: DeployStrategy = 'blue-green';
        let strategyReason: string | undefined;
        try {
            if (!useCompose) {
                const effectiveBuildCommand = project.buildCommand || detection.buildCommand;
                const healthGate = await ProcessService.deploySingleBlueGreen(
                    project, projectRepo, effectiveBuildCommand, userEnv, buildLogPath);
                return await ProcessService.finishDeploy(project, projectRepo, { strategy, healthGate });
            }

            const doc = await ProcessService.validateComposeAndWriteEnv(project, userEnv, buildLogPath);
            const safety = assessParallelSafety(doc);
            if (safety.safeToParallel) {
                strategy = 'blue-green';
                await ProcessService.appendLog(buildLogPath, `Zero-downtime: blue-green (stack is safe to run twice)\n`);
                const healthGate = await ProcessService.deployComposeBlueGreen(project, projectRepo, buildLogPath);
                return await ProcessService.finishDeploy(project, projectRepo, { strategy, healthGate });
            }

            strategy = 'compose-inplace';
            strategyReason = safety.reasons.join('; ');
            await ProcessService.appendLog(buildLogPath, `Zero-downtime: in-place update (${strategyReason})\n`);
            await ProcessService.deployComposeInPlace(project, projectRepo, buildLogPath);
            return await ProcessService.finishDeploy(project, projectRepo,
                { strategy, healthGate: 'passed', strategyReason });
        } catch (err: any) {
            if (err instanceof DeployError) throw err;
            const stillServing = await ProcessService.isActiveLive(project);
            if (stillServing) {
                // The old version is up — reflect that for callers and clients
                await projectRepo.update(projectId, { status: ServiceStatus.RUNNING });
            }
            await ProcessService.appendLog(buildLogPath, `\n❌ Deploy failed: ${err?.message}\n` +
                (stillServing ? '✓ Previous version kept serving — visitors saw nothing.\n' : ''));
            throw new DeployError(err?.message || 'Deploy failed', stillServing, strategy);
        }
    }

    private static async finishDeploy(
        project: Project,
        projectRepo: Repository<Project>,
        outcome: DeployOutcome,
    ): Promise<DeployOutcome> {
        project.status = ServiceStatus.RUNNING;
        await projectRepo.save(project);
        ProcessService.emitDeployProgress(project.id, 'done', outcome.strategy);
        ProcessService.emitStatus(project.id, ServiceStatus.RUNNING);
        void BuildCacheService.enforceCap();
        return outcome;
    }
```

Tier 1 body:

```ts
    private static async deploySingleBlueGreen(
        project: Project,
        projectRepo: Repository<Project>,
        effectiveBuildCommand: string | undefined,
        userEnv: Record<string, string>,
        buildLogPath: string,
    ): Promise<HealthGateResult> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        const imageName = `runnable-img-${project.id.substring(0, 8)}`;
        const oldName = project.containerId!;
        const oldPort = project.port!;

        const adopted = await ProcessService.sweepContainerGenerations(project, [oldName], true);
        const active = adopted ?? oldName;
        if (adopted) {
            // Crash-recovery: the proxy already routes to this survivor
            project.containerId = adopted;
            await projectRepo.save(project);
        }
        const incoming = nextContainerGeneration(base, active);

        const oldImageId = (await SandboxService.exec(project.id, 'docker',
            ['inspect', '--format', '{{.Image}}', active])).stdout.trim();

        ProcessService.emitDeployProgress(project.id, 'building', 'blue-green');
        await ProcessService.buildAppImage(project, effectiveBuildCommand, userEnv, buildLogPath);

        let healthGate: HealthGateResult;
        try {
            ProcessService.emitDeployProgress(project.id, 'starting', 'blue-green');
            const hostPort = await ProcessService.runAppContainerAndWaitForPort(
                project, incoming, userEnv, buildLogPath);

            healthGate = await ProcessService.healthGate(
                project, hostPort,
                async () => {
                    const s = await SandboxService.exec(project.id, 'docker',
                        ['inspect', '--format', '{{.State.Status}}', incoming]);
                    return s.stdout.trim() === 'running';
                },
                buildLogPath, 'blue-green');

            ProcessService.emitDeployProgress(project.id, 'switching', 'blue-green');
            await ProcessService.switchProxy(project, hostPort, oldPort);

            // Persist AFTER the successful reload: on reload failure the DB
            // must still name the old, healthy container.
            project.containerId = incoming;
            project.port = hostPort;
            project.configPath = await ProcessService.writeProxyConfig(project, hostPort)
                .catch(() => project.configPath as any) ?? project.configPath;
            await projectRepo.save(project);
        } catch (err) {
            // Single cleanup funnel for every post-run failure path
            await SandboxService.exec(project.id, 'docker', ['rm', '-f', incoming]).catch(() => { });
            const builtId = (await SandboxService.exec(project.id, 'docker',
                ['inspect', '--format', '{{.Id}}', imageName]).catch(() => ({ stdout: '' } as any))).stdout.trim();
            if (builtId && builtId !== oldImageId) {
                await SandboxService.exec(project.id, 'docker', ['rmi', '-f', builtId]).catch(() => { });
            }
            throw err;
        }

        ProcessService.emitDeployProgress(project.id, 'retiring', 'blue-green');
        await new Promise(r => setTimeout(r, RETIRE_GRACE_MS));
        await SandboxService.exec(project.id, 'docker', ['stop', active]).catch(() => { });
        await SandboxService.exec(project.id, 'docker', ['rm', '-f', active]).catch(() => { });
        if (oldImageId) {
            const currentId = (await SandboxService.exec(project.id, 'docker',
                ['inspect', '--format', '{{.Id}}', imageName]).catch(() => ({ stdout: '' } as any))).stdout.trim();
            if (currentId && currentId !== oldImageId) {
                await SandboxService.exec(project.id, 'docker', ['rmi', '-f', oldImageId]).catch(() => { });
            }
        }
        return healthGate;
    }
```

(Note on `writeProxyConfig` in the persist block: `switchProxy` already wrote the file; the second call only captures `configPath` — it returns the same path. If that reads poorly, have `switchProxy` return the path and use it.)

Tier 2 body:

```ts
    private static async deployComposeBlueGreen(
        project: Project,
        projectRepo: Repository<Project>,
        buildLogPath: string,
    ): Promise<HealthGateResult> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        const oldName = project.containerId!;
        const oldPort = project.port!;
        const incoming = nextComposeGeneration(base, oldName);

        await ProcessService.sweepComposeGenerations(project, [oldName]);

        let healthGate: HealthGateResult;
        try {
            ProcessService.emitDeployProgress(project.id, 'building', 'blue-green');
            const hostPort = await ProcessService.composeUpAndWaitForPort(project, incoming, buildLogPath);

            healthGate = await ProcessService.healthGate(
                project, hostPort,
                async () => {
                    const ps = await SandboxService.exec(project.id, 'docker',
                        ['ps', '-q', '--filter', `label=com.docker.compose.project=${incoming}`]);
                    return ps.stdout.trim().length > 0;
                },
                buildLogPath, 'blue-green');

            ProcessService.emitDeployProgress(project.id, 'switching', 'blue-green');
            await ProcessService.switchProxy(project, hostPort, oldPort);

            project.containerId = incoming;
            project.port = hostPort;
            await projectRepo.save(project);
        } catch (err) {
            await ProcessService.removeComposeGeneration(project, incoming);
            throw err;
        }

        ProcessService.emitDeployProgress(project.id, 'retiring', 'blue-green');
        await new Promise(r => setTimeout(r, RETIRE_GRACE_MS));
        await ProcessService.removeComposeGeneration(project, oldName);
        return healthGate;
    }
```

Tier 3 body:

```ts
    private static async deployComposeInPlace(
        project: Project,
        projectRepo: Repository<Project>,
        buildLogPath: string,
    ): Promise<void> {
        const composeName = project.containerId!;
        const oldPort = project.port!;

        ProcessService.emitDeployProgress(project.id, 'updating-services', 'compose-inplace');
        // No `down`: compose diffs and recreates only changed services, so an
        // unchanged database is not touched at all.
        const hostPort = await ProcessService.composeUpAndWaitForPort(
            project, composeName, buildLogPath, ['--remove-orphans']);

        if (hostPort !== oldPort) {
            ProcessService.emitDeployProgress(project.id, 'switching', 'compose-inplace');
            await ProcessService.switchProxy(project, hostPort, oldPort);
            project.port = hostPort;
            await projectRepo.save(project);
        }
    }
```

- [ ] **8.5** Build + tests pass → commit: `feat: doDeploy — blue-green tiers 1/2 and compose in-place tier 3`

### Task 9: Route redeploys through doDeploy; result shape; finished events

**Files:** Modify `server/src/services/process.service.ts:508-538`.

- [ ] **9.1** Replace `redeploy`/`redeployExclusive` bodies:

```ts
export interface RedeployResult {
    ran: boolean;
    strategy?: DeployStrategy;
    healthGate?: HealthGateResult;
    strategyReason?: string;
    durationMs?: number;
}

    /** Zero-downtime when eligible (APP + toggle + active workload alive), else legacy recreate. */
    private static async deployOrRecreate(projectId: string): Promise<Omit<RedeployResult, 'ran'>> {
        const startedAt = Date.now();
        try {
            const projectRepo = AppDataSource.getRepository(Project);
            const project = await projectRepo.findOne({ where: { id: projectId } });
            const eligible = !!project
                && project.serverType === ServerType.APP
                && project.zeroDowntime
                && !!project.containerId
                && await ProcessService.isActiveLive(project);

            let outcome: DeployOutcome;
            if (eligible) {
                outcome = await ProcessService.doDeploy(projectId);
            } else {
                await ProcessService.doStop(projectId);
                await ProcessService.doStart(projectId);
                outcome = { strategy: 'recreate', healthGate: 'passed' };
            }
            const durationMs = Date.now() - startedAt;
            ProcessService.emitDeployFinished(projectId, {
                outcome: 'success', strategy: outcome.strategy, durationMs, healthGate: outcome.healthGate,
            });
            return { ...outcome, durationMs };
        } catch (err: any) {
            const stillServing = err instanceof DeployError && err.stillServing;
            ProcessService.emitDeployFinished(projectId, {
                outcome: stillServing ? 'failed-still-serving' : 'failed-down',
                strategy: err instanceof DeployError ? err.strategy : 'recreate',
                durationMs: Date.now() - startedAt,
            });
            throw err;
        }
    }

    static redeploy(projectId: string, prepare: () => Promise<void>): Promise<RedeployResult> {
        if (ProcessService.queuedRedeploys.has(projectId)) return Promise.resolve({ ran: false });
        ProcessService.queuedRedeploys.add(projectId);
        return ProcessService.withProjectLock(projectId, async () => {
            ProcessService.queuedRedeploys.delete(projectId);
            await prepare();
            const result = await ProcessService.deployOrRecreate(projectId);
            return { ran: true, ...result };
        });
    }

    static redeployExclusive(projectId: string, prepare: () => Promise<void>): Promise<RedeployResult> {
        return ProcessService.withProjectLock(projectId, async () => {
            await prepare();
            const result = await ProcessService.deployOrRecreate(projectId);
            return { ran: true, ...result };
        });
    }
```

(Keep the doc comments that exist on both methods today.)
- [ ] **9.2** Build + tests pass → commit: `feat: route redeploys through zero-downtime engine; deploy:finished events`

### Task 10: Callers adopt the DeployError contract

**Files:** Modify `server/src/services/github.service.ts:165-247,267-349`, `server/src/services/preview.service.ts:149-175`; extend `recordDeployment` data (`github.service.ts:249-260`).

- [ ] **10.1** `recordDeployment`: widen `data` with `strategy?: DeployStrategyValue; stillServing?: boolean; durationMs?: number; healthGate?: HealthGateValue; strategyReason?: string;` (import types from `../entities/Deployment`). Body unchanged (`create({ projectId, ...data })`).
- [ ] **10.2** `handlePushEvent`: success branch — `const result = await ProcessService.redeploy(...)`; `if (result.ran)` record with `strategy: result.strategy, durationMs: result.durationMs, healthGate: result.healthGate, strategyReason: result.strategyReason`. Catch block becomes:

```ts
        } catch (error: any) {
            const stillServing = error instanceof DeployError && error.stillServing;
            // A failed zero-downtime deploy leaves the OLD version serving —
            // status must say RUNNING, not ERROR, or the UI lies and the
            // health monitor "fixes" a healthy site.
            await projectRepo.update(projectId, {
                status: stillServing ? ServiceStatus.RUNNING : ServiceStatus.ERROR,
            });
            if (stillServing) ProcessService.emitStatus(projectId, ServiceStatus.RUNNING);
            await GithubService.recordDeployment(projectId, {
                status: 'failed',
                trigger: 'webhook',
                branch: githubRepo.branch,
                commitSha: deployed.sha,
                commitMessage: deployed.message,
                error: error?.message,
                stillServing,
                strategy: error instanceof DeployError ? error.strategy : undefined,
            }).catch(() => { });
            await NotificationService.notify(project, {
                event: 'deploy.failed',
                title: `${project.name} deploy failed`,
                message: stillServing
                    ? `${error?.message || 'Deployment failed'} — previous version kept serving, visitors saw nothing.`
                    : error?.message || 'Deployment failed',
                success: false,
                meta: { branch: githubRepo.branch, commit: deployed.sha?.slice(0, 7) },
            });
            throw error;
        }
```

Import `DeployError` from `./deployError` and `ProcessService` is already imported.
- [ ] **10.3** `rollbackToDeployment`: same transformation — destructure `redeployExclusive` result into the success `recordDeployment` (strategy/durationMs/healthGate/strategyReason), and apply the identical catch-block pattern (trigger `'rollback'`, rollback notification wording preserved, `stillServing` message suffix added).
- [ ] **10.4** `preview.service.ts` `redeployExisting`: destructure `const result = await ProcessService.redeploy(...)`; `if (result.ran)` add `strategy/durationMs/healthGate` to the success record; catch block: same `stillServing` pattern — `update(preview.id, { status: stillServing ? RUNNING : ERROR })`, record `stillServing`/`strategy`, keep the existing notification (append the same "previous version kept serving" suffix when stillServing).
- [ ] **10.5** Build + `npm test --workspace=server` (preview.service tests exist — fix signature fallout: `redeploy` now resolves an object, so any test asserting on `true/false` updates to `{ran: true/false, ...}`). Commit: `feat: deploy callers honor stillServing — failed deploys with the old version up stay RUNNING`

### Task 11: Boot reconciliation adopts live workloads

**Files:** Modify `server/src/index.ts:98-113`.

- [ ] **11.1** Replace the unconditional update:

```ts
    // Reconcile state from a previous crash. BUILDING/DEPLOYING means no
    // build is actually running anymore — but under zero-downtime deploys
    // the old (or even the new) workload may be alive and serving, so check
    // before declaring ERROR. RUNNING projects are left alone as before.
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const stuck = await projectRepo.find({
            where: { status: In([ServiceStatus.BUILDING, ServiceStatus.DEPLOYING]) },
        });
        for (const p of stuck) {
            let alive = false;
            if (p.serverType === ServerType.APP && p.containerId) {
                alive = await HealthMonitorService.isContainerRunning(p).catch(() => false);
            }
            await projectRepo.update(p.id, {
                status: alive ? ServiceStatus.RUNNING : ServiceStatus.ERROR,
            });
        }
        if (stuck.length) {
            console.warn(`⚠️  Reconciled ${stuck.length} project(s) stuck in BUILDING/DEPLOYING from a previous run`);
        }
    } catch (error) {
        console.error('Failed to reconcile project statuses:', error);
    }
```

Imports: add `ServerType` to the entities import and `HealthMonitorService` (already imported lower in the file for `.start()` — move/merge the import to the top if needed).
- [ ] **11.2** Build passes → commit: `fix: boot reconciliation keeps RUNNING when the workload survived a mid-deploy crash`

### Task 12: Build-log route + client API

**Files:** Modify `server/src/routes/projects.routes.ts`, `client/src/api/projects.ts`.

- [ ] **12.1** Add next to the existing `/:id/logs` route, using the **same permission guard that route uses** (check it — expected `requireProjectAccess(ProjectPermission.CAN_VIEW_LOGS)`):

```ts
// Build/deploy log (written by ProcessService during builds and deploys)
router.get('/:id/build-log', requireProjectAccess(ProjectPermission.CAN_VIEW_LOGS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const lines = Math.min(Number(req.query.lines) || 300, 2000);
        const storageDir = path.resolve(config.hosting.servDir, '..');
        const buildLogPath = path.join(storageDir, 'logs', `${project.subdomain}-build.log`);
        try {
            const content = await fs.readFile(buildLogPath, 'utf-8');
            res.json({ logs: content.split('\n').slice(-lines) });
        } catch {
            res.json({ logs: ['No build log yet — it appears after the first build or deploy.'] });
        }
    } catch (error) {
        next(error);
    }
});
```

(Verify `config`/`fs`/`path` imports exist in this file; add if missing.)
- [ ] **12.2** Client: `buildLog: (id: string, lines?: number) => api.get<{ logs: string[] }>(`/projects/${id}/build-log`, { params: { lines } }),`
- [ ] **12.3** Build both workspaces → commit: `feat: expose build/deploy log via API`

### Task 13: Client socket wiring

**Files:** Create `client/src/hooks/useProjectSocket.ts`; Modify `client/src/pages/ProjectDetail.tsx` (mount the hook).

API base is `'/api'` (same origin), so `io()` with `withCredentials` works in production behind Caddy. **Check `client/vite.config.ts`:** if there's a dev proxy for `/api`, add `'/socket.io': { target: <same backend>, ws: true }` so dev mode works too.

- [ ] **13.1** Hook:

```ts
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useProjectStore } from '../store/projectStore';
import type { Project } from '../api/projects';

export interface DeployProgress {
    projectId: string;
    phase: 'building' | 'starting' | 'health-check' | 'switching'
        | 'updating-services' | 'retiring' | 'done';
    strategy: 'blue-green' | 'compose-inplace' | 'recreate';
    message?: string;
    ts: number;
}

export interface DeployFinished {
    projectId: string;
    outcome: 'success' | 'failed-still-serving' | 'failed-down';
    strategy?: string;
    durationMs?: number;
    healthGate?: 'passed' | 'degraded';
}

/** Live project status + deploy events over the existing socket.io rooms. */
export function useProjectSocket(projectId: string | undefined) {
    const updateProjectStatus = useProjectStore((s) => s.updateProjectStatus);
    const [progress, setProgress] = useState<DeployProgress | null>(null);
    const [finished, setFinished] = useState<DeployFinished | null>(null);
    const startedAtRef = useRef<number | null>(null);

    useEffect(() => {
        if (!projectId) return;
        setProgress(null);
        setFinished(null);
        const socket: Socket = io({ withCredentials: true });
        socket.on('connect', () => socket.emit('subscribe', projectId));
        socket.on('service:status', (p: { projectId: string; status: Project['status'] }) => {
            if (p.projectId !== projectId) return;
            updateProjectStatus(projectId, p.status);
            if (p.status === 'deploying') {
                setFinished(null);
                if (!startedAtRef.current) startedAtRef.current = Date.now();
            }
        });
        socket.on('deploy:progress', (p: DeployProgress) => {
            if (p.projectId !== projectId) return;
            if (!startedAtRef.current) startedAtRef.current = Date.now();
            setProgress(p);
        });
        socket.on('deploy:finished', (p: DeployFinished) => {
            if (p.projectId !== projectId) return;
            setFinished(p);
            setProgress(null);
            startedAtRef.current = null;
        });
        return () => { socket.disconnect(); };
    }, [projectId, updateProjectStatus]);

    return {
        progress,
        finished,
        deployStartedAt: startedAtRef.current,
        dismissFinished: () => setFinished(null),
    };
}
```

- [ ] **13.2** In `ProjectDetail.tsx`, call `const { progress, finished, deployStartedAt, dismissFinished } = useProjectSocket(project?.id);` near the other hooks. Verify the badge now flips live (manual check comes in Task 16).
- [ ] **13.3** `npm run build --workspace=client` passes → commit: `feat: client subscribes to live project status + deploy events`

### Task 14: Deploy Activity Card

**Files:** Create `client/src/components/DeployActivityCard.tsx`; Modify `client/src/pages/ProjectDetail.tsx` (render between header and tabs), `client/src/index.css`.

- [ ] **14.1** Component:

```tsx
import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, X, ChevronDown, ChevronUp } from 'lucide-react';
import type { DeployProgress, DeployFinished } from '../hooks/useProjectSocket';
import type { Project } from '../api/projects';
import { projectsApi } from '../api/projects';
import LogConsole from './LogConsole';

const PHASES_BLUE_GREEN = [
    { key: 'building', label: 'Build' },
    { key: 'starting', label: 'Start new' },
    { key: 'health-check', label: 'Health check' },
    { key: 'switching', label: 'Switch traffic' },
    { key: 'done', label: 'Done' },
];
const PHASES_INPLACE = [
    { key: 'building', label: 'Build' },
    { key: 'updating-services', label: 'Update services' },
    { key: 'switching', label: 'Reconnect' },
    { key: 'done', label: 'Done' },
];

function useElapsed(since: number | null): string {
    const [, tick] = useState(0);
    useEffect(() => {
        if (!since) return;
        const t = setInterval(() => tick(n => n + 1), 1000);
        return () => clearInterval(t);
    }, [since]);
    if (!since) return '';
    const s = Math.floor((Date.now() - since) / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function fmtDuration(ms?: number): string {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

interface Props {
    project: Project;
    progress: DeployProgress | null;
    finished: DeployFinished | null;
    deployStartedAt: number | null;
    onDismiss: () => void;
}

export default function DeployActivityCard({ project, progress, finished, deployStartedAt, onDismiss }: Props) {
    const [showLog, setShowLog] = useState(false);
    const elapsed = useElapsed(deployStartedAt);
    const deploying = project.status === 'deploying';

    // Success auto-dismisses; failures stick until the user closes them
    useEffect(() => {
        if (finished?.outcome === 'success') {
            const t = setTimeout(onDismiss, 5000);
            return () => clearTimeout(t);
        }
    }, [finished, onDismiss]);

    if (!deploying && !finished) return null;

    const phases = progress?.strategy === 'compose-inplace' ? PHASES_INPLACE : PHASES_BLUE_GREEN;
    const activeIdx = progress ? phases.findIndex(p => p.key === progress.phase) : 0;

    const logViewer = showLog && (
        <div className="deploy-card-log">
            <LogConsole title="Build log" fetchLogs={async () => (await projectsApi.buildLog(project.id)).data.logs} />
        </div>
    );

    if (finished && !deploying) {
        const stillUp = finished.outcome === 'failed-still-serving';
        const down = finished.outcome === 'failed-down';
        return (
            <div className={`deploy-card ${down ? 'deploy-card-error' : stillUp ? 'deploy-card-warn' : 'deploy-card-ok'}`}>
                <div className="deploy-card-row">
                    {finished.outcome === 'success'
                        ? <CheckCircle2 size={16} className="deploy-ok-icon" />
                        : <XCircle size={16} className={down ? 'deploy-err-icon' : 'deploy-warn-icon'} />}
                    <span className="deploy-card-title">
                        {finished.outcome === 'success' && 'Deployed successfully'}
                        {stillUp && 'Deploy failed'}
                        {down && 'Deploy failed — service is down'}
                    </span>
                    <span className="deploy-card-meta">
                        {finished.strategy}{finished.durationMs ? ` · ${fmtDuration(finished.durationMs)}` : ''}
                    </span>
                    <button className="deploy-card-dismiss" onClick={onDismiss} title="Dismiss"><X size={14} /></button>
                </div>
                {stillUp && (
                    <div className="deploy-card-chip deploy-chip-ok">
                        ✓ Site is up — previous version kept serving; visitors saw nothing
                    </div>
                )}
                {finished.healthGate === 'degraded' && (
                    <div className="deploy-card-chip deploy-chip-warn">
                        <AlertTriangle size={13} /> Health check timed out — traffic was switched anyway
                    </div>
                )}
                <button className="deploy-card-logbtn" onClick={() => setShowLog(s => !s)}>
                    View build log {showLog ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
                {logViewer}
            </div>
        );
    }

    return (
        <div className="deploy-card">
            <div className="deploy-card-row">
                <span className="deploy-card-title">Deploying…</span>
                {elapsed && <span className="deploy-card-meta">⏱ {elapsed}</span>}
            </div>
            <div className="deploy-stepper">
                {phases.map((p, i) => (
                    <div key={p.key}
                        className={`deploy-step ${i < activeIdx ? 'done' : i === activeIdx ? 'active' : ''}`}>
                        <span className="deploy-step-dot" />
                        <span className="deploy-step-label">{p.label}</span>
                    </div>
                ))}
            </div>
            <div className="deploy-card-chip deploy-chip-ok">
                ✓ Site is up — previous version is serving traffic
            </div>
            <div className="deploy-card-row deploy-card-footer">
                {progress && <span className="deploy-card-meta">Strategy: {progress.strategy}</span>}
                <button className="deploy-card-logbtn" onClick={() => setShowLog(s => !s)}>
                    View build log {showLog ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
            </div>
            {logViewer}
        </div>
    );
}
```

Caveat the implementer must handle: the "site is up" chip is only true when an old version exists. Suppress it when `progress?.strategy === 'recreate'` or when the project had no prior running version — simplest signal: hide the chip when `finished?.strategy === 'recreate'` (terminal) and when `progress?.strategy === 'recreate'` (live).
- [ ] **14.2** Render in `ProjectDetail.tsx` between the header block and the tab bar: `<DeployActivityCard project={project} progress={progress} finished={finished} deployStartedAt={deployStartedAt} onDismiss={dismissFinished} />`
- [ ] **14.3** CSS in `index.css` (match existing card/glass idiom — reuse the page's card background/border variables; amber `#eab308`-family for warn, the existing `--status-error` red for error). Provide: `.deploy-card{border:1px solid;border-radius:…;padding:…;margin:…}` variants `-ok/-warn/-error`, `.deploy-stepper` flex row with connecting lines, `.deploy-step-dot` filled/active/pending states, `.deploy-card-chip` pill (green/amber), small log button. Also add the missing `.status-building` rule mirroring `.status-deploying`.
- [ ] **14.4** `npm run build --workspace=client` passes → commit: `feat: Deploy Activity Card — live deploy progress with still-serving reassurance`

### Task 15: History rows + settings toggle

**Files:** Modify `client/src/pages/ProjectDetail.tsx` (Deployments tab ~626-692; settings card ~1016-1090).

- [ ] **15.1** "Current" pill fix: compute `const currentDeployId = deployments.find(d => d.status === 'success')?.id;` and replace the `index === 0 && d.status === 'success'` condition with `d.id === currentDeployId`.
- [ ] **15.2** Row meta: append strategy + duration when present (`{d.strategy && <span title={d.strategyReason || undefined}>· {d.strategy}</span>} {d.durationMs && <span>· {fmtDuration(d.durationMs)}</span>}`); add pills: `d.healthGate === 'degraded'` → amber "health check timed out"; failed rows → `d.stillServing === true` ? amber "Previous version kept" : `d.stillServing === false` ? red "Service down" : nothing (legacy rows).
- [ ] **15.3** Settings toggle, modeled exactly on the Auto-restart block (checkbox + muted sentence, no alarm styling):

```tsx
<label className="checkbox-row">
    <input type="checkbox" checked={form.zeroDowntime ?? true}
        onChange={e => setForm({ ...form, zeroDowntime: e.target.checked })} />
    <div>
        <div>Zero-downtime deploys</div>
        <div className="muted">
            Keep the current version live while the new one builds; traffic switches only
            after the new version responds.
        </div>
        {form.useCompose && (
            <div className="muted small">
                Stacks with named volumes, fixed ports, or container_name update in place —
                only changed services restart. During the brief switchover both versions run,
                so background workers may process jobs twice.
            </div>
        )}
        <div className="muted small">
            Long-lived connections (websockets) reconnect within ~20s of the switch.
        </div>
    </div>
</label>
```

Adapt class names to whatever the Auto-restart block actually uses (copy its exact structure); include `zeroDowntime` in the settings save payload.
- [ ] **15.4** Client build passes → commit: `feat: deploy history metadata + zero-downtime settings toggle`

### Task 16: Verification

- [ ] **16.1** `npm test --workspace=server` — all pass. `npm run build --workspace=server && npm run build --workspace=client` — clean.
- [ ] **16.2** Self-review the diff against the spec (every spec section → implemented or explicitly deferred).
- [ ] **16.3** Manual Chrome verification (`superpowers:verify` / claude-in-chrome): open a project page, trigger a redeploy, observe: badge flips to amber live, Deploy Activity Card appears with stepper + still-up chip, build log expander streams, card resolves to success and auto-dismisses, history row shows strategy + duration. Then break the build (or simulate) and confirm the sticky failed-still-serving card and history pill.
- [ ] **16.4** Commit any fixes; final commit.

## Out of scope (per spec)

Per-service blue-green inside stateful stacks; configurable health paths/timeouts; canary; websocket-graceful switchover; `deploy-strategy` dry-run endpoint; `.status-building` beyond the basic rule.
