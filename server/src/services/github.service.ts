import crypto from 'crypto';
import { SandboxService } from './sandbox.service';
import { AppDataSource } from '../config/data-source';
import { GithubRepo, Project, ServiceStatus, Deployment } from '../entities';
import type { DeploymentStatus, DeploymentTrigger } from '../entities/Deployment';
import { ProcessService } from './process.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';

export class GithubService {
    static async cloneRepo(
        projectId: string,
        repoUrl: string,
        targetDir: string,
        branch: string = 'main',
        token?: string
    ): Promise<void> {
        // Only allow https GitHub URLs — anything else (including values starting
        // with "-") could be interpreted by git as an option or a local transport.
        if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/.test(repoUrl)) {
            throw new Error('Invalid repository URL: must be an https://github.com/owner/repo URL');
        }

        let cloneUrl = repoUrl;

        // For private repos, inject token into URL
        if (token && repoUrl.startsWith('https://')) {
            cloneUrl = repoUrl.replace('https://', `https://x-access-token:${token}@`);
        }

        const result = await SandboxService.exec(
            projectId,
            'git',
            ['clone', '--branch', branch, '--single-branch', '--depth', '1', '--', cloneUrl, targetDir]
        );

        if (result.exitCode !== 0) {
            throw new Error(`Git clone failed: ${result.stderr}`);
        }
    }

    static async pullLatest(projectId: string, dir: string, branch: string = 'main'): Promise<void> {
        // Fetch the latest tip of the configured branch. The clone is shallow + single-branch,
        // so we need an explicit branch name here — `git pull origin HEAD` would resolve to the
        // remote's default branch (typically main), not the branch the project is tracking.
        const fetchResult = await SandboxService.exec(
            projectId, 'git',
            ['fetch', '--depth', '1', 'origin', branch],
            dir,
        );
        if (fetchResult.exitCode !== 0) {
            throw new Error(`Git fetch failed: ${fetchResult.stderr}`);
        }

        const resetResult = await SandboxService.exec(
            projectId, 'git',
            ['reset', '--hard', `origin/${branch}`],
            dir,
        );
        if (resetResult.exitCode !== 0) {
            throw new Error(`Git reset failed: ${resetResult.stderr}`);
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
        // Reject malformed signatures up front — timingSafeEqual throws on length mismatch
        if (!/^sha256=[0-9a-f]{64}$/.test(signature)) {
            return false;
        }
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(payload);
        const digest = `sha256=${hmac.digest('hex')}`;
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    }

    static async handlePushEvent(projectId: string, commit?: { sha?: string; message?: string }): Promise<void> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: ['githubRepo'],
        });

        if (!project || !project.githubRepo) return;
        const githubRepo = project.githubRepo;

        // Update status to deploying
        await projectRepo.update(projectId, { status: ServiceStatus.DEPLOYING });

        // Coalesced pushes deploy whatever is at the branch tip, which may be
        // newer than this push — resolve the actually checked-out commit after
        // the pull so the history records what really went out.
        const deployed = { sha: commit?.sha, message: commit?.message };

        try {
            // Pull + restart as one unit under the project lock, so a push
            // arriving mid-build can't reset the working tree under the build
            // or spawn a second concurrent one.
            const ran = await ProcessService.redeploy(projectId, async () => {
                await GithubService.pullLatest(projectId, project.directoryPath, githubRepo.branch);

                const head = await SandboxService.exec(
                    projectId, 'git',
                    ['log', '-1', '--pretty=%H%n%s'],
                    project.directoryPath,
                );
                if (head.exitCode === 0) {
                    const [sha, message] = head.stdout.trim().split('\n');
                    if (sha) {
                        deployed.sha = sha;
                        deployed.message = message;
                    }
                }

                const repoRepo = AppDataSource.getRepository(GithubRepo);
                githubRepo.lastDeployAt = new Date();
                await repoRepo.save(githubRepo);
            });

            // Dropped (coalesced) requests don't deploy anything — the queued
            // run records its own deployment.
            if (ran) {
                await GithubService.recordDeployment(projectId, {
                    status: 'success',
                    trigger: 'webhook',
                    branch: githubRepo.branch,
                    commitSha: deployed.sha,
                    commitMessage: deployed.message,
                });
            }
        } catch (error: any) {
            // Update only the status — doStop/doStart persisted fresh
            // containerId/port values that this stale entity must not overwrite.
            await projectRepo.update(projectId, { status: ServiceStatus.ERROR });
            await GithubService.recordDeployment(projectId, {
                status: 'failed',
                trigger: 'webhook',
                branch: githubRepo.branch,
                commitSha: deployed.sha,
                commitMessage: deployed.message,
                error: error?.message,
            }).catch(() => { });
            throw error;
        }
    }

    static async recordDeployment(projectId: string, data: {
        status: DeploymentStatus;
        trigger: DeploymentTrigger;
        branch: string;
        commitSha?: string;
        commitMessage?: string;
        error?: string;
    }): Promise<Deployment> {
        const deployRepo = AppDataSource.getRepository(Deployment);
        const deployment = deployRepo.create({ projectId, ...data });
        return deployRepo.save(deployment);
    }

    /**
     * Re-deploy the project at the commit recorded in a previous deployment.
     * Fetches the commit explicitly (clones are shallow, so it may no longer
     * be present locally), resets the working tree to it, and rebuilds.
     */
    static async rollbackToDeployment(projectId: string, deploymentId: string): Promise<Deployment> {
        const deployRepo = AppDataSource.getRepository(Deployment);
        const target = await deployRepo.findOne({ where: { id: deploymentId, projectId } });
        if (!target) {
            throw new AppError('Deployment not found', 404);
        }
        // Require a full, non-zero SHA: GitHub's upload-pack only serves
        // fetch-by-SHA for full hashes, and an all-zeros SHA marks a branch
        // deletion, not a commit.
        if (!target.commitSha || !/^[0-9a-f]{40}$/i.test(target.commitSha) || /^0{40}$/.test(target.commitSha)) {
            throw new AppError('This deployment has no commit recorded to roll back to', 400);
        }

        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: ['githubRepo'],
        });
        if (!project || !project.githubRepo) {
            throw new AppError('No GitHub repo connected to this project', 400);
        }

        await projectRepo.update(projectId, { status: ServiceStatus.DEPLOYING });

        const commitSha = target.commitSha;
        try {
            await ProcessService.redeployExclusive(projectId, async () => {
                const fetchResult = await SandboxService.exec(
                    projectId, 'git',
                    ['fetch', '--depth', '1', 'origin', commitSha],
                    project.directoryPath,
                );
                if (fetchResult.exitCode !== 0) {
                    throw new Error(`Git fetch failed: ${fetchResult.stderr}`);
                }

                const resetResult = await SandboxService.exec(
                    projectId, 'git',
                    ['reset', '--hard', commitSha],
                    project.directoryPath,
                );
                if (resetResult.exitCode !== 0) {
                    throw new Error(`Git reset failed: ${resetResult.stderr}`);
                }
            });

            return await GithubService.recordDeployment(projectId, {
                status: 'success',
                trigger: 'rollback',
                branch: project.githubRepo.branch,
                commitSha,
                commitMessage: target.commitMessage,
            });
        } catch (error: any) {
            // Update only the status — doStop/doStart persisted fresh
            // containerId/port values that this stale entity must not overwrite.
            await projectRepo.update(projectId, { status: ServiceStatus.ERROR });
            await GithubService.recordDeployment(projectId, {
                status: 'failed',
                trigger: 'rollback',
                branch: project.githubRepo.branch,
                commitSha,
                commitMessage: target.commitMessage,
                error: error?.message,
            }).catch(() => { });
            throw error;
        }
    }
}
