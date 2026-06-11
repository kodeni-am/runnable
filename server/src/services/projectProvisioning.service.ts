import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project, ServerType, ServiceStatus, User } from '../entities';
import { AppError } from '../middleware/errorHandler';
import { SandboxService } from './sandbox.service';
import { config } from '../config';

/**
 * Core project provisioning shared by normal creation, one-click templates, and
 * (in a later phase) preview environments: subdomain validation + uniqueness,
 * container-port allocation, entity creation, and sandbox setup with rollback.
 *
 * This intentionally does NOT run user-permission, maxProjects, or server-type
 * checks — those belong to the user-facing create flow, not to system-initiated
 * provisioning (templates, previews). The caller passes the owning `User` and
 * any extra column values via `extras`.
 */
export class ProjectProvisioningService {
    static async provisionCore(
        owner: User,
        name: string,
        subdomain: string,
        serverType: ServerType,
        extras: Partial<Project> = {},
    ): Promise<Project> {
        // Validate subdomain format
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
            throw new AppError('Subdomain must be lowercase alphanumeric with hyphens', 400);
        }

        const projectRepo = AppDataSource.getRepository(Project);

        // Check uniqueness
        const existing = await projectRepo.findOne({ where: { subdomain } });
        if (existing) {
            throw new AppError('Subdomain is already taken', 409);
        }

        // Allocate the container-side port. Compose projects are excluded from the
        // watermark: their internalPort is a fixed image port (e.g. 27017) that
        // would poison allocation.
        const lastProject = await projectRepo
            .createQueryBuilder('project')
            .where('project.useCompose = :useCompose', { useCompose: false })
            .orderBy('project.internalPort', 'DESC', 'NULLS LAST')
            .getOne();
        const port = (lastProject?.internalPort || 8999) + 1;

        const directoryPath = path.join(config.hosting.servDir, subdomain);

        const project = projectRepo.create({
            name,
            subdomain,
            directoryPath,
            serverType,
            status: ServiceStatus.STOPPED,
            port,
            internalPort: port,
            userId: owner.id,
            ...extras,
        });

        // Save first to get the generated UUID
        await projectRepo.save(project);

        try {
            await SandboxService.createSandbox(project.id, directoryPath);
        } catch (error) {
            await projectRepo.remove(project);
            throw error;
        }

        return project;
    }
}
