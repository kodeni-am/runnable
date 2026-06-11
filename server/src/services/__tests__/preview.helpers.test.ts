import { describe, it, expect } from 'vitest';
import {
    isForkPR,
    derivePreviewSubdomain,
    mergePreviewEnv,
    previewHostname,
    isPreviewExpired,
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
