# Portal Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin check for and apply Runnable updates from the portal, with automatic rollback when the new revision fails to build or fails to come back healthy.

**Architecture:** The API never performs an update — it only reports on one and triggers one. `deploy.sh` ends in `systemctl restart runnable`, and systemd kills the service's entire cgroup on restart, so the updater runs in its own transient unit via `systemd-run`. Because the API is offline mid-update, progress lives in a state file on disk that the API merely reads.

**Tech Stack:** TypeScript, Express 5, TypeORM, vitest + supertest, bash, systemd, React 19.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-05-portal-self-update-design.md`.
- Admin-only. `server/src/routes/system.routes.ts` already applies `router.use(authenticate, requireRole(Role.ADMIN))` at line 17 — new routes there inherit it. Do not add per-route auth.
- State and log files live in `path.resolve(config.hosting.servDir, '..')` (i.e. `/var/runnable`), never inside the repo — `git reset --hard` during rollback would delete a log written inside the repo.
- Rollback restores code only, never the database.
- Server indentation is 4 spaces. Client `.tsx` is 4 spaces. Match surrounding style.
- Tests: `npx vitest run --root server` from the repo root.
- Do not add any npm dependency. Everything here uses Node builtins and existing packages.
- No user input is ever interpolated into a command line. All `execFile`/`systemd-run` argv is fixed.

---

### Task 1: Git inspection and the update check

**Files:**
- Create: `server/src/services/update.service.ts`
- Test: `server/src/services/__tests__/update.service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `UpdatePhase`, `UpdateCommit`, `UpdateState`, `UpdateCheckResult`, `UpdateStatus`, `TERMINAL_PHASES`, `parseCommitLog(stdout: string): UpdateCommit[]`, `UpdateService.check(force?: boolean): Promise<UpdateCheckResult>`, `UpdateService.resetForTests(): void`.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/__tests__/update.service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

vi.mock('../../config', () => ({
    config: { hosting: { servDir: '/var/runnable/projects' } },
}));

import { parseCommitLog, UpdateService } from '../update.service';

// promisify(execFile) calls execFile(file, args, opts, cb). Resolve or reject
// per queued response so tests can drive a whole command sequence.
function queueExec(responses: Array<{ stdout?: string; error?: string }>) {
    let i = 0;
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, cb: any) => {
        const r = responses[i++] ?? { stdout: '' };
        if (r.error) {
            const err: any = new Error(r.error);
            err.stderr = r.error;
            cb(err, { stdout: '', stderr: r.error });
        } else {
            cb(null, { stdout: r.stdout ?? '', stderr: '' });
        }
    });
}

beforeEach(() => {
    execFileMock.mockReset();
    UpdateService.resetForTests();
});

describe('parseCommitLog', () => {
    it('parses sha and subject from each line', () => {
        expect(parseCommitLog('abc1234 fix: a thing\ndef5678 feat: another thing')).toEqual([
            { sha: 'abc1234', subject: 'fix: a thing' },
            { sha: 'def5678', subject: 'feat: another thing' },
        ]);
    });

    it('keeps spaces inside the subject', () => {
        expect(parseCommitLog('abc1234 fix: a b c')).toEqual([
            { sha: 'abc1234', subject: 'fix: a b c' },
        ]);
    });

    it('returns an empty array for empty or whitespace output', () => {
        expect(parseCommitLog('')).toEqual([]);
        expect(parseCommitLog('   \n  ')).toEqual([]);
    });

    it('ignores a line with no subject', () => {
        expect(parseCommitLog('abc1234')).toEqual([]);
    });
});

describe('UpdateService.check', () => {
    it('reports how far behind the checkout is and what is coming', async () => {
        queueExec([
            { stdout: '' },                              // git fetch
            { stdout: 'aaa1111\n' },                     // rev-parse --short HEAD
            { stdout: '2\n' },                           // rev-list --count
            { stdout: 'bbb2222 feat: x\nccc3333 fix: y' } // log
        ]);

        const result = await UpdateService.check();

        expect(result.current).toBe('aaa1111');
        expect(result.behind).toBe(2);
        expect(result.commits).toEqual([
            { sha: 'bbb2222', subject: 'feat: x' },
            { sha: 'ccc3333', subject: 'fix: y' },
        ]);
        expect(result.error).toBeNull();
        expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('reports zero behind when up to date', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '0\n' }, { stdout: '' }]);

        const result = await UpdateService.check();

        expect(result.behind).toBe(0);
        expect(result.commits).toEqual([]);
    });

    it('serves the cached result without re-fetching when not forced', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }]);
        await UpdateService.check();
        const callsAfterFirst = execFileMock.mock.calls.length;

        await UpdateService.check();

        expect(execFileMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it('re-fetches when forced', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' },
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '3\n' }, { stdout: 'bbb2222 feat: x' },
        ]);
        await UpdateService.check();

        const result = await UpdateService.check(true);

        expect(result.behind).toBe(3);
    });

    it('shares one in-flight fetch between concurrent callers', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }]);

        const [a, b] = await Promise.all([UpdateService.check(true), UpdateService.check(true)]);

        expect(a).toEqual(b);
        // One command sequence, not two.
        expect(execFileMock.mock.calls.length).toBe(4);
    });

    it('keeps the last good result when a fetch fails, and records the error', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '2\n' }, { stdout: 'bbb2222 feat: x' },
            { error: 'could not resolve host github.com' },
        ]);
        await UpdateService.check();

        const result = await UpdateService.check(true);

        expect(result.behind).toBe(2);                       // stale but true
        expect(result.commits).toHaveLength(1);
        expect(result.error).toMatch(/could not resolve host/);
    });

    it('reports the error with zeroed data when the very first check fails', async () => {
        queueExec([{ error: 'not a git repository' }]);

        const result = await UpdateService.check();

        expect(result.behind).toBe(0);
        expect(result.error).toMatch(/not a git repository/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root server src/services/__tests__/update.service.test.ts`
Expected: FAIL — "Failed to resolve import ../update.service" / `parseCommitLog is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/update.service.ts`:

```typescript
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { config } from '../config';

const execFileAsync = promisify(execFile);

/** Repo root. From server/dist/services (or server/src/services) that is three up. */
export const REPO_ROOT = path.resolve(__dirname, '../../..');
/** Durable state dir, outside the repo — `git reset --hard` must not touch it. */
export const STATE_DIR = path.resolve(config.hosting.servDir, '..');
export const UPDATE_LOG_PATH = path.join(STATE_DIR, 'update.log');
export const UPDATE_STATE_PATH = path.join(STATE_DIR, 'update-state.json');

export type UpdatePhase =
    | 'idle' | 'pulling' | 'installing' | 'building' | 'syncing'
    | 'restarting' | 'verifying' | 'done'
    | 'rolling_back' | 'failed' | 'failed_rollback';

/** Phases in which no update is running, so a new one may start. */
export const TERMINAL_PHASES: UpdatePhase[] = ['idle', 'done', 'failed', 'failed_rollback'];

export interface UpdateCommit { sha: string; subject: string; }

export interface UpdateCheckResult {
    current: string;
    behind: number;
    commits: UpdateCommit[];
    checkedAt: string;
    error: string | null;
}

const CHECK_TTL_MS = 60 * 60 * 1000; // an unforced check reuses a result this fresh

/** `git log --pretty=format:%h %s` output -> commits. */
export function parseCommitLog(stdout: string): UpdateCommit[] {
    return stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const spaceAt = line.indexOf(' ');
            if (spaceAt < 1) return null;
            return { sha: line.slice(0, spaceAt), subject: line.slice(spaceAt + 1).trim() };
        })
        .filter((c): c is UpdateCommit => c !== null && c.subject.length > 0);
}

function git(args: string[]): Promise<string> {
    return execFileAsync('git', args, { cwd: REPO_ROOT }).then(r => r.stdout);
}

export class UpdateService {
    private static cached: UpdateCheckResult | null = null;
    private static inFlight: Promise<UpdateCheckResult> | null = null;

    /** Test seam — clears memoised state between cases. */
    static resetForTests(): void {
        UpdateService.cached = null;
        UpdateService.inFlight = null;
    }

    static async check(force = false): Promise<UpdateCheckResult> {
        const cached = UpdateService.cached;
        if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < CHECK_TTL_MS) {
            return cached;
        }
        // Concurrent callers (timer + admin clicking "Check now") share one fetch.
        if (UpdateService.inFlight) return UpdateService.inFlight;

        UpdateService.inFlight = UpdateService.runCheck()
            .finally(() => { UpdateService.inFlight = null; });
        return UpdateService.inFlight;
    }

    private static async runCheck(): Promise<UpdateCheckResult> {
        try {
            await git(['fetch', 'origin', '--quiet']);
            const current = (await git(['rev-parse', '--short', 'HEAD'])).trim();
            const behind = parseInt((await git(['rev-list', '--count', 'HEAD..@{u}'])).trim(), 10) || 0;
            const commits = behind > 0
                ? parseCommitLog(await git(['log', '--pretty=format:%h %s', 'HEAD..@{u}']))
                : [];

            const result: UpdateCheckResult = {
                current, behind, commits,
                checkedAt: new Date().toISOString(),
                error: null,
            };
            UpdateService.cached = result;
            return result;
        } catch (err: any) {
            const message = String(err?.stderr || err?.message || 'git check failed').trim();
            // A network blip must not destroy a known-good answer. Keep the old
            // data and its original timestamp; surface the error alongside.
            if (UpdateService.cached) {
                return { ...UpdateService.cached, error: message };
            }
            return {
                current: '', behind: 0, commits: [],
                checkedAt: new Date().toISOString(),
                error: message,
            };
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root server src/services/__tests__/update.service.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/update.service.ts server/src/services/__tests__/update.service.test.ts
git commit -m "feat: add update check with caching and failure retention"
```

---

### Task 2: Reading the update state file

**Files:**
- Modify: `server/src/services/update.service.ts`
- Test: `server/src/services/__tests__/update.service.test.ts`

**Interfaces:**
- Consumes: `UpdatePhase`, `UPDATE_STATE_PATH` from Task 1.
- Produces: `UpdateState`, `UpdateStatus`, `UpdateService.readState(): Promise<UpdateState>`, `UpdateService.status(): Promise<UpdateStatus>`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/__tests__/update.service.test.ts`. Also add this mock alongside the existing `vi.mock` calls at the top of the file:

```typescript
const readFileMock = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({ default: { readFile: readFileMock }, readFile: readFileMock }));
```

Then append these suites:

```typescript
describe('UpdateService.readState', () => {
    it('reads a well-formed state file', async () => {
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt: '2026-08-05T10:00:00.000Z', finishedAt: null, error: null,
        }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('building');
        expect(state.prevCommit).toBe('aaa1111');
    });

    // No file means no update has ever run — that is idle, not an error.
    it('returns idle when the file does not exist', async () => {
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        readFileMock.mockRejectedValue(err);

        const state = await UpdateService.readState();

        expect(state.phase).toBe('idle');
        expect(state.error).toBeNull();
    });

    // A half-written file must not wedge the UI into "an update is running".
    it('returns idle with an error when the file is corrupt', async () => {
        readFileMock.mockResolvedValue('{ not json');

        const state = await UpdateService.readState();

        expect(state.phase).toBe('idle');
        expect(state.error).toMatch(/unreadable/i);
    });

    it('rejects an unknown phase rather than trusting it', async () => {
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'wat' }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('idle');
        expect(state.error).toMatch(/unreadable/i);
    });
});

describe('UpdateService.status', () => {
    it('merges the cached check with the on-disk state', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }]);
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'done', prevCommit: 'aaa0000', newCommit: 'aaa1111',
            startedAt: '2026-08-05T10:00:00.000Z', finishedAt: '2026-08-05T10:02:00.000Z', error: null,
        }));

        const status = await UpdateService.status();

        expect(status.behind).toBe(1);
        expect(status.state.phase).toBe('done');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root server src/services/__tests__/update.service.test.ts`
Expected: FAIL — `UpdateService.readState is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to the imports at the top of `server/src/services/update.service.ts`:

```typescript
import fs from 'fs/promises';
```

Add after the `UpdateCheckResult` interface:

```typescript
export interface UpdateState {
    phase: UpdatePhase;
    prevCommit: string | null;
    newCommit: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
}

export interface UpdateStatus extends UpdateCheckResult {
    state: UpdateState;
}

const IDLE_STATE: UpdateState = {
    phase: 'idle', prevCommit: null, newCommit: null,
    startedAt: null, finishedAt: null, error: null,
};

const ALL_PHASES: UpdatePhase[] = [
    'idle', 'pulling', 'installing', 'building', 'syncing',
    'restarting', 'verifying', 'done', 'rolling_back', 'failed', 'failed_rollback',
];
```

Add these methods inside `class UpdateService`:

```typescript
    static async readState(): Promise<UpdateState> {
        let raw: string;
        try {
            raw = await fs.readFile(UPDATE_STATE_PATH, 'utf-8');
        } catch {
            // No file at all: nothing has ever run. That is idle, not a fault.
            return { ...IDLE_STATE };
        }
        try {
            const parsed = JSON.parse(raw);
            if (!ALL_PHASES.includes(parsed?.phase)) throw new Error('unknown phase');
            return {
                phase: parsed.phase,
                prevCommit: parsed.prevCommit ?? null,
                newCommit: parsed.newCommit ?? null,
                startedAt: parsed.startedAt ?? null,
                finishedAt: parsed.finishedAt ?? null,
                error: parsed.error ?? null,
            };
        } catch {
            // A truncated or garbled file must not strand the UI mid-update.
            return { ...IDLE_STATE, error: 'Update state file is unreadable' };
        }
    }

    static async status(): Promise<UpdateStatus> {
        const [check, state] = await Promise.all([UpdateService.check(), UpdateService.readState()]);
        return { ...check, state };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root server src/services/__tests__/update.service.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/update.service.ts server/src/services/__tests__/update.service.test.ts
git commit -m "feat: read update state file with corrupt-file tolerance"
```

---

### Task 3: Preflight and triggering the updater

> **AMENDED 2026-08-05 during execution, with the plan author's approval.**
> Review found the code below is racy. As shipped (commits `bac89c3`,
> `64afd65`, `dd369de`), `start()` additionally: writes an atomic `pulling`
> claim (temp + `rename`) after preflight and before launch; copies the script
> via a temp path plus `mv -f` instead of writing the destination in place;
> maps a `systemd-run` unit collision to a 409 while leaving the state file
> untouched; and reverts the claim to `failed` on any other launch failure.
> The code block below is the original, superseded version — read
> `server/src/services/update.service.ts` for what actually shipped.

**Files:**
- Modify: `server/src/services/update.service.ts`
- Test: `server/src/services/__tests__/update.service.test.ts`

**Interfaces:**
- Consumes: `TERMINAL_PHASES`, `REPO_ROOT`, `STATE_DIR`, `UpdateService.check`, `UpdateService.readState` from Tasks 1–2.
- Produces: `UpdateService.start(): Promise<void>` — throws `AppError` on refusal.

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/__tests__/update.service.test.ts`:

```typescript
describe('UpdateService.start', () => {
    // Happy path: clean tree, 1 behind, nothing running.
    function queueHappyPreflight() {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }, // check
            { stdout: '' },   // status --porcelain (clean)
            { stdout: '' },   // install -m700
            { stdout: '' },   // systemd-run
        ]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));
    }

    it('launches the updater in its own transient unit', async () => {
        queueHappyPreflight();

        await UpdateService.start();

        const files = execFileMock.mock.calls.map((c: any[]) => c[0]);
        expect(files).toContain('systemd-run');

        const run = execFileMock.mock.calls.find((c: any[]) => c[0] === 'systemd-run')!;
        const args: string[] = run[1];
        expect(args).toContain('--unit=runnable-update');
        expect(args).toContain('--collect');
        // The script is copied out of the repo, so it cannot infer these itself.
        expect(args.some(a => a.startsWith('--setenv=INSTALL_DIR='))).toBe(true);
        expect(args.some(a => a.startsWith('--setenv=STATE_DIR='))).toBe(true);
        expect(args[args.length - 1]).toBe('/run/runnable-update.sh');
    });

    it('copies the script out of the repo before running it', async () => {
        queueHappyPreflight();

        await UpdateService.start();

        const install = execFileMock.mock.calls.find((c: any[]) => c[0] === 'install')!;
        expect(install[1]).toEqual(['-m700', expect.stringContaining('update.sh'), '/run/runnable-update.sh']);
    });

    it('refuses when an update is already running', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'building' }));

        await expect(UpdateService.start()).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringMatching(/already/i),
        });
    });

    it('refuses when the working tree is dirty', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' },
            { stdout: ' M server/src/index.ts\n' },
        ]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));

        await expect(UpdateService.start()).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringMatching(/uncommitted/i),
        });
    });

    it('refuses when there is nothing to update', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '0\n' }, { stdout: '' }]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));

        await expect(UpdateService.start()).rejects.toMatchObject({
            statusCode: 400,
            message: expect.stringMatching(/already up to date/i),
        });
    });

    it('refuses when the check itself failed', async () => {
        queueExec([{ error: 'not a git repository' }]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));

        await expect(UpdateService.start()).rejects.toMatchObject({ statusCode: 409 });
    });

    it('does not launch anything when preflight refuses', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '0\n' }, { stdout: '' }]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));

        await expect(UpdateService.start()).rejects.toThrow();

        expect(execFileMock.mock.calls.map((c: any[]) => c[0])).not.toContain('systemd-run');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root server src/services/__tests__/update.service.test.ts`
Expected: FAIL — `UpdateService.start is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to imports in `server/src/services/update.service.ts`:

```typescript
import { AppError } from '../middleware/errorHandler';
```

Add this constant near the other path constants:

```typescript
/** The updater is copied here so `git pull` cannot rewrite a running script. */
export const UPDATE_SCRIPT_RUNTIME_PATH = '/run/runnable-update.sh';
```

Add this method inside `class UpdateService`:

```typescript
    static async start(): Promise<void> {
        const [check, state] = await Promise.all([
            UpdateService.check(true),
            UpdateService.readState(),
        ]);

        if (!TERMINAL_PHASES.includes(state.phase)) {
            throw new AppError('An update is already in progress', 409);
        }
        if (check.error) {
            throw new AppError(`Cannot check for updates: ${check.error}`, 409);
        }
        const dirty = (await git(['status', '--porcelain'])).trim();
        if (dirty) {
            throw new AppError(
                'The installation has uncommitted changes — refusing to update. Resolve them on the server first.',
                409,
            );
        }
        if (check.behind === 0) {
            throw new AppError('Already up to date', 400);
        }

        // Copy the script out of the repo: `git pull` rewrites update.sh, and
        // bash reads a script incrementally by byte offset, so rewriting it
        // mid-run causes arbitrary misexecution.
        await execFileAsync('install', [
            '-m700', path.join(REPO_ROOT, 'update.sh'), UPDATE_SCRIPT_RUNTIME_PATH,
        ]);

        // Its own transient unit, outside this service's cgroup, so
        // `systemctl restart runnable` partway through does not kill it.
        // The copied script cannot infer the repo location, so pass it.
        await execFileAsync('systemd-run', [
            '--unit=runnable-update',
            '--collect',
            `--setenv=INSTALL_DIR=${REPO_ROOT}`,
            `--setenv=STATE_DIR=${STATE_DIR}`,
            UPDATE_SCRIPT_RUNTIME_PATH,
        ]);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root server src/services/__tests__/update.service.test.ts`
Expected: PASS — 23 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/update.service.ts server/src/services/__tests__/update.service.test.ts
git commit -m "feat: preflight and launch the updater in a transient systemd unit"
```

---

### Task 4: The updater script

**Files:**
- Create: `update.sh` (repo root)
- Create: `docs/migration-compatibility.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `INSTALL_DIR` and `STATE_DIR` environment variables set by `UpdateService.start` (Task 3).
- Produces: `$STATE_DIR/update-state.json` in the shape `UpdateState` (Task 2) and `$STATE_DIR/update.log`.

This task is bash, so it is verified by running it rather than by unit tests. The spec is explicit that the happy path is not unit tested; do not write a mock that pretends otherwise.

- [ ] **Step 1: Write the script**

Create `update.sh` at the repo root:

```bash
#!/usr/bin/env bash
# Runnable self-update, launched by UpdateService.start via:
#   systemd-run --unit=runnable-update --collect \
#     --setenv=INSTALL_DIR=... --setenv=STATE_DIR=... /run/runnable-update.sh
#
# Runs in its own transient systemd unit so that `systemctl restart runnable`
# partway through does not kill it. Never run this from inside the API process.
#
# This file is copied to /run before execution: `git pull` rewrites it, and
# bash reads scripts incrementally, so running it in place corrupts execution.
set -uo pipefail

INSTALL_DIR=${INSTALL_DIR:?INSTALL_DIR must be set}
STATE_DIR=${STATE_DIR:?STATE_DIR must be set}
WEB_DIR=${WEB_DIR:-/var/www/runnable}
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

LOG="$STATE_DIR/update.log"
STATE="$STATE_DIR/update-state.json"
HEALTH_URL=${HEALTH_URL:-http://localhost:3001/api/health}
VERIFY_TIMEOUT=${VERIFY_TIMEOUT:-60}

mkdir -p "$STATE_DIR"
cd "$INSTALL_DIR"

PREV=$(git rev-parse HEAD)
NEW=""
STARTED_AT=$(date -Iseconds)

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

# Written atomically: the API reads this file concurrently and must never see
# a half-written document.
write_state() {
    local phase=$1 error=${2:-null} finished=${3:-null}
    local new_json="null"
    [ -n "$NEW" ] && new_json="\"$NEW\""
    [ "$error" != "null" ] && error="\"${error//\"/\\\"}\""
    [ "$finished" != "null" ] && finished="\"$finished\""
    cat > "$STATE.tmp" <<JSON
{
  "phase": "$phase",
  "prevCommit": "$PREV",
  "newCommit": $new_json,
  "startedAt": "$STARTED_AT",
  "finishedAt": $finished,
  "error": $error
}
JSON
    mv "$STATE.tmp" "$STATE"
}

run() {
    if [ "$DRY_RUN" = 1 ]; then
        log "DRY RUN: $*"
        return 0
    fi
    "$@" >>"$LOG" 2>&1
}

wait_healthy() {
    local deadline=$((SECONDS + VERIFY_TIMEOUT))
    while [ $SECONDS -lt $deadline ]; do
        if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    return 1
}

# Rebuild and restart whatever is currently checked out. Used by both the
# forward path and the rollback path so they cannot drift apart.
build_and_restart() {
    run npm ci --ignore-scripts || return 1
    run npm run build || return 1
    run mkdir -p "$WEB_DIR" || return 1
    run rsync -a --delete "$INSTALL_DIR/client/dist/" "$WEB_DIR/" || return 1
    run find "$WEB_DIR" -type d -exec chmod 755 {} + || return 1
    run find "$WEB_DIR" -type f -exec chmod 644 {} + || return 1
    run systemctl restart runnable || return 1
    run systemctl reload caddy || return 1
    return 0
}

rollback() {
    local reason=$1
    log "FAILED: $reason — rolling back to $PREV"
    write_state rolling_back "$reason"

    if ! run git reset --hard "$PREV"; then
        log "ROLLBACK FAILED: could not reset to $PREV"
        write_state failed_rollback "Rollback failed: could not reset to $PREV" "$(date -Iseconds)"
        exit 1
    fi
    if ! build_and_restart; then
        log "ROLLBACK FAILED: previous revision no longer builds"
        write_state failed_rollback "Rollback failed: previous revision no longer builds" "$(date -Iseconds)"
        exit 1
    fi
    # Deliberately no retry loop: this path runs when something is already
    # wrong, so it stays dumb and predictable.
    if ! wait_healthy; then
        log "ROLLBACK FAILED: service unhealthy after rollback"
        write_state failed_rollback "Rollback failed: service unhealthy after restoring $PREV" "$(date -Iseconds)"
        exit 1
    fi
    log "Rolled back to $PREV successfully"
    write_state failed "$reason" "$(date -Iseconds)"
    exit 1
}

: > "$LOG"
log "Starting update from $PREV (dry-run=$DRY_RUN)"

write_state pulling
run git pull --ff-only || rollback "git pull failed"
NEW=$(git rev-parse HEAD)
log "Updating $PREV -> $NEW"

write_state installing
run npm ci --ignore-scripts || rollback "npm ci failed"

write_state building
run npm run build || rollback "build failed"

write_state syncing
run mkdir -p "$WEB_DIR" || rollback "could not create $WEB_DIR"
run rsync -a --delete "$INSTALL_DIR/client/dist/" "$WEB_DIR/" || rollback "rsync failed"
run find "$WEB_DIR" -type d -exec chmod 755 {} + || rollback "chmod dirs failed"
run find "$WEB_DIR" -type f -exec chmod 644 {} + || rollback "chmod files failed"

write_state restarting
run systemctl restart runnable || rollback "service restart failed"
run systemctl reload caddy || rollback "caddy reload failed"

write_state verifying
if [ "$DRY_RUN" = 1 ]; then
    log "DRY RUN: skipping health verification"
else
    wait_healthy || rollback "service did not become healthy within ${VERIFY_TIMEOUT}s"
fi

log "Update complete: $PREV -> $NEW"
write_state done null "$(date -Iseconds)"
```

- [ ] **Step 2: Make it executable and syntax-check it**

```bash
chmod +x update.sh
bash -n update.sh
```

Expected: no output (syntax OK).

- [ ] **Step 3: Dry-run it locally**

```bash
mkdir -p /tmp/runnable-update-test
INSTALL_DIR=$(pwd) STATE_DIR=/tmp/runnable-update-test ./update.sh --dry-run
cat /tmp/runnable-update-test/update-state.json
```

Expected: log lines prefixed `DRY RUN:` for every mutating command, and a final state file with `"phase": "done"`. Nothing on the machine is modified.

- [ ] **Step 4: Write the migration-compatibility doc**

Create `docs/migration-compatibility.md`:

```markdown
# Migration compatibility

The portal's self-update button (`update.sh`) rolls back **code only** when an
update fails. TypeORM runs migrations on boot (`migrationsRun: true`) and does
not revert them, so after a rollback the database is still migrated while the
code is one revision older.

That is safe only if migrations stay backward compatible. The rule:

> A migration must leave the database readable and writable by the **previous**
> release.

In practice:

- Adding a column, table, or index is always safe (`ADD COLUMN IF NOT EXISTS`).
- Dropping or renaming a column the previous release still reads is **not**.
  Split it across two releases: release N stops using the column, release N+1
  drops it.
- Making a nullable column `NOT NULL` is not safe if the previous release
  inserts rows without it.

Breaking this rule does not fail loudly at migration time. It fails when a
rollback happens — which is exactly when things are already going wrong.
```

- [ ] **Step 5: Note the script in the README**

In `README.md`, find the section describing `deploy.sh` and add after it:

```markdown
`update.sh` performs the same steps as `deploy.sh` but is driven by the portal's
self-update button, records progress to `$STATE_DIR/update-state.json`, and
rolls back to the previous commit if the new revision fails to build or fails
to come back healthy. Run it by hand only with `--dry-run`; the portal launches
the real thing in its own systemd unit. See
`docs/migration-compatibility.md` for the constraint this places on migrations.
```

- [ ] **Step 6: Commit**

```bash
git add update.sh docs/migration-compatibility.md README.md
git commit -m "feat: add self-update script with rollback"
```

---

### Task 5: API endpoints

**Files:**
- Modify: `server/src/routes/system.routes.ts`
- Test: `server/src/__tests__/update.routes.test.ts`

**Interfaces:**
- Consumes: `UpdateService.status`, `UpdateService.check`, `UpdateService.start`, `UPDATE_LOG_PATH` from Tasks 1–3.
- Produces: `GET /api/system/update`, `POST /api/system/update/check`, `POST /api/system/update`, `GET /api/system/update/log`.

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/update.routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/update.service', () => ({
    UpdateService: { status: vi.fn(), check: vi.fn(), start: vi.fn() },
    UPDATE_LOG_PATH: '/var/runnable/update.log',
}));
vi.mock('../middleware/auth', () => ({
    authenticate: vi.fn((_req: any, _res: any, next: any) => next()),
    requireRole: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));
vi.mock('../services/buildCache.service', () => ({ BuildCacheService: { usage: vi.fn(), prune: vi.fn() } }));
vi.mock('../services/appSettings.service', () => ({
    AppSettingsService: { get: vi.fn(), update: vi.fn(), allowsPublicRegistration: vi.fn() },
}));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({ default: { readFile: readFileMock }, readFile: readFileMock }));

import systemRoutes from '../routes/system.routes';
import { UpdateService } from '../services/update.service';
import { errorHandler } from '../middleware/errorHandler';
import { AppError } from '../middleware/errorHandler';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/system', systemRoutes);
    app.use(errorHandler);
    return app;
}

const STATUS = {
    current: 'aaa1111', behind: 2,
    commits: [{ sha: 'bbb2222', subject: 'feat: x' }],
    checkedAt: '2026-08-05T10:00:00.000Z', error: null,
    state: { phase: 'idle', prevCommit: null, newCommit: null, startedAt: null, finishedAt: null, error: null },
};

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/system/update', () => {
    it('returns the merged status', async () => {
        vi.mocked(UpdateService.status).mockResolvedValue(STATUS as any);

        const res = await request(makeApp()).get('/api/system/update').expect(200);

        expect(res.body.behind).toBe(2);
        expect(res.body.state.phase).toBe('idle');
    });
});

describe('POST /api/system/update/check', () => {
    it('forces a fresh check', async () => {
        vi.mocked(UpdateService.check).mockResolvedValue(STATUS as any);
        vi.mocked(UpdateService.status).mockResolvedValue(STATUS as any);

        await request(makeApp()).post('/api/system/update/check').expect(200);

        expect(UpdateService.check).toHaveBeenCalledWith(true);
    });
});

describe('POST /api/system/update', () => {
    it('starts an update and reports the new status', async () => {
        vi.mocked(UpdateService.start).mockResolvedValue(undefined);
        vi.mocked(UpdateService.status).mockResolvedValue(STATUS as any);

        await request(makeApp()).post('/api/system/update').expect(202);

        expect(UpdateService.start).toHaveBeenCalled();
    });

    it('surfaces a 409 when an update is already running', async () => {
        vi.mocked(UpdateService.start).mockRejectedValue(new AppError('An update is already in progress', 409));

        const res = await request(makeApp()).post('/api/system/update').expect(409);

        expect(res.body.error).toMatch(/already in progress/i);
    });

    it('surfaces a 400 when there is nothing to update', async () => {
        vi.mocked(UpdateService.start).mockRejectedValue(new AppError('Already up to date', 400));

        await request(makeApp()).post('/api/system/update').expect(400);
    });
});

describe('GET /api/system/update/log', () => {
    it('returns the log contents', async () => {
        readFileMock.mockResolvedValue('line one\nline two');

        const res = await request(makeApp()).get('/api/system/update/log').expect(200);

        expect(res.body.log).toContain('line two');
    });

    // Before the first update there is no log; that is not an error.
    it('returns an empty log when the file does not exist', async () => {
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        readFileMock.mockRejectedValue(err);

        const res = await request(makeApp()).get('/api/system/update/log').expect(200);

        expect(res.body.log).toBe('');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root server src/__tests__/update.routes.test.ts`
Expected: FAIL — 404s, because the routes do not exist.

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/system.routes.ts`, add to the imports:

```typescript
import fs from 'fs/promises';
import { UpdateService, UPDATE_LOG_PATH } from '../services/update.service';
```

Insert this block immediately before the `// ── Self-service registration gate ──` section:

```typescript
// ── Self-update ──

router.get('/update', async (_req, res, next: NextFunction) => {
    try {
        res.json(await UpdateService.status());
    } catch (error) {
        next(error);
    }
});

// Bypasses the hourly cache so an urgent update does not wait for the timer.
router.post('/update/check', async (_req, res, next: NextFunction) => {
    try {
        await UpdateService.check(true);
        res.json(await UpdateService.status());
    } catch (error) {
        next(error);
    }
});

router.post('/update', async (_req, res, next: NextFunction) => {
    try {
        await UpdateService.start();
        // 202: the updater runs in its own unit and outlives this request —
        // and this process is about to be restarted by it.
        res.status(202).json(await UpdateService.status());
    } catch (error) {
        next(error);
    }
});

router.get('/update/log', async (_req, res, next: NextFunction) => {
    try {
        const log = await fs.readFile(UPDATE_LOG_PATH, 'utf-8').catch(() => '');
        res.json({ log });
    } catch (error) {
        next(error);
    }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root server src/__tests__/update.routes.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/system.routes.ts server/src/__tests__/update.routes.test.ts
git commit -m "feat: add self-update API endpoints"
```

---

### Task 6: Hourly background check

**Files:**
- Modify: `server/src/services/update.service.ts`
- Modify: `server/src/index.ts:254`
- Test: `server/src/services/__tests__/update.service.test.ts`

**Interfaces:**
- Consumes: `UpdateService.check` from Task 1.
- Produces: `UpdateService.startPolling(): void`, `UpdateService.stopPolling(): void`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/__tests__/update.service.test.ts`:

```typescript
describe('UpdateService polling', () => {
    it('checks on the hour and can be stopped', async () => {
        vi.useFakeTimers();
        queueExec(Array(12).fill({ stdout: '0\n' }));

        UpdateService.startPolling();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        const afterOne = execFileMock.mock.calls.length;
        UpdateService.stopPolling();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        expect(afterOne).toBeGreaterThan(0);
        expect(execFileMock.mock.calls.length).toBe(afterOne);
        vi.useRealTimers();
    });

    it('is idempotent — calling start twice does not double the timer', () => {
        vi.useFakeTimers();

        UpdateService.startPolling();
        UpdateService.startPolling();
        UpdateService.stopPolling();

        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root server src/services/__tests__/update.service.test.ts`
Expected: FAIL — `UpdateService.startPolling is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add near the other constants in `server/src/services/update.service.ts`:

```typescript
const POLL_INTERVAL_MS = 60 * 60 * 1000;
```

Add to `class UpdateService` (alongside the existing private statics):

```typescript
    private static timer: NodeJS.Timeout | null = null;

    static startPolling(): void {
        if (UpdateService.timer) return;
        UpdateService.timer = setInterval(() => {
            UpdateService.check(true).catch(err =>
                console.error('Update check failed:', err?.message || err)
            );
        }, POLL_INTERVAL_MS);
        // Never keep the process alive just for this.
        UpdateService.timer.unref?.();
        console.log('⬆️  Update checker started (interval: 60m)');
    }

    static stopPolling(): void {
        if (UpdateService.timer) {
            clearInterval(UpdateService.timer);
            UpdateService.timer = null;
        }
    }
```

Also add `UpdateService.stopPolling();` to the body of `resetForTests()` so timers do not leak between tests.

- [ ] **Step 4: Wire it into bootstrap**

In `server/src/index.ts`, add the import alongside the other service imports:

```typescript
import { UpdateService } from './services/update.service';
```

At line 254, immediately after `HealthMonitorService.start();`, add:

```typescript
    UpdateService.startPolling();
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run --root server && cd server && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/update.service.ts server/src/services/__tests__/update.service.test.ts server/src/index.ts
git commit -m "feat: check for updates hourly in the background"
```

---

### Task 7: Admin UI

**Files:**
- Modify: `client/src/api/system.ts`
- Modify: `client/src/pages/Admin.tsx`

**Interfaces:**
- Consumes: the four endpoints from Task 5.
- Produces: a "System — Updates" card in the Admin page.

- [ ] **Step 1: Add the API client methods**

In `client/src/api/system.ts`, add these types above the `systemApi` object:

```typescript
export interface UpdateCommit { sha: string; subject: string; }

export interface UpdateStatus {
    current: string;
    behind: number;
    commits: UpdateCommit[];
    checkedAt: string;
    error: string | null;
    state: {
        phase: string;
        prevCommit: string | null;
        newCommit: string | null;
        startedAt: string | null;
        finishedAt: string | null;
        error: string | null;
    };
}
```

Add these methods inside `systemApi`, next to `getRegistration`:

```typescript
    getUpdate: () => api.get<UpdateStatus>('/system/update'),
    checkUpdate: () => api.post<UpdateStatus>('/system/update/check'),
    startUpdate: () => api.post<UpdateStatus>('/system/update'),
    getUpdateLog: () => api.get<{ log: string }>('/system/update/log'),
```

- [ ] **Step 2: Add state and handlers to Admin.tsx**

In `client/src/pages/Admin.tsx`, add `RefreshCw` and `Download` to the existing `lucide-react` import, and `UpdateStatus` to the `../api/system` type import.

Add this state next to the registration state:

```typescript
    // Self-update
    const [update, setUpdate] = useState<UpdateStatus | null>(null);
    const [updateLog, setUpdateLog] = useState('');
    const [checking, setChecking] = useState(false);
    const [starting, setStarting] = useState(false);
    const [updateError, setUpdateError] = useState('');
```

Add this constant at **module scope**, next to the existing `DEFAULT_PERMISSIONS` above `export default function Admin()` — not inside the component, so its identity is stable across renders:

```typescript
const RUNNING_PHASES = ['pulling', 'installing', 'building', 'syncing', 'restarting', 'verifying', 'rolling_back'];
```

Add these handlers next to `fetchRegistration`:

```typescript
    const fetchUpdate = async () => {
        try {
            const { data } = await systemApi.getUpdate();
            setUpdate(data);
        } catch (err: any) {
            setUpdateError(err.response?.data?.error || 'Failed to load update status');
        }
    };

    const handleCheckUpdate = async () => {
        try {
            setChecking(true);
            setUpdateError('');
            const { data } = await systemApi.checkUpdate();
            setUpdate(data);
        } catch (err: any) {
            setUpdateError(err.response?.data?.error || 'Check failed');
        } finally {
            setChecking(false);
        }
    };

    const handleStartUpdate = async () => {
        try {
            setStarting(true);
            setUpdateError('');
            const { data } = await systemApi.startUpdate();
            setUpdate(data);
        } catch (err: any) {
            setUpdateError(err.response?.data?.error || 'Could not start the update');
            setStarting(false);
        }
    };
```

Add this effect after the existing `useEffect`:

```typescript
    // While an update runs the API restarts, so requests will fail for a
    // stretch. That is expected — keep polling rather than surfacing it as an
    // error, and stop only once the phase is terminal.
    useEffect(() => {
        const phase = update?.state.phase;
        if (!phase || !RUNNING_PHASES.includes(phase)) {
            setStarting(false);
            return;
        }
        const timer = setInterval(() => {
            systemApi.getUpdate().then(({ data }) => setUpdate(data)).catch(() => { });
            systemApi.getUpdateLog().then(({ data }) => setUpdateLog(data.log)).catch(() => { });
        }, 2000);
        return () => clearInterval(timer);
    }, [update?.state.phase]);
```

Add `fetchUpdate();` to the body of the existing mount `useEffect`, next to `fetchRegistration();`.

- [ ] **Step 3: Add the card markup**

In `client/src/pages/Admin.tsx`, insert this immediately before the `System — Registration` card:

```tsx
                <div className="glass" style={{ padding: 24, borderRadius: 12, marginTop: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                        <Download size={20} className="text-primary" />
                        <h2 style={{ margin: 0 }}>System — Updates</h2>
                        {update && update.behind > 0 && (
                            <span className="badge" style={{ background: 'var(--accent)', color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>
                                {update.behind} available
                            </span>
                        )}
                    </div>

                    {updateError && <div className="alert alert-error">{updateError}</div>}
                    {update?.error && <div className="alert alert-error">Last check failed: {update.error}</div>}

                    {update ? (
                        <>
                            <p style={{ marginBottom: 12 }}>
                                Running <strong>{update.current || 'unknown'}</strong>
                                {update.checkedAt && (
                                    <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
                                        {' '}· checked {new Date(update.checkedAt).toLocaleString()}
                                    </span>
                                )}
                            </p>

                            {update.behind > 0 && (
                                <ul style={{ marginBottom: 16, paddingLeft: 20, color: 'var(--text-secondary)', fontSize: 14 }}>
                                    {update.commits.map(c => (
                                        <li key={c.sha}><code>{c.sha}</code> {c.subject}</li>
                                    ))}
                                </ul>
                            )}

                            {RUNNING_PHASES.includes(update.state.phase) && (
                                <div className="alert alert-info">
                                    Updating — phase: <strong>{update.state.phase}</strong>. The portal will be
                                    briefly unavailable while the service restarts.
                                </div>
                            )}
                            {update.state.phase === 'failed' && (
                                <div className="alert alert-error">
                                    Update failed and was rolled back to {update.state.prevCommit}: {update.state.error}
                                </div>
                            )}
                            {update.state.phase === 'failed_rollback' && (
                                <div className="alert alert-error">
                                    Update failed AND rollback failed: {update.state.error}. This instance needs
                                    attention on the server.
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                <button className="btn btn-secondary" onClick={handleCheckUpdate} disabled={checking}>
                                    <RefreshCw size={16} /> {checking ? 'Checking…' : 'Check now'}
                                </button>
                                <button
                                    className="btn btn-primary"
                                    onClick={handleStartUpdate}
                                    disabled={starting || update.behind === 0 || RUNNING_PHASES.includes(update.state.phase)}
                                >
                                    {starting ? 'Starting…' : 'Update now'}
                                </button>
                            </div>

                            {updateLog && (
                                <pre style={{ marginTop: 16, maxHeight: 260, overflow: 'auto', fontSize: 12, background: 'rgba(0,0,0,0.3)', padding: 12, borderRadius: 8 }}>
                                    {updateLog}
                                </pre>
                            )}
                        </>
                    ) : !updateError && (
                        <p style={{ color: 'var(--text-secondary)' }}>Loading update status…</p>
                    )}
                </div>
```

- [ ] **Step 4: Typecheck and build**

Run: `cd client && npx tsc --noEmit && cd .. && npm run build --workspace=client`
Expected: no type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/api/system.ts client/src/pages/Admin.tsx
git commit -m "feat: add self-update card to the admin page"
```

---

### Task 8: Full verification

**Files:** none — this task only runs things.

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run --root server`
Expected: all tests PASS, including the pre-existing 214.

- [ ] **Step 2: Typecheck and build both workspaces**

Run: `cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit && cd .. && npm run build`
Expected: clean.

- [ ] **Step 3: Dry-run the updater once more against the built tree**

```bash
INSTALL_DIR=$(pwd) STATE_DIR=/tmp/runnable-update-test ./update.sh --dry-run
grep '"phase"' /tmp/runnable-update-test/update-state.json
```

Expected: `"phase": "done"`.

- [ ] **Step 4: Commit any remaining changes**

```bash
git status --short
```

Expected: clean tree. If not, review and commit.

---

## Deployment note

The first release *containing* this feature must still be deployed with
`./deploy.sh` on each host — the button only exists from the next update
onward. Verify on one instance before relying on it:

1. Deploy normally, open Admin → System — Updates, confirm it reports the
   current commit and "checked just now".
2. Push a trivial commit, click **Check now**, confirm it appears.
3. Click **Update now** and watch it through `verifying` to `done`.
