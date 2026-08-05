import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({ default: { readFile: readFileMock }, readFile: readFileMock }));

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
