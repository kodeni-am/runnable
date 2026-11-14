import { describe, it, expect } from 'vitest';
import { capDeployLog, deployLogTail, deployLogOf, DeployError } from '../deployError';

describe('capDeployLog', () => {
    it('returns short logs untouched', () => {
        expect(capDeployLog('a\nb\n', 100)).toBe('a\nb\n');
    });

    it('keeps the tail on a line boundary and says it trimmed', () => {
        const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
        const capped = capDeployLog(log, 60);
        const lines = capped.split('\n');
        expect(lines[0]).toBe('… (earlier output trimmed)');
        expect(lines.at(-1)).toBe('line 99');
        // No partial first line survives the cut
        expect(lines.slice(1).every(l => /^line \d+$/.test(l))).toBe(true);
    });
});

describe('deployLogTail', () => {
    it('returns the last non-blank lines without the engine summary', () => {
        const log = 'step 1\n\nnpm ERR! missing script: build\n\n❌ Deploy failed: Railpack build failed\n✓ Previous version kept serving — visitors saw nothing.\n';
        expect(deployLogTail(log, 2)).toBe('step 1\nnpm ERR! missing script: build');
    });

    it('is empty when there is no log', () => {
        expect(deployLogTail(undefined)).toBe('');
    });
});

describe('deployLogOf', () => {
    it('reads the log attached to a deploy error', () => {
        const err: any = new DeployError('boom', true, 'blue-green');
        err.deployLog = 'the log';
        expect(deployLogOf(err)).toBe('the log');
    });

    it('is undefined for errors that never reached the build', () => {
        expect(deployLogOf(new Error('git fetch failed'))).toBeUndefined();
        expect(deployLogOf(undefined)).toBeUndefined();
    });
});
