import { Router, Response, NextFunction } from 'express';
import { AppDataSource } from '../config/data-source';
import { Project, GithubRepo, User, Deployment } from '../entities';
import { ProjectPermission } from '../entities/enums';
import { authenticate, requireApproval, requireProjectAccess, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { GithubService } from '../services/github.service';
import { config } from '../config';

const router = Router();

// The GitHub webhook receiver lives in webhooks.routes.ts (mounted at
// /api/webhooks) — this router holds only project-scoped routes.

// All project-scoped routes require auth + approval
router.use(authenticate, requireApproval);

// Connect GitHub repo to project
router.post('/:id/github/connect', requireProjectAccess(ProjectPermission.CAN_EDIT_CONFIG), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const { repoUrl, branch } = req.body;
        if (!repoUrl) throw new AppError('repoUrl is required', 400);

        const project = (req as any).project as Project;
        // Load githubRepo relation if not already loaded
        if (!project.githubRepo) {
            const projectRepo = AppDataSource.getRepository(Project);
            const loaded = await projectRepo.findOne({
                where: { id: project.id },
                relations: ['githubRepo'],
            });
            if (loaded?.githubRepo) project.githubRepo = loaded.githubRepo;
        }

        if (project.githubRepo) {
            throw new AppError('Project already has a GitHub repo connected', 409);
        }

        const user = req.user!;
        const isPrivate = !!user.githubToken;

        // Clone the repo
        await GithubService.cloneRepo(
            project.id,
            repoUrl,
            project.directoryPath,
            branch || 'main',
            user.githubToken || undefined
        );

        // Set up webhook if user has a GitHub token
        let webhookId: string | undefined;
        let webhookSecret: string | undefined;

        if (user.githubToken) {
            const callbackUrl = `${config.hosting.apiBaseUrl.replace(/\/$/, '')}/api/webhooks/github`;
            const webhook = await GithubService.setupWebhook(repoUrl, user.githubToken, callbackUrl);
            webhookId = webhook.webhookId;
            webhookSecret = webhook.secret;
        }

        const githubRepoEntity = AppDataSource.getRepository(GithubRepo).create({
            repoUrl,
            branch: branch || 'main',
            isPrivate,
            webhookId,
            webhookSecret,
            projectId: project.id,
            lastDeployAt: new Date(),
        });

        await AppDataSource.getRepository(GithubRepo).save(githubRepoEntity);

        res.status(201).json({
            message: 'GitHub repo connected',
            githubRepo: {
                repoUrl: githubRepoEntity.repoUrl,
                branch: githubRepoEntity.branch,
                isPrivate: githubRepoEntity.isPrivate,
                webhookSetup: !!webhookId,
            },
        });
    } catch (error) {
        next(error);
    }
});

// Disconnect GitHub repo
router.delete('/:id/github/disconnect', requireProjectAccess(ProjectPermission.CAN_EDIT_CONFIG), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        // Load githubRepo relation if not already loaded
        if (!project.githubRepo) {
            const projectRepo = AppDataSource.getRepository(Project);
            const loaded = await projectRepo.findOne({
                where: { id: project.id },
                relations: ['githubRepo'],
            });
            if (loaded?.githubRepo) project.githubRepo = loaded.githubRepo;
        }
        if (!project.githubRepo) throw new AppError('No GitHub repo connected', 404);

        // Remove webhook
        if (project.githubRepo.webhookId && req.user!.githubToken) {
            await GithubService.removeWebhook(
                project.githubRepo.repoUrl,
                req.user!.githubToken,
                project.githubRepo.webhookId
            );
        }

        await AppDataSource.getRepository(GithubRepo).remove(project.githubRepo);
        res.json({ message: 'GitHub repo disconnected' });
    } catch (error) {
        next(error);
    }
});

// List deployment history (newest first)
router.get('/:id/deployments', requireProjectAccess(ProjectPermission.CAN_VIEW_GITHUB), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const deployments = await AppDataSource.getRepository(Deployment).find({
            where: { projectId: project.id },
            order: { createdAt: 'DESC' },
            take: 50,
        });
        res.json(deployments);
    } catch (error) {
        next(error);
    }
});

// Roll back to the commit of a previous deployment (lifecycle op → canStart)
router.post('/:id/deployments/:deploymentId/rollback', requireProjectAccess(ProjectPermission.CAN_START), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const deployment = await GithubService.rollbackToDeployment(project.id, req.params.deploymentId as string);
        res.json(deployment);
    } catch (error) {
        next(error);
    }
});

export default router;
