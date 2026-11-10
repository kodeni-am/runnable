import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import { buildProxyOptions } from '../proxyOptions';
import { ServerConfigService } from '../serverConfig.service';
import { ServerType } from '../../entities';

describe('generateConfig — preview (Caddy) options', () => {
    it('uses the baseDomain override and emits on-demand TLS', async () => {
        const out = await ServerConfigService.generateConfig({
            subdomain: 'pr-5-app-abc123',
            directoryPath: '/srv/x',
            port: 12345,
            serverType: ServerType.APP,
            baseDomain: 'preview.example.com',
            onDemandTls: true,
        });
        expect(out).toContain('pr-5-app-abc123.preview.example.com');
        expect(out).toMatch(/tls\s*\{\s*on_demand\s*\}/);
        expect(out).toContain('reverse_proxy localhost:12345');
    });

    it('does NOT emit on-demand TLS for a normal project', async () => {
        const out = await ServerConfigService.generateConfig({
            subdomain: 'app',
            directoryPath: '/srv/a',
            port: 8080,
            serverType: ServerType.APP,
        });
        expect(out).not.toContain('on_demand');
        expect(out).toContain('reverse_proxy localhost:8080');
    });

    it('rejects an invalid baseDomain', async () => {
        await expect(ServerConfigService.generateConfig({
            subdomain: 'app',
            directoryPath: '/srv/a',
            port: 8080,
            serverType: ServerType.APP,
            baseDomain: 'bad domain!',
        })).rejects.toThrow();
    });
});

describe('wildcard domains', () => {
    const CERT = '/etc/caddy/certs/moments.am.origin.pem';
    const KEY = '/etc/caddy/certs/moments.am.origin.key';
    const wildcard = { domain: '*.moments.am', redirectTarget: null, tls: { cert: CERT, key: KEY } };
    const base = { subdomain: 'moments', directoryPath: '/srv/m', port: 4100, serverType: ServerType.APP };
    const blocks = (out: string) => out.trim().split(/\n\n(?=\S)/);

    afterEach(() => vi.restoreAllMocks());

    it('emits a wildcard in its own site block with its certificate', async () => {
        const out = await ServerConfigService.generateConfig({
            ...base, customDomains: [{ domain: 'moments.am', redirectTarget: null }, wildcard],
        });
        const block = blocks(out).find(b => b.startsWith('*.moments.am {'))!;
        expect(block).toBeDefined();
        expect(block).toContain(`tls ${CERT} ${KEY}`);
        expect(block).toContain('reverse_proxy localhost:4100');
        expect(block).toContain('encode gzip zstd');
        expect(block).toContain('log {');
    });

    it('keeps the main block free of tls lines and of the wildcard', async () => {
        const out = await ServerConfigService.generateConfig({
            ...base, customDomains: [{ domain: 'moments.am', redirectTarget: null }, wildcard],
        });
        const main = blocks(out).find(b => !b.startsWith('*.moments.am'))!;
        expect(main.split('{')[0]).toContain('moments.am');
        expect(main.split('{')[0]).not.toContain('*.');
        expect(main).not.toMatch(/^\s*tls /m);
    });

    it('static projects get the same wildcard block shape', async () => {
        const out = await ServerConfigService.generateConfig({
            ...base, serverType: ServerType.STATIC, customDomains: [wildcard],
        });
        const block = blocks(out).find(b => b.startsWith('*.moments.am {'))!;
        expect(block).toContain(`tls ${CERT} ${KEY}`);
        expect(block).toContain('root * /srv/m');
        expect(block).toContain('file_server');
        expect(block).not.toContain('reverse_proxy');
    });

    it('refuses injection in cert paths', async () => {
        const bad = [
            '/etc/x{y.pem', '/etc/x}y.pem', '/etc/x;y.pem', '/etc/x\ny.pem', '/etc/x"y.pem',
            '/etc/caddy/../../shadow',
            ['/etc/ok.pem'] as any,
            42 as any,
        ];
        for (const cert of bad) {
            await expect(ServerConfigService.generateConfig({
                ...base, customDomains: [{ ...wildcard, tls: { cert, key: KEY } }],
            })).rejects.toThrow();
            await expect(ServerConfigService.generateConfig({
                ...base, customDomains: [{ ...wildcard, tls: { cert: CERT, key: cert } }],
            })).rejects.toThrow();
        }
    });

    it('skips a wildcard whose cert or key is unreadable', async () => {
        vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('ENOENT'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const opts = await buildProxyOptions(
            { subdomain: 'moments', directoryPath: '/srv/m', serverType: ServerType.APP, port: 4100 } as any,
            [{ domain: 'moments.am', redirectTarget: null }, { domain: '*.moments.am', redirectTarget: null, tlsCertPath: CERT, tlsKeyPath: KEY }] as any,
        );
        expect(warn).toHaveBeenCalled();
        const out = await ServerConfigService.generateConfig(opts);
        expect(out).not.toContain('*.moments.am');
        expect(out).toContain('moments.am {');
    });
});
