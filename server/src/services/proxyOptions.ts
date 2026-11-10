import fs from 'fs';
import type { CustomDomain, Project } from '../entities';
import type { ServerConfigOptions } from './serverConfig.service';

/**
 * Build the options for ServerConfigService.generateConfig from a project and
 * its custom domains. A wildcard domain carries a supplied certificate; if the
 * cert or key is unreadable the wildcard is dropped with a warning, so one bad
 * path cannot make every later Caddy reload fail.
 */
export async function buildProxyOptions(
    project: Pick<Project, 'subdomain' | 'directoryPath' | 'serverType' | 'port' | 'baseDomain' | 'isPreview'>,
    domains: Pick<CustomDomain, 'domain' | 'redirectTarget' | 'tlsCertPath' | 'tlsKeyPath'>[] | undefined,
    overrides: { port?: number } = {},
): Promise<ServerConfigOptions> {
    const customDomains: NonNullable<ServerConfigOptions['customDomains']> = [];
    for (const d of domains || []) {
        if (!d.tlsCertPath && !d.tlsKeyPath && !d.domain.startsWith('*.')) {
            customDomains.push({ domain: d.domain, redirectTarget: d.redirectTarget || null });
            continue;
        }
        const cert = d.tlsCertPath;
        const key = d.tlsKeyPath;
        try {
            if (typeof cert !== 'string' || typeof key !== 'string') throw new Error('certificate or key path missing');
            await fs.promises.access(cert, fs.constants.R_OK);
            await fs.promises.access(key, fs.constants.R_OK);
        } catch (err: any) {
            console.warn(`Skipping wildcard domain ${d.domain}: certificate or key unreadable (${err?.message || err})`);
            continue;
        }
        customDomains.push({ domain: d.domain, redirectTarget: null, tls: { cert, key } });
    }
    return {
        subdomain: project.subdomain,
        directoryPath: project.directoryPath,
        port: overrides.port ?? project.port ?? 8080,
        serverType: project.serverType,
        customDomains,
        baseDomain: project.baseDomain || undefined,
        onDemandTls: project.isPreview === true,
    };
}
