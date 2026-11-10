import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { buildProxyOptions } from '../proxyOptions';
import { defaultCertCheckDeps, type CertCheckDeps } from '../certCheck';
import { ServerConfigService } from '../serverConfig.service';
import { ServerType } from '../../entities';

// Self-signed test-only fixture for *.example.com (see certCheck.test.ts).
const FIX = path.join(__dirname, 'fixtures', 'certs');
const CERT = path.join(FIX, 'wildcard-example.pem');
const KEY = path.join(FIX, 'wildcard-example.key');
const noCaddy: CertCheckDeps = { ...defaultCertCheckDeps, readPasswd: async () => null, readGroup: async () => null };

const project = { subdomain: 'ex', directoryPath: '/srv/ex', serverType: ServerType.APP, port: 4100 } as any;
const row = (domain: string, verified: boolean, redirectTarget: string | null = null) =>
    ({ domain, verified, redirectTarget, tlsCertPath: null, tlsKeyPath: null });
const wildcard = (verified: boolean) =>
    ({ domain: '*.example.com', verified, redirectTarget: null, tlsCertPath: CERT, tlsKeyPath: KEY });

async function caddyFor(domains: any[]): Promise<string> {
    return ServerConfigService.generateConfig(await buildProxyOptions(project, domains, {}, noCaddy));
}

afterEach(() => vi.restoreAllMocks());

describe('buildProxyOptions — verified gate for regular domains', () => {
    it('leaves an unverified regular domain out of the generated config', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = await caddyFor([row('pending.example.org', false)]);
        expect(out).not.toContain('pending.example.org');
        expect(out).toContain('ex.');
    });

    it('leaves an unverified redirect domain out too', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = await caddyFor([row('www.example.org', false, 'example.org')]);
        expect(out).not.toContain('www.example.org');
        expect(out).not.toContain('redir');
    });

    it('emits a verified regular domain and a verified redirect domain', async () => {
        const out = await caddyFor([row('example.org', true), row('www.example.org', true, 'example.org')]);
        expect(out).toMatch(/^ex\.\S+, example\.org \{/m);
        expect(out).toContain('www.example.org {\n  redir https://example.org{uri}\n}');
    });

    it('keeps verified domains and drops only the unverified one', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const opts = await buildProxyOptions(project, [row('a.example.org', true), row('b.example.org', false)] as any, {}, noCaddy);
        expect(opts.customDomains).toEqual([{ domain: 'a.example.org', redirectTarget: null }]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('b.example.org'));
    });

    it('treats a missing verified flag as unverified', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const opts = await buildProxyOptions(project, [{ domain: 'x.example.org', redirectTarget: null }] as any, {}, noCaddy);
        expect(opts.customDomains).toEqual([]);
    });
});

describe('buildProxyOptions — wildcard behaviour unchanged', () => {
    it.each([true, false])('emits a wildcard with a valid certificate (verified=%s)', async (verified) => {
        const out = await caddyFor([wildcard(verified)]);
        expect(out).toContain(`*.example.com {\n  tls ${CERT} ${KEY}\n`);
    });

    it('still drops a wildcard whose certificate does not load', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const deps = { ...noCaddy, readFile: async () => 'garbage' };
        const opts = await buildProxyOptions(project, [wildcard(true)] as any, {}, deps);
        expect(opts.customDomains).toEqual([]);
    });
});
