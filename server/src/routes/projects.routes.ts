import { Router, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project, ServerType, ServiceStatus, User, Role, ProjectCollaborator } from '../entities';
import { ProjectPermission } from '../entities/enums';
import { DEFAULT_PROJECT_PERMISSIONS } from '../entities/ProjectCollaborator';
import { DEFAULT_USER_PERMISSIONS } from '../entities/User';
import { authenticate, requireApproval, requireProjectAccess, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { SandboxService } from '../services/sandbox.service';
import { ProcessService } from '../services/process.service';
import { ServerConfigService } from '../services/serverConfig.service';
import { config } from '../config';

const router = Router();

// All routes require authentication and admin approval
router.use(authenticate, requireApproval);

// List user's projects (owned + collaborating)
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);

        // Owned projects
        const ownedProjects = await projectRepo.find({
            where: { userId: req.user!.id },
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

// Create project (with global permission checks)
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { name, subdomain, serverType } = req.body;

        if (!name || !subdomain || !serverType) {
            throw new AppError('Name, subdomain, and serverType are required', 400);
        }

        // Check global user permissions
        const userPerms = req.user!.permissions ?? DEFAULT_USER_PERMISSIONS;
        if (!userPerms.canCreateProjects && req.user!.role !== Role.ADMIN) {
            throw new AppError('You are not allowed to create projects', 403);
        }

        // Check maxProjects
        if (userPerms.maxProjects !== null && userPerms.maxProjects !== undefined && req.user!.role !== Role.ADMIN) {
            const projectRepo = AppDataSource.getRepository(Project);
            const count = await projectRepo.count({ where: { userId: req.user!.id } });
            if (count >= userPerms.maxProjects) {
                throw new AppError(`You have reached your maximum of ${userPerms.maxProjects} project(s)`, 403);
            }
        }

        // Check allowed server types
        if (userPerms.allowedServerTypes && userPerms.allowedServerTypes.length > 0 && req.user!.role !== Role.ADMIN) {
            if (!userPerms.allowedServerTypes.includes(serverType)) {
                throw new AppError(`Server type "${serverType}" is not allowed for your account`, 403);
            }
        }

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

        // Allocate port (start from 9000, find next available)
        // Use internalPort (the container-side port) for allocation — project.port
        // gets overwritten with the dynamic host port after each run and cannot be
        // used to determine the highest assigned container port.
        const lastProject = await projectRepo
            .createQueryBuilder('project')
            .orderBy('project.internalPort', 'DESC')
            .getOne();
        const port = (lastProject?.internalPort || 8999) + 1;

        const directoryPath = path.join(config.hosting.servDir, subdomain);

        // Create sandbox (or just directory)
        const project = projectRepo.create({
            name,
            subdomain,
            directoryPath,
            serverType: serverType as ServerType,
            status: ServiceStatus.STOPPED,
            port,
            internalPort: port, // always set so port allocation and start() can rely on this
            userId: req.user!.id,
        });

        // Save first to get the generated UUID
        await projectRepo.save(project);

        try {
            await SandboxService.createSandbox(project.id, directoryPath);
        } catch (error) {
            // Rollback if sandbox creation fails
            await projectRepo.remove(project);
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

        const { name, serverType, buildCommand, startCommand, envVars, port,
                useCompose, composeFile, composeService } = req.body;
        if (name) project.name = name;
        if (serverType) project.serverType = serverType as ServerType;
        if (buildCommand !== undefined) project.buildCommand = buildCommand;
        if (startCommand !== undefined) project.startCommand = startCommand;
        if (envVars !== undefined) project.envVars = envVars;
        if (port !== undefined) project.port = port;
        if (useCompose !== undefined) project.useCompose = useCompose;
        if (composeFile !== undefined) project.composeFile = composeFile;
        if (composeService !== undefined) project.composeService = composeService;

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

        // Stop service if running
        if (project.status === ServiceStatus.RUNNING) {
            await ProcessService.stop(project.id);
        }

        // Remove config
        if (project.configPath) {
            await ServerConfigService.removeConfig(project.configPath);
        }

        // Destroy sandbox
        await SandboxService.destroySandbox(project.id);

        // Remove project directory (cloned repo + build artifacts)
        if (project.directoryPath) {
            await fs.rm(project.directoryPath, { recursive: true, force: true }).catch(() => { });
        }

        const projectRepo = AppDataSource.getRepository(Project);
        await projectRepo.remove(project);
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
        res.json({ status: 'running' });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/stop', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        await ProcessService.stop(project.id);
        res.json({ status: 'stopped' });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/restart', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        await ProcessService.restart(project.id);
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
            permissions: permissions ?? DEFAULT_PROJECT_PERMISSIONS,
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

        collab.permissions = permissions;
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
