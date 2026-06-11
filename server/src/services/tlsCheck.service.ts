import { AppDataSource } from '../config/data-source';
import { Project } from '../entities';

/**
 * Decides whether Caddy may issue an on-demand certificate for a hostname.
 * Only live preview hostnames qualify, so Caddy can't be tricked into fetching
 * certs for arbitrary domains pointed at this server.
 *
 * A preview subdomain is a single DNS label (no dots), so the hostname splits
 * into `<subdomain>.<baseDomain>` at the first dot. The subdomain is globally
 * unique, so this is a single indexed lookup.
 */
export class TlsCheckService {
    static async isLivePreviewHostname(domain: string): Promise<boolean> {
        const host = (domain || '').trim().toLowerCase();
        const firstDot = host.indexOf('.');
        if (firstDot < 1) return false;

        const subdomain = host.slice(0, firstDot);
        const project = await AppDataSource.getRepository(Project).findOne({
            where: { subdomain, isPreview: true },
        });
        if (!project || !project.baseDomain) return false;

        return `${project.subdomain}.${project.baseDomain}` === host;
    }
}
