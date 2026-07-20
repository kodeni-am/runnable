import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateRegistryInput, serializeNpmRegistry } from '../routes/projects.routes';

describe('validateRegistryInput', () => {
    it('accepts an https url with no scope', () => {
        expect(validateRegistryInput('https://registry.npmjs.org/', undefined))
            .toEqual({ url: 'https://registry.npmjs.org/', scope: null });
    });

    it('accepts a valid scope', () => {
        expect(validateRegistryInput('https://npm.pkg.github.com/', '@acme'))
            .toEqual({ url: 'https://npm.pkg.github.com/', scope: '@acme' });
    });

    it('trims surrounding whitespace', () => {
        expect(validateRegistryInput('  https://registry.npmjs.org/  ', ' @acme '))
            .toEqual({ url: 'https://registry.npmjs.org/', scope: '@acme' });
    });

    it('rejects a non-http scheme', () => {
        expect(() => validateRegistryInput('ftp://registry.example.com/', null))
            .toThrow(/valid http/i);
    });

    it('rejects a non-absolute url', () => {
        expect(() => validateRegistryInput('registry.npmjs.org', null)).toThrow(/valid http/i);
        expect(() => validateRegistryInput('', null)).toThrow(/valid http/i);
    });

    it('rejects a scope without a leading @', () => {
        expect(() => validateRegistryInput('https://registry.npmjs.org/', 'acme'))
            .toThrow(/scope/i);
    });

    it('rejects a scope with illegal characters', () => {
        expect(() => validateRegistryInput('https://registry.npmjs.org/', '@ac me'))
            .toThrow(/scope/i);
        expect(() => validateRegistryInput('https://registry.npmjs.org/', '@AC/ME'))
            .toThrow(/scope/i);
    });
});

describe('serializeNpmRegistry', () => {
    it('reports configured when a url is set', () => {
        expect(serializeNpmRegistry({ npmRegistryUrl: 'https://r/', npmRegistryScope: '@a' } as any))
            .toEqual({ url: 'https://r/', scope: '@a', configured: true });
    });

    it('reports not configured when no url is set', () => {
        expect(serializeNpmRegistry({} as any))
            .toEqual({ url: null, scope: null, configured: false });
    });

    it('never includes the token', () => {
        const out: any = serializeNpmRegistry({
            npmRegistryUrl: 'https://r/',
            npmAuthTokenEncrypted: 'v1.a.b.c',
        } as any);
        expect(JSON.stringify(out)).not.toContain('v1.a.b.c');
        expect(out).not.toHaveProperty('npmAuthTokenEncrypted');
        expect(out).not.toHaveProperty('token');
    });
});
