import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { AppDataSource } from '../config/data-source';
import { GithubRepo } from '../entities';
import { GithubService } from '../services/github.service';
import { PreviewService } from '../services/preview.service';

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

router.post('/github', webhookLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const signature = req.headers['x-hub-signature-256'] as string;
        if (!signature) {
            res.status(400).json({ error: 'Missing signature' });
            return;
        }

        const event = req.headers['x-github-event'] as string;
        if (event !== 'push' && event !== 'pull_request') {
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

        // Resolve the PARENT (non-preview) repo. Preview rows share the repoUrl
        // but carry no webhookSecret. webhookSecret is select:false.
        const githubRepoRepo = AppDataSource.getRepository(GithubRepo);
        const githubRepo = await githubRepoRepo
            .createQueryBuilder('repo')
            .addSelect('repo.webhookSecret')
            .leftJoinAndSelect('repo.project', 'project')
            .where('repo.repoUrl = :repoUrl', { repoUrl })
            .andWhere('project.isPreview = :isPreview', { isPreview: false })
            .getOne();

        if (!githubRepo || !githubRepo.webhookSecret) {
            res.status(404).json({ error: 'Repo not found' });
            return;
        }

        const isValid = GithubService.verifyWebhookSignature(payload, signature, githubRepo.webhookSecret);
        if (!isValid) {
            res.status(401).json({ error: 'Invalid signature' });
            return;
        }

        if (event === 'pull_request') {
            const action = req.body.action as string;
            const prBody = req.body.pull_request;
            if (!prBody) {
                res.json({ message: 'No pull_request in payload' });
                return;
            }
            const pr = {
                number: req.body.number ?? prBody.number,
                head: { ref: prBody.head?.ref, repo: prBody.head?.repo ? { full_name: prBody.head.repo.full_name } : null },
                base: { repo: { full_name: prBody.base?.repo?.full_name } },
            };
            const result = await PreviewService.handlePullRequest(githubRepo.project, action, pr);
            res.json({ message: `Preview: ${result}` });
            return;
        }

        // event === 'push'
        const branch = req.body.ref?.replace('refs/heads/', '');
        if (branch !== githubRepo.branch) {
            res.json({ message: `Push to ${branch} ignored, watching ${githubRepo.branch}` });
            return;
        }
        if (req.body.deleted === true) {
            res.json({ message: 'Branch deletion ignored' });
            return;
        }
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
