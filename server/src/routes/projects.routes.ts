import { Router, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { AppDataSource } from '../config/data-source';
import { Project, ServerType, ServiceStatus } from '../entities';
import { authenticate, requireApproval, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { SandboxService } from '../services/sandbox.service';
import { ProcessService } from '../services/process.service';
import { ServerConfigService } from '../services/serverConfig.service';
import { config } from '../config';

const router = Router();

// All routes require authentication and admin approval
router.use(authenticate, requireApproval);

// List user's projects
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const projects = await projectRepo.find({
            where: { userId: req.user!.id },
            relations: ['githubRepo', 'customDomains'],
            order: { createdAt: 'DESC' },
        });
        res.json(projects);
    } catch (error) {
        next(error);
    }
});

// Create project
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { name, subdomain, serverType } = req.body;

        if (!name || !subdomain || !serverType) {
            throw new AppError('Name, subdomain, and serverType are required', 400);
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
        const lastProject = await projectRepo
            .createQueryBuilder('project')
            .orderBy('project.port', 'DESC')
            .getOne();
        const port = (lastProject?.port || 8999) + 1;

        const directoryPath = path.join(config.hosting.servDir, subdomain);

        // Create sandbox (or just directory)
        const project = projectRepo.create({
            name,
            subdomain,
            directoryPath,
            serverType: serverType as ServerType,
            status: ServiceStatus.STOPPED,
            port,
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

// Get project details
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
            relations: ['githubRepo', 'customDomains'],
        });

        if (!project) {
            throw new AppError('Project not found', 404);
        }

        res.json(project);
    } catch (error) {
        next(error);
    }
});

// Update project
router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });

        if (!project) {
            throw new AppError('Project not found', 404);
        }

        const { name, serverType, buildCommand, startCommand, envVars, port } = req.body;
        if (name) project.name = name;
        if (serverType) project.serverType = serverType as ServerType;
        if (buildCommand !== undefined) project.buildCommand = buildCommand;
        if (startCommand !== undefined) project.startCommand = startCommand;
        if (envVars !== undefined) project.envVars = envVars;
        if (port !== undefined) project.port = port;

        await projectRepo.save(project);
        res.json(project);
    } catch (error) {
        next(error);
    }
});

// Delete project
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });

        if (!project) {
            throw new AppError('Project not found', 404);
        }

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

        await projectRepo.remove(project);
        res.json({ message: 'Project deleted' });
    } catch (error) {
        next(error);
    }
});

// --- Service controls ---
router.post('/:id/start', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        await ProcessService.start(project.id);
        res.json({ status: 'running' });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/stop', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        await ProcessService.stop(project.id);
        res.json({ status: 'stopped' });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/restart', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
        });
        if (!project) throw new AppError('Project not found', 404);

        await ProcessService.restart(project.id);
        res.json({ status: 'running' });
    } catch (error) {
        next(error);
    }
});

router.get('/:id/status', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const status = await ProcessService.getStatus(req.params.id as string);
        res.json({ status });
    } catch (error) {
        next(error);
    }
});

router.post('/:id/reload-proxy', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: req.params.id as string, userId: req.user!.id },
            relations: ['customDomains'],
        });
        if (!project) throw new AppError('Project not found', 404);

        // Generate and write new config
        const configContent = await ServerConfigService.generateConfig({
            subdomain: project.subdomain,
            directoryPath: project.directoryPath,
            port: project.port || 80,
            serverType: project.serverType,
            customDomains: project.customDomains?.map(cd => cd.domain) || [],
        });

        const configPath = await ServerConfigService.writeConfig(
            project.subdomain,
            configContent,
            project.serverType
        );

        // Save updated config path if changed
        if (project.configPath !== configPath) {
            project.configPath = configPath;
            await projectRepo.save(project);
        }

        // Reload the server
        await ServerConfigService.reloadCaddy();

        res.json({ message: 'Proxy configuration reloaded successfully' });
    } catch (error) {
        next(error);
    }
});

router.get('/:id/logs', async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const lines = parseInt(req.query.lines as string) || 100;
        const logs = await ProcessService.getLogs(req.params.id as string, lines);
        res.json({ logs });
    } catch (error) {
        next(error);
    }
});

export default router;
