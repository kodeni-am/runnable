import crypto from 'crypto';
import { SandboxService } from './sandbox.service';
import { AppDataSource } from '../config/data-source';
import { GithubRepo, Project, ServiceStatus } from '../entities';
import { ProcessService } from './process.service';
import { config } from '../config';

export class GithubService {
    static async cloneRepo(
        projectId: string,
        repoUrl: string,
        targetDir: string,
        branch: string = 'main',
        token?: string
    ): Promise<void> {
        let cloneUrl = repoUrl;

        // For private repos, inject token into URL
        if (token && repoUrl.startsWith('https://')) {
            cloneUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
        }

        const result = await SandboxService.exec(
            projectId,
            'git',
            ['clone', '--branch', branch, '--single-branch', '--depth', '1', cloneUrl, targetDir]
        );

        if (result.exitCode !== 0) {
            throw new Error(`Git clone failed: ${result.stderr}`);
        }
    }

    static async pullLatest(projectId: string, dir: string): Promise<void> {
        const result = await SandboxService.exec(projectId, 'git', ['pull', 'origin', 'HEAD'], dir);
        if (result.exitCode !== 0) {
            throw new Error(`Git pull failed: ${result.stderr}`);
        }
    }

    static async setupWebhook(
        repoUrl: string,
        token: string,
        callbackUrl: string
    ): Promise<{ webhookId: string; secret: string }> {
        const secret = crypto.randomBytes(32).toString('hex');

        // Parse owner/repo from URL
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) throw new Error('Invalid GitHub repo URL');

        const [, owner, repo] = match;

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
            method: 'POST',
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: 'web',
                active: true,
                events: ['push'],
                config: {
                    url: callbackUrl,
                    content_type: 'json',
                    secret,
                    insecure_ssl: '0',
                },
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to create webhook: ${error}`);
        }

        const data = await response.json() as any;
        return { webhookId: String(data.id), secret };
    }

    static async removeWebhook(repoUrl: string, token: string, webhookId: string): Promise<void> {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) return;

        const [, owner, repo] = match;

        await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks/${webhookId}`, {
            method: 'DELETE',
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
        });
    }

    static verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(payload);
        const digest = `sha256=${hmac.digest('hex')}`;
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    }

    static async handlePushEvent(projectId: string): Promise<void> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: ['githubRepo'],
        });

        if (!project || !project.githubRepo) return;

        // Update status to deploying
        project.status = ServiceStatus.DEPLOYING;
        await projectRepo.save(project);

        try {
            // Pull latest changes
            await GithubService.pullLatest(projectId, project.directoryPath);

            // Update last deploy timestamp
            const repoRepo = AppDataSource.getRepository(GithubRepo);
            project.githubRepo.lastDeployAt = new Date();
            await repoRepo.save(project.githubRepo);

            // Restart the service
            await ProcessService.restart(projectId);
        } catch (error) {
            project.status = ServiceStatus.ERROR;
            await projectRepo.save(project);
            throw error;
        }
    }
}
