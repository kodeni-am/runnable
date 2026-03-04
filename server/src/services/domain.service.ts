import dns from 'dns/promises';
import { AppDataSource } from '../config/data-source';
import { CustomDomain, Project } from '../entities';
import { ServerConfigService } from './serverConfig.service';
import { ProcessService } from './process.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';

export class DomainService {
    static async addDomain(projectId: string, domain: string): Promise<{ domain: CustomDomain; instructions: string }> {
        // Validate domain format
        const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
        if (!domainRegex.test(domain)) {
            throw new AppError('Invalid domain format', 400);
        }

        const domainRepo = AppDataSource.getRepository(CustomDomain);

        // Check if domain already exists
        const existing = await domainRepo.findOne({ where: { domain } });
        if (existing) {
            throw new AppError('Domain is already in use', 409);
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
        });

        await domainRepo.save(customDomain);

        const targetCname = `${project.subdomain}.${config.hosting.baseDomain}`;
        const instructions = `Add a CNAME record:\n  ${domain} → ${targetCname}\n\nOr add a TXT record:\n  _runnable-verify.${domain} → ${project.id}`;

        return { domain: customDomain, instructions };
    }

    static async verifyDomain(domainId: string): Promise<boolean> {
        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const customDomain = await domainRepo.findOne({
            where: { id: domainId },
            relations: ['project'],
        });

        if (!customDomain) {
            throw new AppError('Domain not found', 404);
        }

        const targetCname = `${customDomain.project.subdomain}.${config.hosting.baseDomain}`;

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

        try {
            const txtRecords = await dns.resolveTxt(`_runnable-verify.${customDomain.domain}`);
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

    static async removeDomain(domainId: string): Promise<void> {
        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const customDomain = await domainRepo.findOne({
            where: { id: domainId },
            relations: ['project'],
        });

        if (!customDomain) {
            throw new AppError('Domain not found', 404);
        }

        const projectId = customDomain.project.id;
        await domainRepo.remove(customDomain);

        // Regenerate config without this domain
        await DomainService.regenerateProjectConfig(projectId);
    }

    static async setRedirectTarget(domainId: string, redirectTarget: string | null): Promise<CustomDomain> {
        const domainRepo = AppDataSource.getRepository(CustomDomain);
        const customDomain = await domainRepo.findOne({
            where: { id: domainId },
            relations: ['project'],
        });

        if (!customDomain) {
            throw new AppError('Domain not found', 404);
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
            relations: ['customDomains'],
        });

        if (!project) return;

        const configContent = await ServerConfigService.generateConfig({
            subdomain: project.subdomain,
            directoryPath: project.directoryPath,
            port: project.port || 8080,
            serverType: project.serverType,
            customDomains: project.customDomains?.map(cd => ({
                domain: cd.domain,
                redirectTarget: cd.redirectTarget || null
            })) || [],
        });

        await ServerConfigService.writeConfig(project.subdomain, configContent, project.serverType);
        await ServerConfigService.reloadCaddy();
    }
}
