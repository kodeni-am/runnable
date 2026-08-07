import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const renameMock = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({
    default: { readFile: readFileMock, writeFile: writeFileMock, rename: renameMock },
    readFile: readFileMock,
    writeFile: writeFileMock,
    rename: renameMock,
}));

vi.mock('../../config', () => ({
    config: { port: 3001, host: '127.0.0.1', webDir: '/var/www/runnable', hosting: { servDir: '/var/runnable/projects' } },
}));

import path from 'path';
import {
    parseCommitLog, healthUrlFor, UpdateService,
    REPO_ROOT, STATE_DIR, UPDATE_STATE_PATH, STALE_CLAIM_MS,
} from '../update.service';

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
    readFileMock.mockReset();
    writeFileMock.mockReset();
    renameMock.mockReset();
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

describe('healthUrlFor', () => {
    it('uses a normal host as-is', () => {
        expect(healthUrlFor('127.0.0.1', 3001)).toBe('http://127.0.0.1:3001/api/health');
        expect(healthUrlFor('10.0.0.5', 8080)).toBe('http://10.0.0.5:8080/api/health');
    });

    it('falls back to loopback for a wildcard bind address', () => {
        expect(healthUrlFor('0.0.0.0', 3001)).toBe('http://127.0.0.1:3001/api/health');
        expect(healthUrlFor('::', 3001)).toBe('http://127.0.0.1:3001/api/health');
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

    // An unreachable origin must not block GET /api/system/update forever —
    // git's own TCP connect timeout has no cap otherwise.
    it('caps every git call with a 60s timeout', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '0\n' }, { stdout: '' }]);

        await UpdateService.check();

        const gitCalls = execFileMock.mock.calls.filter((c: any[]) => c[0] === 'git');
        expect(gitCalls.length).toBeGreaterThan(0);
        for (const call of gitCalls) {
            expect(call[2]).toMatchObject({ timeout: 60_000 });
        }
    });

    // A forced check (e.g. "Check now") that fails must not be the only place
    // the failure is visible — an unforced GET /api/system/update polled later
    // (with origin still unreachable) must keep reporting it too, otherwise an
    // admin can believe checking is healthy for weeks while it silently fails.
    it('keeps reporting a persistent fetch failure on a later unforced check', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '2\n' }, { stdout: 'bbb2222 feat: x' },
        ]);
        await UpdateService.check();

        queueExec([{ error: 'could not resolve host github.com' }]);
        const forced = await UpdateService.check(true);
        expect(forced.error).toMatch(/could not resolve host/);
        const callsBeforeUnforced = execFileMock.mock.calls.length;

        const unforced = await UpdateService.check();

        expect(unforced.error).toMatch(/could not resolve host/);
        expect(unforced.behind).toBe(2);       // stale but true
        expect(unforced.commits).toHaveLength(1);
        // No extra git calls — the unforced call must be served from cache.
        expect(execFileMock.mock.calls.length).toBe(callsBeforeUnforced);
    });
});

describe('UpdateService.readState', () => {
    it('reads a well-formed state file', async () => {
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt: new Date(Date.now() - 60 * 1000).toISOString(), finishedAt: null, error: null,
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

    // A killed updater (SIGKILL, OOM, power loss) can never trap and write a
    // terminal phase. Past STALE_CLAIM_MS, a non-terminal claim must be
    // declared dead so start() can proceed without someone SSHing in.
    it('reports a stale non-terminal claim as failed', async () => {
        const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt, finishedAt: null, error: null,
        }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('failed');
        expect(state.error).toMatch(/stopped reporting/i);
        // readState must stay a pure read — the updater may still own the file.
        expect(writeFileMock).not.toHaveBeenCalled();
        expect(renameMock).not.toHaveBeenCalled();
    });

    it('preserves prevCommit and newCommit on a stale claim', async () => {
        const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt, finishedAt: null, error: null,
        }));

        const state = await UpdateService.readState();

        expect(state.prevCommit).toBe('aaa1111');
        expect(state.newCommit).toBe('bbb2222');
    });

    it('leaves a recent non-terminal claim untouched — a running update must not be declared dead', async () => {
        const startedAt = new Date(Date.now() - 60 * 1000).toISOString();
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt, finishedAt: null, error: null,
        }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('building');
    });

    it('treats a missing startedAt on a non-terminal phase as stale', async () => {
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt: null, finishedAt: null, error: null,
        }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('failed');
    });

    it('treats an unparseable startedAt on a non-terminal phase as stale', async () => {
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt: 'not-a-date', finishedAt: null, error: null,
        }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('failed');
    });

    it('never rewrites an old terminal "done" phase — a finished update stays finished', async () => {
        const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'done', prevCommit: 'aaa1111', newCommit: 'bbb2222',
            startedAt, finishedAt: startedAt, error: null,
        }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('done');
    });

    it('never rewrites an old terminal "failed" phase', async () => {
        const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'failed', prevCommit: 'aaa1111', newCommit: null,
            startedAt, finishedAt: startedAt, error: 'boom',
        }));

        const state = await UpdateService.readState();

        expect(state.phase).toBe('failed');
    });

    it('exports the stale-claim threshold as 60 minutes', () => {
        expect(STALE_CLAIM_MS).toBe(60 * 60 * 1000);
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

describe('UpdateService.start', () => {
    // Happy path: clean tree, 1 behind, nothing running.
    function queueHappyPreflight() {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }, // check
            { stdout: '' },   // status --porcelain (clean)
            { stdout: '' },   // install -m700
            { stdout: '' },   // mv -f
            { stdout: '' },   // systemd-run
        ]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));
        writeFileMock.mockResolvedValue(undefined);
        renameMock.mockResolvedValue(undefined);
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
        // Must be capped at STALE_CLAIM_MS so a hung unit can never outlive
        // the staleness window (otherwise start() would relaunch on top of it).
        expect(args).toContain(`--property=RuntimeMaxSec=${STALE_CLAIM_MS / 1000}`);
        // The script is copied out of the repo, so it cannot infer these itself.
        expect(args).toContain(`--setenv=INSTALL_DIR=${REPO_ROOT}`);
        expect(args).toContain(`--setenv=STATE_DIR=${STATE_DIR}`);
        expect(args).toContain('--setenv=HEALTH_URL=http://127.0.0.1:3001/api/health');
        expect(args).toContain('--setenv=WEB_DIR=/var/www/runnable');
        expect(args[args.length - 1]).toBe('/run/runnable-update.sh');
    });

    it('copies the script out of the repo before running it', async () => {
        queueHappyPreflight();

        await UpdateService.start();

        const install = execFileMock.mock.calls.find((c: any[]) => c[0] === 'install')!;
        const installIdx = execFileMock.mock.calls.findIndex((c: any[]) => c[0] === 'install');
        const mvIdx = execFileMock.mock.calls.findIndex((c: any[]) => c[0] === 'mv');
        const systemdIdx = execFileMock.mock.calls.findIndex((c: any[]) => c[0] === 'systemd-run');

        // Source is exactly the repo update.sh (from repo root, not /run)
        expect(install[1][1]).toBe(path.join(REPO_ROOT, 'update.sh'));
        expect(install[1][2]).toBe('/run/runnable-update.sh.tmp');

        // install -> mv -> systemd-run ordering
        expect(installIdx).toBeLessThan(mvIdx);
        expect(mvIdx).toBeLessThan(systemdIdx);
    });

    it('claims the state before launching (prevents concurrent starts)', async () => {
        queueHappyPreflight();

        await UpdateService.start();

        // Verify state file is claimed: writeFile called with .tmp, content has phase: pulling
        const writeCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith('.tmp'));
        expect(writeCall).toBeDefined();
        expect(writeCall![0]).toBe(`${UPDATE_STATE_PATH}.tmp`);
        const writtenContent = JSON.parse(writeCall![1]);
        expect(writtenContent.phase).toBe('pulling');
        expect(writtenContent.prevCommit).toBe('aaa1111');

        // Verify rename to final path
        const renameCall = renameMock.mock.calls.find((c: any[]) => c[1] === UPDATE_STATE_PATH);
        expect(renameCall).toBeDefined();
        expect(renameCall![0]).toBe(`${UPDATE_STATE_PATH}.tmp`);

        // Verify state claim happens before systemd-run
        const writeIdx = writeFileMock.mock.invocationCallOrder[0];
        const systemdIdx = execFileMock.mock.calls.findIndex((c: any[]) => c[0] === 'systemd-run');
        const systemdCallOrder = execFileMock.mock.invocationCallOrder[systemdIdx];
        expect(writeIdx).toBeLessThan(systemdCallOrder);
    });

    it('returns 409 when systemd-run fails with unit already exists', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' },
            { stdout: '' },   // status --porcelain
            { stdout: '' },   // install
            { stdout: '' },   // mv
            { error: 'Unit runnable-update.service already exists' }, // systemd-run fails
        ]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));
        writeFileMock.mockResolvedValue(undefined);
        renameMock.mockResolvedValue(undefined);

        await expect(UpdateService.start()).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringMatching(/already/i),
        });
    });

    it('does not touch state when unit already exists (another updater owns it)', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' },
            { stdout: '' },   // status --porcelain
            { stdout: '' },   // install
            { stdout: '' },   // mv
            { error: 'Unit runnable-update.service already exists' }, // systemd-run fails
        ]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));
        writeFileMock.mockResolvedValue(undefined);
        renameMock.mockResolvedValue(undefined);

        try {
            await UpdateService.start();
        } catch {
            // Expected to throw
        }

        // Count write/rename calls: one for claim, none for error handling
        const writeCalls = writeFileMock.mock.calls.length;
        const renameCalls = renameMock.mock.calls.length;
        expect(writeCalls).toBe(1); // Only the initial claim
        expect(renameCalls).toBe(1); // Only the initial claim
    });

    it('reverts state to failed when launch fails (non-collision)', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' },
            { stdout: '' },   // status --porcelain
            { stdout: '' },   // install
            { error: 'Permission denied' }, // mv fails
        ]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));
        writeFileMock.mockResolvedValue(undefined);
        renameMock.mockResolvedValue(undefined);

        await expect(UpdateService.start()).rejects.toMatchObject({
            statusCode: 500,
            message: expect.stringMatching(/Permission denied/),
        });

        // Verify state was reverted to failed: should have 2 writes (claim + revert)
        const writeCalls = writeFileMock.mock.calls;
        expect(writeCalls.length).toBe(2);

        const revertedContent = JSON.parse(writeCalls[1][1]);
        expect(revertedContent.phase).toBe('failed');
        expect(revertedContent.error).toMatch(/Permission denied/);
        expect(revertedContent.finishedAt).toBeDefined();
    });

    it('refuses when an update is already running', async () => {
        queueExec([{ stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }]);
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', startedAt: new Date(Date.now() - 60 * 1000).toISOString(),
        }));

        await expect(UpdateService.start()).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringMatching(/already/i),
        });
    });

    // The whole point of the staleness rule: a killed updater must not wedge
    // the instance forever. A claim that went stale (readState reports it as
    // failed) must let start() proceed exactly like the normal happy path.
    it('proceeds when the existing claim has gone stale (heals a killed updater)', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }, // check
            { stdout: '' },   // status --porcelain (clean)
            { stdout: '' },   // install -m700
            { stdout: '' },   // mv -f
            { stdout: '' },   // systemd-run
        ]);
        const staleStartedAt = new Date(Date.now() - (STALE_CLAIM_MS + 60 * 1000)).toISOString();
        readFileMock.mockResolvedValue(JSON.stringify({
            phase: 'building', prevCommit: 'old0000', newCommit: null,
            startedAt: staleStartedAt, finishedAt: null, error: null,
        }));
        writeFileMock.mockResolvedValue(undefined);
        renameMock.mockResolvedValue(undefined);

        await expect(UpdateService.start()).resolves.toBeUndefined();

        // Reaches the same launch as the happy path.
        const files = execFileMock.mock.calls.map((c: any[]) => c[0]);
        expect(files).toContain('systemd-run');

        // Writes a fresh claim, not the stale one.
        const writeCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith('.tmp'));
        expect(writeCall).toBeDefined();
        const writtenContent = JSON.parse(writeCall![1]);
        expect(writtenContent.phase).toBe('pulling');
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

        // The preflight must ignore untracked files (-uno) — only a tracked-file
        // change is a real "uncommitted changes" refusal.
        const statusCall = execFileMock.mock.calls.find((c: any[]) => c[0] === 'git' && c[1][0] === 'status');
        expect(statusCall![1]).toEqual(['status', '--porcelain', '-uno']);
    });

    // An orphaned untracked file (e.g. a failed upload under ./storage/, which
    // is not gitignored the way server/storage/ is) must not permanently
    // disable self-update. `git status --porcelain -uno` reports nothing for
    // untracked-only trees, so the preflight must let the update proceed.
    it('does not refuse when only untracked files are present', async () => {
        queueExec([
            { stdout: '' }, { stdout: 'aaa1111\n' }, { stdout: '1\n' }, { stdout: 'bbb2222 feat: x' }, // check
            { stdout: '' },   // status --porcelain -uno (untracked files ignored -> clean)
            { stdout: '' },   // install -m700
            { stdout: '' },   // mv -f
            { stdout: '' },   // systemd-run
        ]);
        readFileMock.mockResolvedValue(JSON.stringify({ phase: 'done' }));
        writeFileMock.mockResolvedValue(undefined);
        renameMock.mockResolvedValue(undefined);

        await expect(UpdateService.start()).resolves.toBeUndefined();

        const files = execFileMock.mock.calls.map((c: any[]) => c[0]);
        expect(files).toContain('systemd-run');
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
