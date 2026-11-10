import type { CustomDomain, Project } from '../entities';
import type { ServerConfigOptions } from './serverConfig.service';
import { defaultCertCheckDeps, wildcardCertProblem, type CertCheckDeps } from './certCheck';

/**
 * Build the options for ServerConfigService.generateConfig from a project and
 * its custom domains. A wildcard domain carries a supplied certificate; unless
 * it would load in Caddy (parses, key matches, unexpired, covers the apex,
 * readable by the caddy user) the wildcard is dropped with a warning, because
 * Caddy reloads are global and one bad cert would fail every later reload.
 */
export async function buildProxyOptions(
    project: Pick<Project, 'subdomain' | 'directoryPath' | 'serverType' | 'port' | 'baseDomain' | 'isPreview'>,
    domains: Pick<CustomDomain, 'domain' | 'redirectTarget' | 'tlsCertPath' | 'tlsKeyPath'>[] | undefined,
    overrides: { port?: number } = {},
    certDeps: CertCheckDeps = defaultCertCheckDeps,
): Promise<ServerConfigOptions> {
    const customDomains: NonNullable<ServerConfigOptions['customDomains']> = [];
    for (const d of domains || []) {
        if (!d.tlsCertPath && !d.tlsKeyPath && !d.domain.startsWith('*.')) {
            customDomains.push({ domain: d.domain, redirectTarget: d.redirectTarget || null });
            continue;
        }
        const cert = d.tlsCertPath;
        const key = d.tlsKeyPath;
        const problem = typeof cert !== 'string' || typeof key !== 'string'
            ? 'certificate or key path missing'
            : await wildcardCertProblem(d.domain, cert, key, certDeps);
        if (problem) {
            console.warn(`Skipping wildcard domain ${d.domain}: ${problem}`);
            continue;
        }
        customDomains.push({ domain: d.domain, redirectTarget: null, tls: { cert: cert as string, key: key as string } });
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
