import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

const getSettingsMock = vi.hoisted(() => vi.fn());
vi.mock('../appSettings.service', () => ({
    AppSettingsService: { get: getSettingsMock },
}));

import { BuildCacheService } from '../buildCache.service';

// promisify(execFile) calls execFile(file, args, opts, cb).
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

const dfJson = (size: string) =>
    `{"Type":"Images","Size":"2GB"}\n{"Type":"Build Cache","Size":"${size}"}\n`;
const buildctlDu = (size: string) => `ID\tRECLAIMABLE\tSIZE\nTotal:\t${size}\n`;
const UP = { stdout: 'Up 3 weeks' };

// Every prune() run issues: capped builder prune, buildkitUp, buildctl prune.
const CAPPED_PRUNE = [{ stdout: '' }, UP, { stdout: '' }];

/** Args of each `docker` invocation, joined for easy assertion. */
function calls(): string[] {
    return execFileMock.mock.calls.map((c: any[]) => (c[1] as string[]).join(' '));
}

beforeEach(() => {
    execFileMock.mockReset();
    getSettingsMock.mockReset();
    getSettingsMock.mockResolvedValue({ buildCacheKeepGB: 2 });
    // enforceCap dedupes concurrent runs via a static field; clear it.
    (BuildCacheService as any).inFlight = null;
});

describe('BuildCacheService.enforceCap', () => {
    it('escalates to a full prune when the capped prune leaves usage above the cap', async () => {
        // Docker 29.4.3 + containerd snapshotter: `--max-used-space 2GB`
        // exits 0 having freed nothing, because nearly every cache record is
        // shared and only the ~2GB unshared slice is measured against the cap.
        queueExec([
            ...CAPPED_PRUNE,
            // usage(): still 18.88GB on the daemon builder, 0 in the container
            { stdout: dfJson('18.88GB') }, UP, { stdout: buildctlDu('0B') },
            // escalation
            ...CAPPED_PRUNE,
        ]);

        await BuildCacheService.enforceCap();

        expect(calls()).toContain('builder prune -af');
    });

    it('does not escalate when the capped prune brought usage under the cap', async () => {
        queueExec([
            ...CAPPED_PRUNE,
            { stdout: dfJson('1.2GB') }, UP, { stdout: buildctlDu('0B') },
        ]);

        await BuildCacheService.enforceCap();

        expect(calls()).not.toContain('builder prune -af');
        expect(calls()).toContain('builder prune -f --max-used-space 2GB');
    });

    it('does not escalate when the cap is disabled (0 means no cap)', async () => {
        getSettingsMock.mockResolvedValue({ buildCacheKeepGB: 0 });
        queueExec([]);

        await BuildCacheService.enforceCap();

        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('counts the buildkit container cache toward the cap', async () => {
        // Daemon builder is clean but the railpack container holds 9GB.
        queueExec([
            ...CAPPED_PRUNE,
            { stdout: dfJson('0B') }, UP, { stdout: buildctlDu('9GB') },
            ...CAPPED_PRUNE,
        ]);

        await BuildCacheService.enforceCap();

        expect(calls()).toContain('builder prune -af');
    });

    it('never throws when the verification read fails', async () => {
        queueExec([
            ...CAPPED_PRUNE,
            { error: 'daemon unreachable' },
        ]);

        await expect(BuildCacheService.enforceCap()).resolves.toBeUndefined();
    });
});
