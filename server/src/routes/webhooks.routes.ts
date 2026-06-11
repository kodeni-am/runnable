import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { AppDataSource } from '../config/data-source';
import { GithubRepo } from '../entities';
import { GithubService } from '../services/github.service';

const router = Router();

// Public endpoint (HMAC-verified, not cookie-authed) — throttle so anonymous
// floods can't drive DB lookups and HMAC computation unchecked.
const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many webhook deliveries' },
    standardHeaders: true,
    legacyHeaders: false,
});

// GitHub webhook receiver (no auth - verified by HMAC signature)
router.post('/github', webhookLimiter, async (req: Request, res: Response, next: NextFunction) => {
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

        // Find the project by repo URL. webhookSecret is select: false, so it
        // must be selected explicitly here — this route is its only consumer.
        const githubRepoRepo = AppDataSource.getRepository(GithubRepo);
        const githubRepo = await githubRepoRepo
            .createQueryBuilder('repo')
            .addSelect('repo.webhookSecret')
            .leftJoinAndSelect('repo.project', 'project')
            .where('repo.repoUrl = :repoUrl', { repoUrl })
            .getOne();

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

        // Branch deletions carry an all-zeros `after` SHA and nothing to deploy
        if (req.body.deleted === true) {
            res.json({ message: 'Branch deletion ignored' });
            return;
        }

        // Trigger deploy, recording the pushed commit for the deployment history
        await GithubService.handlePushEvent(githubRepo.project.id, {
            sha: req.body.after,
            message: req.body.head_commit?.message,
        });
        res.json({ message: 'Deployment triggered' });
    } catch (error) {
        next(error);
    }
});

export default router;
