import { describe, it, expect } from 'vitest';
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
