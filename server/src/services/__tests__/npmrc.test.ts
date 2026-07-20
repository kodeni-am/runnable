import { describe, it, expect } from 'vitest';
import { buildNpmrcContent, maskToken, NPMRC_SENTINEL } from '../npmrc';

describe('buildNpmrcContent', () => {
    it('leads with the sentinel line, so a crashed build\'s leftover file is self-identifying', () => {
        const out = buildNpmrcContent('https://registry.npmjs.org/', null, 'tok123');
        expect(out.split('\n')[0]).toBe(NPMRC_SENTINEL);
    });

    it('makes the registry the default when no scope is given', () => {
        const out = buildNpmrcContent('https://registry.npmjs.org/', null, 'tok123');
        expect(out).toContain('registry=https://registry.npmjs.org/');
        expect(out).not.toContain('@');
        expect(out).toContain('//registry.npmjs.org/:_authToken=tok123');
    });

    it('scopes the registry when a scope is given', () => {
        const out = buildNpmrcContent('https://npm.pkg.github.com/', '@acme', 'tok123');
        expect(out).toContain('@acme:registry=https://npm.pkg.github.com/');
        expect(out).toContain('//npm.pkg.github.com/:_authToken=tok123');
    });

    it('keeps the path for registries served under a subpath', () => {
        const out = buildNpmrcContent('https://gitlab.com/api/v4/packages/npm/', '@grp', 'tok');
        expect(out).toContain('//gitlab.com/api/v4/packages/npm/:_authToken=tok');
    });

    it('normalizes a missing trailing slash', () => {
        const out = buildNpmrcContent('https://npm.pkg.github.com', '@acme', 'tok');
        expect(out).toContain('//npm.pkg.github.com/:_authToken=tok');
    });

    it('ends with a newline', () => {
        expect(buildNpmrcContent('https://registry.npmjs.org/', null, 't')).toMatch(/\n$/);
    });
});

describe('maskToken', () => {
    it('replaces every occurrence of the token', () => {
        const text = 'auth failed for tok123 (tok123)';
        expect(maskToken(text, 'tok123')).toBe('auth failed for *** (***)');
    });

    it('returns the text unchanged when the token is absent', () => {
        expect(maskToken('all good', 'tok123')).toBe('all good');
    });

    it('is a no-op for an empty token', () => {
        expect(maskToken('literally anything', '')).toBe('literally anything');
    });

    it('treats the token literally, not as a regex', () => {
        expect(maskToken('value a.c here', 'a.c')).toBe('value *** here');
        expect(maskToken('value abc here', 'a.c')).toBe('value abc here');
    });
});
