# Build-Cache GC Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-configurable build-cache size cap, set from the Runnable UI and enforced by app-driven prunes after every deploy — no Docker daemon restarts.

**Architecture:** A `buildCacheKeepGB` setting on the existing `AppSettings` singleton row. A new `BuildCacheService` prunes the Docker daemon's builder cache (`docker builder prune`) and the dedicated `runnable-buildkit` container's cache (`buildctl prune`) down to the cap, fired after every deploy in `process.service.ts`. Three admin-only endpoints on the existing `/api/system` router; a System card on the Admin page.

**Tech Stack:** Express + TypeORM (Postgres) + vitest on the server; React + axios client. Spec: `docs/superpowers/specs/2026-06-11-build-cache-gc-cap-design.md`.

**Conventions used below:**
- All server commands run from `server/`: tests `npm test`, typecheck `npm run build`.
- All client commands run from `client/`: typecheck+build `npm run build`.
- Docker/buildctl sizes are SI-decimal (`kB`=1e3, `MB`=1e6, `GB`=1e9) — that is what `docker system df` and `buildctl du` print.
- Flag reality (verified on production, Docker 29.4.3 + buildkit v0.29.0): `docker builder prune` takes `--max-used-space` (modern) with `--keep-storage` as the older variant — the service tries modern first and falls back on unknown-flag errors. `buildctl prune` takes `--keep-storage` (MB integer) on all versions; it never had `--max-used-space`.

---

### Task 1: Pure helpers (`buildCache.helpers.ts`) — TDD

**Files:**
- Create: `server/src/services/buildCache.helpers.ts`
- Test: `server/src/services/__tests__/buildCache.helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// server/src/services/__tests__/buildCache.helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
    parseHumanSize,
    parseDockerSystemDf,
    parseBuildctlDu,
    builderPruneArgs,
    buildctlPruneArgsModern,
    buildctlPruneArgsLegacy,
} from '../buildCache.helpers';

describe('parseHumanSize', () => {
    it('parses docker-style SI sizes', () => {
        expect(parseHumanSize('19.85GB')).toBe(19.85e9);
        expect(parseHumanSize('163.8kB')).toBe(163.8e3);
        expect(parseHumanSize('104.3MiB')).toBeCloseTo(104.3 * 1024 * 1024);
        expect(parseHumanSize('0B')).toBe(0);
        expect(parseHumanSize('512')).toBe(512);
    });
    it('returns 0 for unparseable input', () => {
        expect(parseHumanSize('')).toBe(0);
        expect(parseHumanSize('n/a')).toBe(0);
    });
});

describe('parseDockerSystemDf', () => {
    // `docker system df --format json` emits one JSON object per line.
    const sample = [
        '{"Active":"4","Reclaimable":"1.284GB (5%)","Size":"21.47GB","TotalCount":"6","Type":"Images"}',
        '{"Active":"9","Reclaimable":"16.38kB (10%)","Size":"163.8kB","TotalCount":"11","Type":"Containers"}',
        '{"Active":"5","Reclaimable":"0B (0%)","Size":"149.6MB","TotalCount":"5","Type":"Local Volumes"}',
        '{"Active":"0","Reclaimable":"19.85GB","Size":"19.85GB","TotalCount":"223","Type":"Build Cache"}',
    ].join('\n');

    it('extracts the Build Cache size in bytes', () => {
        expect(parseDockerSystemDf(sample)).toBe(19.85e9);
    });
    it('returns 0 when the Build Cache row is missing', () => {
        expect(parseDockerSystemDf('{"Type":"Images","Size":"1GB"}')).toBe(0);
    });
    it('survives garbage lines', () => {
        expect(parseDockerSystemDf('WARNING: something\n' + sample)).toBe(19.85e9);
    });
});

describe('parseBuildctlDu', () => {
    const sample = [
        'ID\t\t\t\t\t\t\tRECLAIMABLE\tSIZE\t\tLAST ACCESSED',
        'sf53q...\t\t\t\t\t\ttrue\t\t1.44GB',
        'Shared:\t\t4.87GB',
        'Private:\t14.99GB',
        'Reclaimable:\t19.85GB',
        'Total:\t\t19.85GB',
    ].join('\n');

    it('extracts the Total line in bytes', () => {
        expect(parseBuildctlDu(sample)).toBe(19.85e9);
    });
    it('returns 0 when no Total line exists', () => {
        expect(parseBuildctlDu('')).toBe(0);
        expect(parseBuildctlDu('garbage')).toBe(0);
    });
});

describe('prune args builders', () => {
    it('docker builder prune to a cap', () => {
        expect(builderPruneArgs(10)).toEqual(['builder', 'prune', '-f', '--keep-storage', '10GB']);
    });
    it('docker builder full prune when cap is 0', () => {
        expect(builderPruneArgs(0)).toEqual(['builder', 'prune', '-af']);
    });
    it('buildctl modern prune to a cap', () => {
        expect(buildctlPruneArgsModern(10)).toEqual(
            ['exec', 'runnable-buildkit', 'buildctl', 'prune', '--max-used-space', '10GB']);
    });
    it('buildctl modern full prune when cap is 0', () => {
        expect(buildctlPruneArgsModern(0)).toEqual(
            ['exec', 'runnable-buildkit', 'buildctl', 'prune']);
    });
    it('buildctl legacy prune uses MB integer', () => {
        expect(buildctlPruneArgsLegacy(10)).toEqual(
            ['exec', 'runnable-buildkit', 'buildctl', 'prune', '--keep-storage', '10000']);
    });
    it('buildctl legacy full prune when cap is 0', () => {
        expect(buildctlPruneArgsLegacy(0)).toEqual(
            ['exec', 'runnable-buildkit', 'buildctl', 'prune']);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/services/__tests__/buildCache.helpers.test.ts`
Expected: FAIL — `Cannot find module '../buildCache.helpers'` (or equivalent).

- [ ] **Step 3: Write the implementation**

```typescript
// server/src/services/buildCache.helpers.ts
// Pure helpers for build-cache GC: size parsing and prune-command
// construction. No I/O here — everything is unit-testable.

export const BUILDKIT_CONTAINER = 'runnable-buildkit';

// Docker and buildctl print SI-decimal sizes ("19.85GB" = 19.85e9), and
// occasionally binary ones ("104.3MiB"). Unknown input parses to 0 so a
// format drift degrades the usage display instead of crashing the API.
const SIZE_UNITS: Record<string, number> = {
    '': 1, b: 1,
    kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

export function parseHumanSize(s: string): number {
    const m = s.trim().match(/^([\d.]+)\s*([a-zA-Z]*)$/);
    if (!m) return 0;
    const unit = SIZE_UNITS[m[2].toLowerCase()];
    if (unit === undefined) return 0;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n * unit : 0;
}

// `docker system df --format json` emits one JSON object per line.
export function parseDockerSystemDf(stdout: string): number {
    for (const line of stdout.split('\n')) {
        try {
            const row = JSON.parse(line);
            if (row.Type === 'Build Cache') return parseHumanSize(String(row.Size ?? ''));
        } catch {
            // non-JSON line (warnings etc.) — skip
        }
    }
    return 0;
}

// `buildctl du` ends with a "Total:\t<size>" summary line.
export function parseBuildctlDu(stdout: string): number {
    for (const line of stdout.split('\n')) {
        const m = line.match(/^Total:\s+(\S+)/);
        if (m) return parseHumanSize(m[1]);
    }
    return 0;
}

// A cap of 0 means "no cap": enforcement is skipped, and an explicit
// prune request reclaims everything instead.
export function builderPruneArgs(keepGB: number): string[] {
    if (keepGB <= 0) return ['builder', 'prune', '-af'];
    return ['builder', 'prune', '-f', '--keep-storage', `${keepGB}GB`];
}

export function buildctlPruneArgsModern(keepGB: number): string[] {
    const base = ['exec', BUILDKIT_CONTAINER, 'buildctl', 'prune'];
    if (keepGB <= 0) return base;
    return [...base, '--max-used-space', `${keepGB}GB`];
}

// Older buildkit: --keep-storage takes a plain megabyte integer.
export function buildctlPruneArgsLegacy(keepGB: number): string[] {
    const base = ['exec', BUILDKIT_CONTAINER, 'buildctl', 'prune'];
    if (keepGB <= 0) return base;
    return [...base, '--keep-storage', String(keepGB * 1000)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/services/__tests__/buildCache.helpers.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run the full server test suite**

Run: `cd server && npm test`
Expected: PASS — no other suites affected.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/buildCache.helpers.ts server/src/services/__tests__/buildCache.helpers.test.ts
git commit -m "feat: pure helpers for build-cache GC (size parsing, prune args)"
```

---

### Task 2: `AppSettings.buildCacheKeepGB` column + migration + `AppSettingsService`

**Files:**
- Modify: `server/src/entities/AppSettings.ts`
- Create: `server/src/migrations/1772640000000-AddBuildCacheKeepGB.ts`
- Modify: `server/src/config/data-source.ts`
- Create: `server/src/services/appSettings.service.ts`

- [ ] **Step 1: Add the column to the entity**

In `server/src/entities/AppSettings.ts`, add after the `servDir` column:

```typescript
    // Build-cache GC cap in GB. 0 disables post-deploy enforcement.
    @Column({ default: 10 })
    buildCacheKeepGB: number;
```

- [ ] **Step 2: Write the migration**

```typescript
// server/src/migrations/1772640000000-AddBuildCacheKeepGB.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBuildCacheKeepGB1772640000000 implements MigrationInterface {
    name = 'AddBuildCacheKeepGB1772640000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "app_settings"
            ADD COLUMN IF NOT EXISTS "buildCacheKeepGB" integer NOT NULL DEFAULT 10
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "buildCacheKeepGB"`);
    }
}
```

- [ ] **Step 3: Register the migration in the data source**

In `server/src/config/data-source.ts`:
- Add import: `import { AddBuildCacheKeepGB1772640000000 } from '../migrations/1772640000000-AddBuildCacheKeepGB';`
- Append `AddBuildCacheKeepGB1772640000000` to the `migrations: [...]` array (after `AddPreviewColumns1772639000000`).

- [ ] **Step 4: Create the settings accessor service**

```typescript
// server/src/services/appSettings.service.ts
// Accessor for the app_settings singleton row. The row is created lazily
// because nothing seeds it at install time.
import { AppDataSource } from '../config/data-source';
import { AppSettings } from '../entities/AppSettings';
import { config } from '../config';

const settingsRepo = () => AppDataSource.getRepository(AppSettings);

export class AppSettingsService {
    static async get(): Promise<AppSettings> {
        const repo = settingsRepo();
        let row = await repo.findOneBy({ id: 'global' });
        if (!row) {
            row = repo.create({
                id: 'global',
                baseDomain: config.hosting.baseDomain,
                servDir: config.hosting.servDir,
            });
            await repo.save(row);
        }
        return row;
    }

    static async update(partial: Partial<Pick<AppSettings, 'buildCacheKeepGB' | 'maxUploadSizeMB' | 'baseDomain'>>): Promise<AppSettings> {
        const repo = settingsRepo();
        const row = await AppSettingsService.get();
        Object.assign(row, partial);
        return repo.save(row);
    }
}
```

Note: check `server/src/config/index.ts` for the exact names of `config.hosting.baseDomain` / `config.hosting.servDir` (both are referenced in `system.routes.ts` and `serverConfig.service.ts`, so they exist — match whatever they are called there).

- [ ] **Step 5: Typecheck**

Run: `cd server && npm run build`
Expected: compiles with no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/entities/AppSettings.ts server/src/migrations/1772640000000-AddBuildCacheKeepGB.ts server/src/config/data-source.ts server/src/services/appSettings.service.ts
git commit -m "feat: buildCacheKeepGB setting + AppSettings accessor service"
```

---

### Task 3: `BuildCacheService` (usage / enforceCap / pruneToCap)

**Files:**
- Create: `server/src/services/buildCache.service.ts`

All parse/arg logic was tested in Task 1; this service is a thin exec shell, verified manually in Task 7 (matches the spec's testing section).

- [ ] **Step 1: Write the service**

```typescript
// server/src/services/buildCache.service.ts
// Enforces the admin-configured build-cache cap. Two caches exist:
//  - the Docker daemon's builder cache (compose builds)
//  - the runnable-buildkit container's cache (railpack builds)
// Pruning concurrently with builds is safe: BuildKit never evicts cache
// referenced by an in-flight build.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AppSettingsService } from './appSettings.service';
import {
    BUILDKIT_CONTAINER,
    builderPruneArgs,
    buildctlPruneArgsModern,
    buildctlPruneArgsLegacy,
    parseDockerSystemDf,
    parseBuildctlDu,
} from './buildCache.helpers';

const execFileAsync = promisify(execFile);
// Prunes of tens of GB can take minutes; outputs can be large.
const EXEC_OPTS = { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 };

export interface BuildCacheUsage {
    daemonBytes: number;
    buildkitBytes: number;
}

export class BuildCacheService {
    // Two deploys finishing together must not run overlapping prunes —
    // the second joins the first run instead.
    private static inFlight: Promise<void> | null = null;

    static async usage(): Promise<BuildCacheUsage> {
        const { stdout } = await execFileAsync('docker', ['system', 'df', '--format', 'json'], EXEC_OPTS);
        const daemonBytes = parseDockerSystemDf(stdout);

        let buildkitBytes = 0;
        if (await BuildCacheService.buildkitUp()) {
            try {
                const du = await execFileAsync('docker', ['exec', BUILDKIT_CONTAINER, 'buildctl', 'du'], EXEC_OPTS);
                buildkitBytes = parseBuildctlDu(du.stdout);
            } catch {
                // builder container present but not responding — report 0
            }
        }
        return { daemonBytes, buildkitBytes };
    }

    /** Post-deploy hook. Never throws; never blocks the deploy path. */
    static enforceCap(): Promise<void> {
        if (BuildCacheService.inFlight) return BuildCacheService.inFlight;
        const run = (async () => {
            try {
                const { buildCacheKeepGB } = await AppSettingsService.get();
                if (!buildCacheKeepGB || buildCacheKeepGB <= 0) return; // disabled
                await BuildCacheService.prune(buildCacheKeepGB);
            } catch (err: any) {
                console.error('[BuildCache] enforcement failed:', err?.message || err);
            } finally {
                BuildCacheService.inFlight = null;
            }
        })();
        BuildCacheService.inFlight = run;
        return run;
    }

    /** Explicit "Prune now". Cap 0 means full prune. Throws on failure. */
    static async pruneToCap(): Promise<{ freedBytes: number }> {
        const before = await BuildCacheService.usage();
        const { buildCacheKeepGB } = await AppSettingsService.get();
        await BuildCacheService.prune(buildCacheKeepGB);
        const after = await BuildCacheService.usage();
        const freedBytes = Math.max(0,
            (before.daemonBytes + before.buildkitBytes) - (after.daemonBytes + after.buildkitBytes));
        return { freedBytes };
    }

    private static async prune(keepGB: number): Promise<void> {
        await execFileAsync('docker', builderPruneArgs(keepGB), EXEC_OPTS);

        if (!(await BuildCacheService.buildkitUp())) return;
        try {
            await execFileAsync('docker', buildctlPruneArgsModern(keepGB), EXEC_OPTS);
        } catch (err: any) {
            const msg = String(err?.stderr || err?.message || '');
            // Older buildkit doesn't know --max-used-space; retry with the
            // legacy flag. Any other failure propagates.
            if (keepGB > 0 && /unknown flag|flag provided but not defined/i.test(msg)) {
                await execFileAsync('docker', buildctlPruneArgsLegacy(keepGB), EXEC_OPTS);
            } else {
                throw err;
            }
        }
    }

    private static async buildkitUp(): Promise<boolean> {
        try {
            const { stdout } = await execFileAsync('docker',
                ['ps', '--filter', `name=${BUILDKIT_CONTAINER}`, '--format', '{{.Status}}'], EXEC_OPTS);
            return stdout.includes('Up');
        } catch {
            return false;
        }
    }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && npm run build`
Expected: compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/buildCache.service.ts
git commit -m "feat: BuildCacheService — usage, cap enforcement, prune-to-cap"
```

---

### Task 4: API endpoints on `/api/system`

**Files:**
- Modify: `server/src/routes/system.routes.ts`

The router is already gated with `router.use(authenticate, requireRole(Role.ADMIN))` — new routes inherit it.

- [ ] **Step 1: Add imports**

At the top of `server/src/routes/system.routes.ts`:

```typescript
import { BuildCacheService } from '../services/buildCache.service';
import { AppSettingsService } from '../services/appSettings.service';
```

- [ ] **Step 2: Add the three routes**

Add at the end of the file, before `export default router;`:

```typescript
// ── Build-cache GC (spec: docs/superpowers/specs/2026-06-11-build-cache-gc-cap-design.md) ──

function dockerError(err: any): string {
    const detail = String(err?.stderr || err?.message || 'unknown error').slice(0, 200);
    return `Docker command failed: ${detail}`;
}

router.get('/build-cache', async (_req, res) => {
    try {
        const [usage, settings] = await Promise.all([
            BuildCacheService.usage(),
            AppSettingsService.get(),
        ]);
        res.json({
            usageBytes: usage.daemonBytes + usage.buildkitBytes,
            daemonBytes: usage.daemonBytes,
            buildkitBytes: usage.buildkitBytes,
            keepGB: settings.buildCacheKeepGB,
        });
    } catch (err: any) {
        res.status(500).json({ error: dockerError(err) });
    }
});

router.put('/build-cache', async (req, res, next: NextFunction) => {
    try {
        const keepGB = req.body?.keepGB;
        if (!Number.isInteger(keepGB) || keepGB < 0 || keepGB > 500) {
            return res.status(400).json({ error: 'keepGB must be an integer between 0 and 500' });
        }
        const settings = await AppSettingsService.update({ buildCacheKeepGB: keepGB });
        res.json({ keepGB: settings.buildCacheKeepGB });
    } catch (error) {
        next(error);
    }
});

router.post('/build-cache/prune', async (_req, res) => {
    try {
        const { freedBytes } = await BuildCacheService.pruneToCap();
        res.json({ freedBytes });
    } catch (err: any) {
        res.status(500).json({ error: dockerError(err) });
    }
});
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npm run build`
Expected: compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/system.routes.ts
git commit -m "feat: admin API for build-cache usage, cap, and prune"
```

---

### Task 5: Post-deploy enforcement hook

**Files:**
- Modify: `server/src/services/process.service.ts` (around line 408 — `doStart`'s tail)

Both deployment paths (compose and railpack/dockerfile) converge at the end of `doStart`, where status flips to RUNNING. One call site covers everything.

- [ ] **Step 1: Add import**

At the top of `server/src/services/process.service.ts`, with the other service imports:

```typescript
import { BuildCacheService } from './buildCache.service';
```

- [ ] **Step 2: Add the fire-and-forget call**

Find (end of `doStart`):

```typescript
        // Emit status update
        ProcessService.emitStatus(projectId, ServiceStatus.RUNNING);
    }
```

Replace with:

```typescript
        // Emit status update
        ProcessService.emitStatus(projectId, ServiceStatus.RUNNING);

        // Opportunistic build-cache GC. Fire-and-forget: enforceCap never
        // throws, and a deploy must never wait on (or fail from) a prune.
        void BuildCacheService.enforceCap();
    }
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `cd server && npm run build && npm test`
Expected: build clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/process.service.ts
git commit -m "feat: enforce build-cache cap after every deploy"
```

---

### Task 6: Client — API module + Admin "System" card

**Files:**
- Modify: `client/src/api/system.ts`
- Modify: `client/src/pages/Admin.tsx`

- [ ] **Step 1: Extend the system API module**

In `client/src/api/system.ts`, add to the existing file (it already exports `systemApi` with `stats`):

```typescript
export interface BuildCacheInfo {
    usageBytes: number;
    daemonBytes: number;
    buildkitBytes: number;
    keepGB: number;
}
```

And add to the existing `systemApi` object:

```typescript
    getBuildCache: () => api.get<BuildCacheInfo>('/system/build-cache'),
    updateBuildCache: (keepGB: number) => api.put<{ keepGB: number }>('/system/build-cache', { keepGB }),
    pruneBuildCache: () => api.post<{ freedBytes: number }>('/system/build-cache/prune'),
```

- [ ] **Step 2: Add the System card to the Admin page**

In `client/src/pages/Admin.tsx`:

Add imports:

```typescript
import { systemApi } from '../api/system';
import type { BuildCacheInfo } from '../api/system';
import { HardDrive } from 'lucide-react';
```

Add state + loader inside the `Admin` component (next to the existing user state):

```typescript
    // Build-cache (System) section
    const [cache, setCache] = useState<BuildCacheInfo | null>(null);
    const [cacheError, setCacheError] = useState('');
    const [capInput, setCapInput] = useState('');
    const [capSaving, setCapSaving] = useState(false);
    const [pruning, setPruning] = useState(false);
    const [cacheMessage, setCacheMessage] = useState('');

    const gb = (bytes: number) => (bytes / 1e9).toFixed(2);

    const fetchBuildCache = async () => {
        try {
            setCacheError('');
            const { data } = await systemApi.getBuildCache();
            setCache(data);
            setCapInput(String(data.keepGB));
        } catch (err: any) {
            setCacheError(err.response?.data?.error || 'Failed to load build-cache info');
        }
    };

    useEffect(() => {
        fetchBuildCache();
    }, []);

    const handleSaveCap = async () => {
        const keepGB = Number(capInput);
        if (!Number.isInteger(keepGB) || keepGB < 0 || keepGB > 500) {
            setCacheError('Cap must be a whole number between 0 and 500');
            return;
        }
        try {
            setCapSaving(true);
            setCacheError('');
            setCacheMessage('');
            await systemApi.updateBuildCache(keepGB);
            setCacheMessage(keepGB === 0 ? 'Automatic pruning disabled' : `Cap saved: ${keepGB} GB`);
            await fetchBuildCache();
        } catch (err: any) {
            setCacheError(err.response?.data?.error || 'Failed to save cap');
        } finally {
            setCapSaving(false);
        }
    };

    const handlePrune = async () => {
        try {
            setPruning(true);
            setCacheError('');
            setCacheMessage('');
            const { data } = await systemApi.pruneBuildCache();
            setCacheMessage(`Freed ${gb(data.freedBytes)} GB`);
            await fetchBuildCache();
        } catch (err: any) {
            setCacheError(err.response?.data?.error || 'Prune failed');
        } finally {
            setPruning(false);
        }
    };
```

Add the card JSX after the existing users `glass` card (inside `page-content`), matching the existing card style:

```tsx
                <div className="glass" style={{ padding: 24, borderRadius: 12, marginTop: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                        <HardDrive size={20} className="text-primary" />
                        <h2 style={{ margin: 0 }}>System — Build Cache</h2>
                    </div>

                    {cacheError && <div className="error-message">{cacheError}</div>}
                    {cacheMessage && <div className="success-message">{cacheMessage}</div>}

                    {cache && (
                        <p style={{ marginBottom: 16 }}>
                            Current usage: <strong>{gb(cache.usageBytes)} GB</strong>
                            {' '}(daemon {gb(cache.daemonBytes)} GB, buildkit {gb(cache.buildkitBytes)} GB)
                        </p>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <label htmlFor="cache-cap">Cap (GB, 0 = disabled):</label>
                        <input
                            id="cache-cap"
                            type="number"
                            min={0}
                            max={500}
                            value={capInput}
                            onChange={(e) => setCapInput(e.target.value)}
                            style={{ width: 100 }}
                        />
                        <button className="btn btn-primary" onClick={handleSaveCap} disabled={capSaving}>
                            {capSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button className="btn btn-secondary" onClick={handlePrune} disabled={pruning}>
                            {pruning ? 'Pruning…' : 'Prune now'}
                        </button>
                    </div>
                </div>
```

Note: check whether `Admin.tsx` / the stylesheet has a `success-message` class (the Settings page shows success states — reuse whatever it uses). If none exists, render the message with the inline style used by Settings' success text.

- [ ] **Step 3: Build the client**

Run: `cd client && npm run build`
Expected: compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/api/system.ts client/src/pages/Admin.tsx
git commit -m "feat: Admin System card — build-cache usage, cap, prune now"
```

---

### Task 7: Manual verification (dev box or server)

No code. Verifies the exec-shell pieces the unit tests can't.

- [ ] **Step 1: Verify buildctl flag support on the production builder**

Run (on the server): `docker exec runnable-buildkit buildctl prune --help`
Expected: help text lists `--max-used-space` (modern) — if it only lists `--keep-storage`, the legacy fallback in `BuildCacheService.prune` covers it. Either way, no code change needed; this confirms which path runs.

- [ ] **Step 2: Verify the API end-to-end**

With the server running and an admin session:
- `GET /api/system/build-cache` → 200 with plausible `usageBytes` and `keepGB: 10`.
- `PUT /api/system/build-cache` with `{"keepGB": 5}` → 200 `{keepGB: 5}`; with `{"keepGB": -1}` → 400.
- `POST /api/system/build-cache/prune` → 200 `{freedBytes: ...}`; re-run `GET` and confirm usage dropped.

- [ ] **Step 3: Verify the UI**

On the Admin page: System card shows usage; saving an invalid cap shows the inline error; "Prune now" reports freed GB and the usage figure refreshes.

- [ ] **Step 4: Verify post-deploy enforcement**

Deploy any project, then check the server log for either silence (cache under cap) or a `[BuildCache]` error line — and confirm `docker system df` build-cache stays at/below the cap after a couple of deploys.

---

## Out of scope (from the spec)

- `/etc/docker/daemon.json` changes.
- One-time reclaim of the existing ~20 GB on production — use the new "Prune now" button after deploying this feature.
- Per-project caps, scheduled prunes, image/volume/log pruning.
