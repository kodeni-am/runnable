import { Router, Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../config/data-source';
import { Project, GithubRepo, User } from '../entities';
import { ProjectPermission } from '../entities/enums';
import { authenticate, requireApproval, requireProjectAccess, AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { GithubService } from '../services/github.service';
import { config } from '../config';

const router = Router();

// GitHub webhook receiver (no auth - verified by HMAC signature)
// MUST be registered before the authenticate/requireApproval middleware
router.post('/webhooks/github', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const signature = req.headers['x-hub-signature-256'] as string;
        if (!signature) {
            res.status(400).json({ error: 'Missing signature' });
            return;
        }

        const event = req.headers['x-github-event'] as string;
        if (event !== 'push') {
            res.json({ message: 'Event ignored' });
            return;
        }

        // Use raw body bytes for signature verification (GitHub signs raw bytes)
        const rawBody = (req as any).rawBody as Buffer | undefined;
        const payload = rawBody ? rawBody.toString() : JSON.stringify(req.body);

        const repoUrl = req.body.repository?.html_url;

        if (!repoUrl) {
            res.status(400).json({ error: 'Invalid payload' });
            return;
        }

        // Find the project by repo URL
        const githubRepoRepo = AppDataSource.getRepository(GithubRepo);
        const githubRepo = await githubRepoRepo.findOne({
            where: { repoUrl },
            relations: ['project'],
        });

        if (!githubRepo || !githubRepo.webhookSecret) {
            res.status(404).json({ error: 'Repo not found' });
            return;
        }

        // Verify signature
        const isValid = GithubService.verifyWebhookSignature(payload, signature, githubRepo.webhookSecret);
        if (!isValid) {
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        // Check if push is to the correct branch
        const branch = req.body.ref?.replace('refs/heads/', '');
        if (branch !== githubRepo.branch) {
            res.json({ message: `Push to ${branch} ignored, watching ${githubRepo.branch}` });
            return;
        }

        // Trigger deploy
        await GithubService.handlePushEvent(githubRepo.project.id);
        res.json({ message: 'Deployment triggered' });
    } catch (error) {
        next(error);
    }
});

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
            const callbackUrl = `https://api.${config.hosting.baseDomain}/api/webhooks/github`;
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

export default router;
