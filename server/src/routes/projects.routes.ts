import { Router, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project, ServerType, User, Role, ProjectCollaborator } from '../entities';
import { ProjectPermission } from '../entities/enums';
import { DEFAULT_PROJECT_PERMISSIONS, sanitizeProjectPermissions } from '../entities/ProjectCollaborator';
import { DEFAULT_USER_PERMISSIONS } from '../entities/User';
import { authenticate, requireApproval, requireProjectAccess, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { SandboxService } from '../services/sandbox.service';
import { ProcessService } from '../services/process.service';
import { HealthMonitorService } from '../services/healthMonitor.service';
import { ServerConfigService } from '../services/serverConfig.service';
import { ProjectProvisioningService } from '../services/projectProvisioning.service';
import { ProjectTeardownService } from '../services/projectTeardown.service';
import { getTemplate } from '../templates/catalog';

const router = Router();

// All routes require authentication and admin approval
router.use(authenticate, requireApproval);

// List user's projects (owned + collaborating)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);

        // Owned projects
        const ownedProjects = await projectRepo.find({
            where: { userId: req.user!.id, isPreview: false },
            relations: ['githubRepo', 'customDomains'],
            order: { createdAt: 'DESC' },
        });

        // Collaborating projects
        const collabRepo = AppDataSource.getRepository(ProjectCollaborator);
        const collaborations = await collabRepo.find({
            where: { userId: req.user!.id },
            relations: ['project', 'project.githubRepo', 'project.customDomains'],
        });
        const sharedProjects = collaborations
            .map(c => ({ ...c.project, _isCollaborator: true, _permissions: c.permissions }))
            .filter(p => p.id); // filter out any missing projects

        res.json([...ownedProjects, ...sharedProjects]);
    } catch (error) {
        next(error);
    }
});

/**
 * User-facing project creation: enforce global user permissions, the
 * maxProjects quota (previews excluded), and allowed server types, then
 * delegate to ProjectProvisioningService for the actual provisioning.
 */
async function provisionProject(
    user: User,
    name: string,
    subdomain: string,
    serverType: ServerType,
    extras: Partial<Project> = {},
): Promise<Project> {
    const userPerms = user.permissions ?? DEFAULT_USER_PERMISSIONS;
    if (!userPerms.canCreateProjects && user.role !== Role.ADMIN) {
        throw new AppError('You are not allowed to create projects', 403);
    }

    // Check maxProjects — count only the user's own NON-preview projects.
    if (userPerms.maxProjects !== null && userPerms.maxProjects !== undefined && user.role !== Role.ADMIN) {
        const projectRepo = AppDataSource.getRepository(Project);
        const count = await projectRepo.count({ where: { userId: user.id, isPreview: false } });
        if (count >= userPerms.maxProjects) {
            throw new AppError(`You have reached your maximum of ${userPerms.maxProjects} project(s)`, 403);
        }
    }

    if (userPerms.allowedServerTypes && userPerms.allowedServerTypes.length > 0 && user.role !== Role.ADMIN) {
        if (!userPerms.allowedServerTypes.includes(serverType)) {
            throw new AppError(`Server type "${serverType}" is not allowed for your account`, 403);
        }
    }

    return ProjectProvisioningService.provisionCore(user, name, subdomain, serverType, extras);
}

// Create project (with global permission checks)
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { name, subdomain, serverType } = req.body;

        if (!name || !subdomain || !serverType) {
            throw new AppError('Name, subdomain, and serverType are required', 400);
        }

        const project = await provisionProject(req.user!, name, subdomain, serverType as ServerType);
        res.status(201).json(project);
    } catch (error) {
        next(error);
    }
});

// Create project from a one-click template
router.post('/from-template', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { templateKey, name, subdomain, env } = req.body;

        if (!templateKey || !name || !subdomain) {
            throw new AppError('templateKey, name, and subdomain are required', 400);
        }

        const template = getTemplate(String(templateKey));
        if (!template) {
            throw new AppError('Unknown template', 404);
        }

        // Resolve env values: generated secrets, then user overrides for the
        // non-generated ones (only keys the template declares are accepted)
        const envVars: Record<string, string> = {};
        for (const spec of template.env) {
            if (spec.generate) {
                envVars[spec.key] = crypto.randomBytes(16).toString('hex');
            } else {
                const provided = env && typeof env === 'object' ? (env as Record<string, unknown>)[spec.key] : undefined;
                envVars[spec.key] = typeof provided === 'string' && provided !== '' ? provided : (spec.defaultValue || '');
            }
        }

        const project = await provisionProject(req.user!, name, subdomain, ServerType.APP, {
            useCompose: true,
            composeFile: 'docker-compose.yml',
            composeService: template.composeService,
            internalPort: template.internalPort,
            envVars,
        });

        // Write the template's compose file into the project directory; roll
        // everything back if it fails — a compose project without its compose
        // file can never start.
        try {
            await fs.mkdir(project.directoryPath, { recursive: true });
            await fs.writeFile(path.join(project.directoryPath, 'docker-compose.yml'), template.composeYaml, { mode: 0o644 });
        } catch (error) {
            await SandboxService.destroySandbox(project.id).catch(() => { });
            await AppDataSource.getRepository(Project).remove(project).catch(() => { });
            throw error;
        }

        res.status(201).json(project);
    } catch (error) {
        next(error);
    }
});

// Get project details (any collaborator or owner)
router.get('/:id', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        res.json(project);
    } catch (error) {
        next(error);
    }
});

// Update project (requires canEditConfig)
router.put('/:id', requireProjectAccess(ProjectPermission.CAN_EDIT_CONFIG), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;

        const { name, serverType, buildCommand, startCommand, envVars, port, internalPort,
                useCompose, composeFile, composeService, notificationWebhookUrl, autoRestart } = req.body;
        if (name) project.name = name;
        if (serverType) project.serverType = serverType as ServerType;
        if (buildCommand !== undefined) project.buildCommand = buildCommand;
        if (startCommand !== undefined) project.startCommand = startCommand;
        if (envVars !== undefined) {
            // Must be a flat string→string object: anything else either breaks
            // doStart's parsing or produces junk docker -e args.
            if (envVars === null) {
                // undefined would be skipped by TypeORM's save — null actually clears the column
                project.envVars = null as any;
            } else {
                if (typeof envVars !== 'object' || Array.isArray(envVars)) {
                    throw new AppError('envVars must be an object of string values', 400);
                }
                const clean: Record<string, string> = {};
                for (const [key, value] of Object.entries(envVars)) {
                    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
                        throw new AppError(`envVars.${key} must be a string`, 400);
                    }
                    clean[key] = String(value);
                }
                project.envVars = clean;
            }
        }
        if (port !== undefined) project.port = port;
        if (internalPort !== undefined) {
            if (internalPort === null) {
                // Cleared by the user — fall back to the default (8080) at start time
                project.internalPort = null as any;
            } else {
                const n = Number(internalPort);
                if (!Number.isInteger(n) || n < 1 || n > 65535) {
                    throw new AppError('internalPort must be an integer between 1 and 65535', 400);
                }
                project.internalPort = n;
            }
        }
        if (useCompose !== undefined) project.useCompose = Boolean(useCompose);
        if (composeFile !== undefined) {
            if (composeFile) {
                // The compose file must stay inside the project directory —
                // it's passed to `docker compose -f` with the project as cwd.
                const resolved = path.resolve(project.directoryPath, String(composeFile));
                if (resolved !== path.resolve(project.directoryPath)
                    && !resolved.startsWith(path.resolve(project.directoryPath) + path.sep)) {
                    throw new AppError('composeFile must be a path inside the project directory', 400);
                }
            }
            project.composeFile = composeFile;
        }
        if (composeService !== undefined) {
            if (composeService && !/^[a-zA-Z0-9._-]+$/.test(String(composeService))) {
                throw new AppError('composeService must be a valid compose service name', 400);
            }
            project.composeService = composeService;
        }
        if (notificationWebhookUrl !== undefined) {
            if (notificationWebhookUrl === null || notificationWebhookUrl === '') {
                project.notificationWebhookUrl = null as any;
            } else {
                try {
                    const parsed = new URL(String(notificationWebhookUrl));
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
                } catch {
                    throw new AppError('notificationWebhookUrl must be a valid http(s) URL', 400);
                }
                project.notificationWebhookUrl = String(notificationWebhookUrl);
            }
        }
        if (autoRestart !== undefined) project.autoRestart = Boolean(autoRestart);

        const projectRepo = AppDataSource.getRepository(Project);
        await projectRepo.save(project);
        res.json(project);
    } catch (error) {
        next(error);
    }
});

// Delete project (requires canDelete)
router.delete('/:id', requireProjectAccess(ProjectPermission.CAN_DELETE), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        await ProjectTeardownService.teardown(project, req.user!.githubToken || undefined);
        res.json({ message: 'Project deleted' });
    } catch (error) {
        next(error);
    }
});

// --- Service controls ---
router.post('/:id/start', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        await ProcessService.start(project.id);
        HealthMonitorService.reset(project.id);
        res.json({ status: 'running' });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/stop', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        await ProcessService.stop(project.id);
        HealthMonitorService.reset(project.id);
        res.json({ status: 'stopped' });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/restart', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        await ProcessService.restart(project.id);
        HealthMonitorService.reset(project.id);
        res.json({ status: 'running' });
    } catch (error) {
        next(error);
    }
});

router.get('/:id/status', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const status = await ProcessService.getStatus(req.params.id as string);
        res.json({ status });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/reload-proxy', requireProjectAccess(ProjectPermission.CAN_EDIT_CONFIG), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;

        // Generate and write new config
        const configContent = await ServerConfigService.generateConfig({
            subdomain: project.subdomain,
            directoryPath: project.directoryPath,
            port: project.port || 80,
            serverType: project.serverType,
            customDomains: project.customDomains?.map(cd => ({
                domain: cd.domain,
                redirectTarget: cd.redirectTarget || null
            })) || [],
            baseDomain: project.baseDomain || undefined,
            onDemandTls: project.isPreview === true,
        });

        const configPath = await ServerConfigService.writeConfig(
            project.subdomain,
            configContent,
            project.serverType
        );

        // Save updated config path if changed
        if (project.configPath !== configPath) {
            project.configPath = configPath;
            const projectRepo = AppDataSource.getRepository(Project);
            await projectRepo.save(project);
        }

        // Reload the server
        await ServerConfigService.reloadCaddy();

        res.json({ message: 'Proxy configuration reloaded successfully' });
    } catch (error) {
        next(error);
    }
});

router.get('/:id/logs', requireProjectAccess(ProjectPermission.CAN_VIEW_LOGS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const lines = parseInt(req.query.lines as string) || 100;
        const logs = await ProcessService.getLogs(req.params.id as string, lines);
        res.json({ logs });
    } catch (error) {
        next(error);
    }
});

// List the project's Docker containers
router.get('/:id/containers', requireProjectAccess(ProjectPermission.CAN_VIEW_LOGS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const containers = await ProcessService.listContainers(req.params.id as string);
        res.json({ containers });
    } catch (error) {
        next(error);
    }
});

// Logs for a single container within the project
router.get('/:id/containers/:container/logs', requireProjectAccess(ProjectPermission.CAN_VIEW_LOGS), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const lines = parseInt(req.query.lines as string) || 200;
        const logs = await ProcessService.getContainerLogs(
            req.params.id as string,
            req.params.container as string,
            lines,
        );
        res.json({ logs });
    } catch (error) {
        next(error);
    }
});

// --- Collaborator management (owner/admin only) ---

// List collaborators
router.get('/:id/collaborators', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;

        // Only owner or admin can list collaborators
        if (project.userId !== req.user!.id && req.user!.role !== Role.ADMIN) {
            throw new AppError('Only the project owner can manage collaborators', 403);
        }

        const collabRepo = AppDataSource.getRepository(ProjectCollaborator);
        const collaborators = await collabRepo.find({
            where: { projectId: project.id },
            relations: ['user'],
        });

        res.json(collaborators.map(c => ({
            id: c.id,
            userId: c.userId,
            username: c.user.username,
            email: c.user.email,
            permissions: c.permissions,
            createdAt: c.createdAt,
        })));
    } catch (error) {
        next(error);
    }
});

// Invite collaborator
router.post('/:id/collaborators', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;

        // Only owner or admin can invite
        if (project.userId !== req.user!.id && req.user!.role !== Role.ADMIN) {
            throw new AppError('Only the project owner can manage collaborators', 403);
        }

        const { emailOrUsername, permissions } = req.body;
        if (!emailOrUsername) {
            throw new AppError('Email or username is required', 400);
        }

        const userRepo = AppDataSource.getRepository(User);
        const targetUser = await userRepo.findOne({
            where: [
                { email: emailOrUsername },
                { username: emailOrUsername },
            ],
        });

        if (!targetUser) {
            throw new AppError('User not found', 404);
        }

        if (targetUser.id === project.userId) {
            throw new AppError('Cannot add the project owner as a collaborator', 400);
        }

        const collabRepo = AppDataSource.getRepository(ProjectCollaborator);
        const existing = await collabRepo.findOne({
            where: { userId: targetUser.id, projectId: project.id },
        });

        if (existing) {
            throw new AppError('User is already a collaborator', 409);
        }

        const collab = collabRepo.create({
            userId: targetUser.id,
            projectId: project.id,
            permissions: permissions ? sanitizeProjectPermissions(permissions) : DEFAULT_PROJECT_PERMISSIONS,
        });

        await collabRepo.save(collab);

        res.status(201).json({
            id: collab.id,
            userId: targetUser.id,
            username: targetUser.username,
            email: targetUser.email,
            permissions: collab.permissions,
            createdAt: collab.createdAt,
        });
    } catch (error) {
        next(error);
    }
});

// Update collaborator permissions
router.put('/:id/collaborators/:userId', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;

        // Only owner or admin can update permissions
        if (project.userId !== req.user!.id && req.user!.role !== Role.ADMIN) {
            throw new AppError('Only the project owner can manage collaborators', 403);
        }

        const { permissions } = req.body;
        if (!permissions) {
            throw new AppError('Permissions are required', 400);
        }

        const collabRepo = AppDataSource.getRepository(ProjectCollaborator);
        const collab = await collabRepo.findOne({
            where: { userId: req.params.userId as string, projectId: project.id },
            relations: ['user'],
        });

        if (!collab) {
            throw new AppError('Collaborator not found', 404);
        }

        collab.permissions = sanitizeProjectPermissions(permissions);
        await collabRepo.save(collab);

        res.json({
            id: collab.id,
            userId: collab.userId,
            username: collab.user.username,
            email: collab.user.email,
            permissions: collab.permissions,
            createdAt: collab.createdAt,
        });
    } catch (error) {
        next(error);
    }
});

// Remove collaborator
router.delete('/:id/collaborators/:userId', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;

        // Only owner or admin can remove
        if (project.userId !== req.user!.id && req.user!.role !== Role.ADMIN) {
            throw new AppError('Only the project owner can manage collaborators', 403);
        }

        const collabRepo = AppDataSource.getRepository(ProjectCollaborator);
        const collab = await collabRepo.findOne({
            where: { userId: req.params.userId as string, projectId: project.id },
        });

        if (!collab) {
            throw new AppError('Collaborator not found', 404);
        }

        await collabRepo.remove(collab);
        res.json({ message: 'Collaborator removed' });
    } catch (error) {
        next(error);
    }
});

export default router;
