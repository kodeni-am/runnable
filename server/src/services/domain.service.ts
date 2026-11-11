import dns from 'dns/promises';
import { ILike, IsNull, Not } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { CustomDomain, Project } from '../entities';
import { ServerConfigService } from './serverConfig.service';
import { ProcessService } from './process.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { buildProxyOptions } from './proxyOptions';

const DOMAIN_REGEX = /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const CERT_PATH_REGEX = /^\/[A-Za-z0-9._/-]+$/;

export function isWildcardDomain(domain: string): boolean {
    return domain.startsWith('*.');
}

/** `*.moments.am` -> `moments.am`. Returns non-wildcards unchanged. */
export function wildcardApex(domain: string): string {
    return isWildcardDomain(domain) ? domain.slice(2) : domain;
}

/** Whether a Caddy wildcard covers a host: exactly one extra label in front of the apex. */
export function wildcardCovers(wildcard: string, host: string): boolean {
    const apex = wildcardApex(wildcard);
    if (!isWildcardDomain(wildcard) || isWildcardDomain(host) || !host.endsWith(`.${apex}`)) return false;
    const label = host.slice(0, -(apex.length + 1));
    return label.length > 0 && !label.includes('.');
}

export interface AddDomainOptions {
    tlsCertPath?: string | null;
    tlsKeyPath?: string | null;
    redirectTarget?: string | null;
    isAdmin?: boolean;
}

export class DomainService {
    static async addDomain(
        projectId: string,
        rawDomain: string,
        options: AddDomainOptions = {},
    ): Promise<{ domain: CustomDomain; instructions: string }> {
        const domain = String(rawDomain).trim().toLowerCase();
        if (!DOMAIN_REGEX.test(domain)) {
            throw new AppError('Invalid domain format', 400);
        }

        const wildcard = isWildcardDomain(domain);
        const rawPaths: unknown[] = [options.tlsCertPath, options.tlsKeyPath];
        for (const p of rawPaths) {
            if (p && typeof p !== 'string') {
                throw new AppError('Certificate paths must be strings', 400);
            }
        }
        const tlsCertPath = options.tlsCertPath || null;
        const tlsKeyPath = options.tlsKeyPath || null;

        for (const p of [tlsCertPath, tlsKeyPath]) {
            if (p && (!CERT_PATH_REGEX.test(p) || p.split('/').includes('..'))) {
                throw new AppError('Certificate paths must be absolute, without .. segments, and contain only letters, digits, . _ - /', 400);
            }
        }
        if (!wildcard && (tlsCertPath || tlsKeyPath)) {
            throw new AppError('Certificate paths are only supported on wildcard domains', 400);
        }
        if (wildcard) {
            if (!options.isAdmin) {
                throw new AppError('Only admins can add wildcard domains', 403);
            }
            if (!tlsCertPath || !tlsKeyPath) {
                throw new AppError('Wildcard domains require both a certificate path and a key path', 400);
            }
            if (options.redirectTarget) {
                throw new AppError('Wildcard domains cannot have a redirect target', 400);
            }
            const apex = wildcardApex(domain);
            const covers = (base: string) => base === apex || base.endsWith(`.${apex}`);
            if (covers(config.hosting.baseDomain.toLowerCase())) {
                throw new AppError('Wildcard would cover the platform hosting domain', 400);
            }
            const previews = await AppDataSource.getRepository(Project).find({ where: { previewBaseDomain: Not(IsNull()) } });
            if (previews.some(p => p.previewBaseDomain && covers(p.previewBaseDomain.toLowerCase()))) {
                throw new AppError('Wildcard would cover a project preview domain', 400);
            }
        }

        const domainRepo = AppDataSource.getRepository(CustomDomain);

        // Check if domain already exists
        const existing = await domainRepo.findOne({ where: { domain } });
        if (existing) {
            throw new AppError('Domain is already in use', 409);
        }

        // Caddy prefers an exact site over a wildcard, so an exact domain under
        // another project's wildcard would take that host over.
        if (wildcard) {
            const apex = wildcardApex(domain);
            const under = await domainRepo.find({ where: { domain: ILike(`%.${apex}`) } });
            const taken = under.find(d => d.projectId !== projectId && wildcardCovers(domain, d.domain.toLowerCase()));
            if (taken) {
                throw new AppError(`${taken.domain} belongs to another project; remove it before adding ${domain}`, 400);
            }
        } else {
            const parentWildcard = `*.${domain.split('.').slice(1).join('.')}`;
            const owner = await domainRepo.findOne({ where: { domain: parentWildcard } });
            if (owner && owner.projectId !== projectId) {
                throw new AppError(`${domain} is covered by ${parentWildcard}, which belongs to another project`, 400);
            }
        }

        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({ where: { id: projectId } });
        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const customDomain = domainRepo.create({
            domain,
            projectId,
            verified: false,
            sslProvisioned: false,
            tlsCertPath,
            tlsKeyPath,
        });

        await domainRepo.save(customDomain);

        const targetCname = `${project.subdomain}.${config.hosting.baseDomain}`;
        const instructions = wildcard
            ? `Add a TXT record:\n  _runnable-verify.${wildcardApex(domain)} → ${project.id}`
            : `Add a CNAME record:\n  ${domain} → ${targetCname}\n\nOr add a TXT record:\n  _runnable-verify.${domain} → ${project.id}`;

        return { domain: customDomain, instructions };
    }

    static async verifyDomain(domainId: string, projectId: string): Promise<boolean> {
        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const customDomain = await domainRepo.findOne({
            where: { id: domainId, projectId },
            relations: { project: true },
        });

        if (!customDomain) {
            throw new AppError('Domain not found', 404);
        }

        const targetCname = `${customDomain.project.subdomain}.${config.hosting.baseDomain}`;

        if (!isWildcardDomain(customDomain.domain)) {
            try {
                // Try CNAME verification
                const cnameRecords = await dns.resolveCname(customDomain.domain);
                if (cnameRecords.some(r => r === targetCname)) {
                    customDomain.verified = true;
                    await domainRepo.save(customDomain);
                    // Regenerate config with new domain
                    await DomainService.regenerateProjectConfig(customDomain.project.id);
                    return true;
                }
            } catch {
                // CNAME lookup failed, try TXT verification
            }
        }

        try {
            // A wildcard has no CNAME of its own; its TXT record lives at the apex
            const txtRecords = await dns.resolveTxt(`_runnable-verify.${wildcardApex(customDomain.domain)}`);
            const flat = txtRecords.flat();
            if (flat.includes(customDomain.project.id)) {
                customDomain.verified = true;
                await domainRepo.save(customDomain);
                await DomainService.regenerateProjectConfig(customDomain.project.id);
                return true;
            }
        } catch {
            // TXT lookup also failed
        }

        return false;
    }

    static async removeDomain(domainId: string, projectId: string): Promise<void> {
        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const customDomain = await domainRepo.findOne({
            where: { id: domainId, projectId },
            relations: { project: true },
        });

        if (!customDomain) {
            throw new AppError('Domain not found', 404);
        }

        await domainRepo.remove(customDomain);

        // Regenerate config without this domain
        await DomainService.regenerateProjectConfig(projectId);
    }

    static async setRedirectTarget(domainId: string, projectId: string, redirectTarget: string | null): Promise<CustomDomain> {
        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const customDomain = await domainRepo.findOne({
            where: { id: domainId, projectId },
            relations: { project: true },
        });

        if (!customDomain) {
            throw new AppError('Domain not found', 404);
        }
        if (isWildcardDomain(customDomain.domain)) {
            throw new AppError('Wildcard domains cannot have a redirect target', 400);
        }

        // Validate basic URL shape if target is provided
        if (redirectTarget) {
            try {
                // Ensure it's just a hostname/domain name, or sanitize it
                const sanitized = redirectTarget.trim().toLowerCase();
                // Extremely basic sanity check — it shouldn't contain spaces or scheme
                if (sanitized.includes(' ') || sanitized.includes('://')) {
                    throw new AppError('Redirect target must be a valid domain (e.g. example.com), without http://', 400);
                }
                customDomain.redirectTarget = sanitized;
            } catch (err: any) {
                throw new AppError(err.message, 400);
            }
        } else {
            customDomain.redirectTarget = null;
        }

        await domainRepo.save(customDomain);

        // Regenerate config with the new redirect instruction
        await DomainService.regenerateProjectConfig(customDomain.project.id);

        return customDomain;
    }

    private static async regenerateProjectConfig(projectId: string): Promise<void> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: { customDomains: true },
        });

        if (!project) return;

        const configContent = await ServerConfigService.generateConfig(
            await buildProxyOptions(project, project.customDomains, { port: project.port || 8080 })
        );

        await ServerConfigService.writeConfig(project.subdomain, configContent, project.serverType);
        await ServerConfigService.reloadCaddy();
    }
}
