import crypto from 'crypto';
import { SandboxService } from './sandbox.service';
import { AppDataSource } from '../config/data-source';
import { GithubRepo, Project, ServiceStatus, Deployment } from '../entities';
import type { DeploymentStatus, DeploymentTrigger, DeployStrategyValue, HealthGateValue } from '../entities/Deployment';
import { ProcessService } from './process.service';
import { DeployError } from './deployError';
import { NotificationService } from './notification.service';
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
            throw new AppError('Invalid repository URL: must be an https://github.com/owner/repo URL', 400);
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
            // A clone failure is almost always the caller's input (wrong/private
            // URL, missing branch, no access) — a 4xx the UI can show, not a
            // server fault that surfaces as an opaque 500. Map git's stderr to an
            // actionable AppError, and scrub any injected token first so it can
            // never reach the response or logs verbatim.
            throw GithubService.cloneError(result.stderr, branch, token);
        }
    }

    /** Translate `git clone` stderr into an actionable, token-free AppError. */
    private static cloneError(stderr: string, branch: string, token?: string): AppError {
        let safe = (stderr || '').trim();
        if (token) safe = safe.split(token).join('***');
        // git also embeds the token in the remote URL it echoes back.
        safe = safe.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');

        if (/Remote branch .* not found|Could not find remote branch/i.test(safe)) {
            return new AppError(`Branch "${branch}" was not found in the repository.`, 422);
        }
        if (/Repository not found|could not read Username|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied/i.test(safe)) {
            return new AppError(
                'Repository not found or not accessible. Check the URL, and that your connected GitHub account has access to it (private repos need a GitHub connection).',
                422,
            );
        }
        return new AppError(`Could not clone repository: ${safe}`, 422);
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
                events: ['push', 'pull_request'],
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

    /**
     * PATCH an existing webhook so it is subscribed to the given events. Used
     * when previews are enabled on a repo whose webhook was created before
     * preview support (push-only). Best-effort: throws only on a hard API error.
     */
    static async ensureWebhookEvents(
        repoUrl: string,
        token: string,
        webhookId: string,
        events: string[],
    ): Promise<void> {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) throw new Error('Invalid GitHub repo URL');
        const [, owner, repo] = match;

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks/${webhookId}`, {
            method: 'PATCH',
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ events }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Failed to update webhook events: ${error}`);
        }
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
            // Pull + redeploy as one unit under the project lock, so a push
            // arriving mid-build can't reset the working tree under the build
            // or spawn a second concurrent one.
            const result = await ProcessService.redeploy(projectId, async () => {
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
            if (result.ran) {
                await GithubService.recordDeployment(projectId, {
                    status: 'success',
                    trigger: 'webhook',
                    branch: githubRepo.branch,
                    commitSha: deployed.sha,
                    commitMessage: deployed.message,
                    strategy: result.strategy,
                    durationMs: result.durationMs,
                    healthGate: result.healthGate,
                    strategyReason: result.strategyReason,
                });
                await NotificationService.notify(project, {
                    event: 'deploy.success',
                    title: `${project.name} deployed`,
                    message: deployed.message || 'Deployed latest push',
                    success: true,
                    meta: { branch: githubRepo.branch, commit: deployed.sha?.slice(0, 7) },
                });
            }
        } catch (error: any) {
            // A failed zero-downtime deploy leaves the OLD version serving —
            // status must say RUNNING, not ERROR, or the UI lies and the
            // health monitor "fixes" a healthy site. Update only the status —
            // the deploy may have persisted fresh containerId/port values
            // that this stale entity must not overwrite.
            const stillServing = error instanceof DeployError && error.stillServing;
            await projectRepo.update(projectId, {
                status: stillServing ? ServiceStatus.RUNNING : ServiceStatus.ERROR,
            });
            if (stillServing) ProcessService.emitStatus(projectId, ServiceStatus.RUNNING);
            await GithubService.recordDeployment(projectId, {
                status: 'failed',
                trigger: 'webhook',
                branch: githubRepo.branch,
                commitSha: deployed.sha,
                commitMessage: deployed.message,
                error: error?.message,
                stillServing,
                strategy: error instanceof DeployError ? error.strategy : undefined,
            }).catch(() => { });
            await NotificationService.notify(project, {
                event: 'deploy.failed',
                title: `${project.name} deploy failed`,
                message: stillServing
                    ? `${error?.message || 'Deployment failed'} — previous version kept serving, visitors saw nothing.`
                    : error?.message || 'Deployment failed',
                success: false,
                meta: { branch: githubRepo.branch, commit: deployed.sha?.slice(0, 7) },
            });
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
        strategy?: DeployStrategyValue;
        stillServing?: boolean;
        durationMs?: number;
        healthGate?: HealthGateValue;
        strategyReason?: string;
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
            const result = await ProcessService.redeployExclusive(projectId, async () => {
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

            const recorded = await GithubService.recordDeployment(projectId, {
                status: 'success',
                trigger: 'rollback',
                branch: project.githubRepo.branch,
                commitSha,
                commitMessage: target.commitMessage,
                strategy: result.strategy,
                durationMs: result.durationMs,
                healthGate: result.healthGate,
                strategyReason: result.strategyReason,
            });
            await NotificationService.notify(project, {
                event: 'rollback.success',
                title: `${project.name} rolled back`,
                message: target.commitMessage || 'Rolled back to previous deployment',
                success: true,
                meta: { branch: project.githubRepo.branch, commit: commitSha.slice(0, 7) },
            });
            return recorded;
        } catch (error: any) {
            // Same contract as handlePushEvent: a failed zero-downtime
            // rollback leaves the previous version serving → RUNNING. Update
            // only the status — the deploy may have persisted fresh
            // containerId/port values that this stale entity must not overwrite.
            const stillServing = error instanceof DeployError && error.stillServing;
            await projectRepo.update(projectId, {
                status: stillServing ? ServiceStatus.RUNNING : ServiceStatus.ERROR,
            });
            if (stillServing) ProcessService.emitStatus(projectId, ServiceStatus.RUNNING);
            await GithubService.recordDeployment(projectId, {
                status: 'failed',
                trigger: 'rollback',
                branch: project.githubRepo.branch,
                commitSha,
                commitMessage: target.commitMessage,
                error: error?.message,
                stillServing,
                strategy: error instanceof DeployError ? error.strategy : undefined,
            }).catch(() => { });
            await NotificationService.notify(project, {
                event: 'rollback.failed',
                title: `${project.name} rollback failed`,
                message: stillServing
                    ? `${error?.message || 'Rollback failed'} — current version kept serving, visitors saw nothing.`
                    : error?.message || 'Rollback failed',
                success: false,
                meta: { branch: project.githubRepo.branch, commit: commitSha.slice(0, 7) },
            });
            throw error;
        }
    }
}
