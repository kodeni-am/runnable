import { AppDataSource } from '../config/data-source';
import { Project, GithubRepo, ServiceStatus, ServerType, User } from '../entities';
import { ProjectProvisioningService } from './projectProvisioning.service';
import { ProjectTeardownService } from './projectTeardown.service';
import { ProcessService } from './process.service';
import { GithubService } from './github.service';
import { NotificationService } from './notification.service';
import { isForkPR, derivePreviewSubdomain, mergePreviewEnv, previewHostname, isPreviewExpired, type PullRequestInfo } from './preview.helpers';

export type PullRequestAction = 'opened' | 'reopened' | 'synchronize' | 'closed' | string;

export class PreviewService {
    // Serialize create/update/destroy per (parentProjectId, prNumber). The
    // project lock can't cover a preview that doesn't exist yet, so a fast
    // opened→synchronize burst would otherwise race. Same promise-chain pattern
    // as ProcessService.withProjectLock.
    private static readonly prLocks = new Map<string, Promise<unknown>>();

    private static withPreviewLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = PreviewService.prLocks.get(key) ?? Promise.resolve();
        const next = prev.catch(() => { }).then(fn);
        PreviewService.prLocks.set(key, next);
        next.finally(() => {
            if (PreviewService.prLocks.get(key) === next) PreviewService.prLocks.delete(key);
        }).catch(() => { });
        return next;
    }

    /**
     * Entry point from the webhook receiver. `parent` is the resolved
     * non-preview project (with githubRepo relation). Returns a short status
     * string for logging. Guards (previewsEnabled, fork, base domain) live
     * here so the receiver stays thin.
     */
    static async handlePullRequest(parent: Project, action: PullRequestAction, pr: PullRequestInfo): Promise<string> {
        if (!parent.previewsEnabled || !parent.previewBaseDomain) {
            return 'previews-disabled';
        }
        if (isForkPR(pr)) {
            return 'fork-skipped';
        }

        const key = `${parent.id}:${pr.number}`;
        if (action === 'opened' || action === 'reopened' || action === 'synchronize') {
            return PreviewService.withPreviewLock(key, () => PreviewService.createOrUpdate(parent, pr));
        }
        if (action === 'closed') {
            return PreviewService.withPreviewLock(key, () => PreviewService.destroyForPr(parent.id, pr.number));
        }
        return 'ignored-action';
    }

    private static async findPreview(parentProjectId: string, prNumber: number): Promise<Project | null> {
        return AppDataSource.getRepository(Project).findOne({
            where: { parentProjectId, prNumber, isPreview: true },
            relations: ['githubRepo'],
        });
    }

    private static async createOrUpdate(parent: Project, pr: PullRequestInfo): Promise<string> {
        const existing = await PreviewService.findPreview(parent.id, pr.number);
        if (existing) {
            await PreviewService.redeployExisting(existing, pr);
            return 'redeployed';
        }
        await PreviewService.createNew(parent, pr);
        return 'created';
    }

    private static async createNew(parent: Project, pr: PullRequestInfo): Promise<void> {
        if (!parent.githubRepo) throw new Error('Parent project has no connected GitHub repo');

        const owner = await AppDataSource.getRepository(User).findOne({ where: { id: parent.userId } });
        if (!owner) throw new Error('Parent project owner not found');

        const subdomain = derivePreviewSubdomain(parent.subdomain, pr.number, parent.id);
        const baseDomain = parent.previewBaseDomain!;
        const env = mergePreviewEnv(parent.envVars, parent.previewEnvOverrides, {
            RUNNABLE_PREVIEW_URL: `https://${previewHostname(subdomain, baseDomain)}`,
            PR_NUMBER: String(pr.number),
        });

        const preview = await ProjectProvisioningService.provisionCore(
            owner,
            `${parent.name} PR #${pr.number}`,
            subdomain,
            parent.serverType as ServerType,
            {
                isPreview: true,
                parentProjectId: parent.id,
                prNumber: pr.number,
                prBranch: pr.head.ref,
                baseDomain,
                buildCommand: parent.buildCommand,
                startCommand: parent.startCommand,
                useCompose: parent.useCompose,
                composeFile: parent.composeFile,
                composeService: parent.composeService,
                internalPort: parent.internalPort,
                notificationWebhookUrl: parent.notificationWebhookUrl,
                envVars: env,
            },
        );

        // The preview gets its own GithubRepo row (same URL, PR head branch),
        // but NO webhook — the parent's single webhook drives all its previews.
        const repoRepo = AppDataSource.getRepository(GithubRepo);
        await repoRepo.save(repoRepo.create({
            repoUrl: parent.githubRepo.repoUrl,
            branch: pr.head.ref,
            isPrivate: parent.githubRepo.isPrivate,
            projectId: preview.id,
        }));

        const token = owner.githubToken || undefined;
        await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.DEPLOYING });

        try {
            await GithubService.cloneRepo(preview.id, parent.githubRepo.repoUrl, preview.directoryPath, pr.head.ref, token);
            await ProcessService.start(preview.id);
            await AppDataSource.getRepository(Project).update(preview.id, { lastActivityAt: new Date() });
            await GithubService.recordDeployment(preview.id, {
                status: 'success', trigger: 'webhook', branch: pr.head.ref,
                commitMessage: `Preview for PR #${pr.number}`,
            });
            await NotificationService.notify(preview, {
                event: 'preview.deployed',
                title: `Preview for ${parent.name} PR #${pr.number} is up`,
                message: `https://${previewHostname(subdomain, baseDomain)}`,
                success: true,
                meta: { pr: String(pr.number), branch: pr.head.ref },
            });
        } catch (error: any) {
            await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.ERROR });
            await GithubService.recordDeployment(preview.id, {
                status: 'failed', trigger: 'webhook', branch: pr.head.ref,
                error: error?.message,
            }).catch(() => { });
            await NotificationService.notify(preview, {
                event: 'preview.failed',
                title: `Preview for ${parent.name} PR #${pr.number} failed`,
                message: error?.message || 'Preview build failed',
                success: false,
                meta: { pr: String(pr.number), branch: pr.head.ref },
            });
        }
    }

    private static async redeployExisting(preview: Project, pr: PullRequestInfo): Promise<void> {
        await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.DEPLOYING });
        try {
            const ran = await ProcessService.redeploy(preview.id, async () => {
                await GithubService.pullLatest(preview.id, preview.directoryPath, pr.head.ref);
            });
            if (ran) {
                await AppDataSource.getRepository(Project).update(preview.id, { lastActivityAt: new Date() });
                await GithubService.recordDeployment(preview.id, {
                    status: 'success', trigger: 'webhook', branch: pr.head.ref,
                    commitMessage: `Preview update for PR #${pr.number}`,
                });
            }
        } catch (error: any) {
            await AppDataSource.getRepository(Project).update(preview.id, { status: ServiceStatus.ERROR });
            await GithubService.recordDeployment(preview.id, {
                status: 'failed', trigger: 'webhook', branch: pr.head.ref, error: error?.message,
            }).catch(() => { });
            await NotificationService.notify(preview, {
                event: 'preview.failed',
                title: `Preview update for PR #${pr.number} failed`,
                message: error?.message || 'Preview redeploy failed',
                success: false,
                meta: { pr: String(pr.number), branch: pr.head.ref },
            });
        }
    }

    private static async destroyForPr(parentProjectId: string, prNumber: number): Promise<string> {
        const preview = await PreviewService.findPreview(parentProjectId, prNumber);
        if (!preview) return 'no-preview';
        // Previews own no webhook, so no token is needed for teardown.
        await ProjectTeardownService.teardown(preview, undefined);
        return 'destroyed';
    }

    /** List a parent's preview environments, newest first. */
    static async listForParent(parentProjectId: string): Promise<Project[]> {
        return AppDataSource.getRepository(Project).find({
            where: { parentProjectId, isPreview: true },
            order: { createdAt: 'DESC' },
        });
    }

    /**
     * Manually destroy one preview (from the Previews tab). Verifies it belongs
     * to the parent, then tears it down under the per-PR lock so it can't race
     * a concurrent webhook event for the same PR. Returns false if not found.
     */
    static async destroyPreview(parentProjectId: string, previewId: string): Promise<boolean> {
        const preview = await AppDataSource.getRepository(Project).findOne({
            where: { id: previewId, parentProjectId, isPreview: true },
            relations: ['githubRepo'],
        });
        if (!preview) return false;
        const key = `${parentProjectId}:${preview.prNumber}`;
        await PreviewService.withPreviewLock(key, () => ProjectTeardownService.teardown(preview, undefined));
        return true;
    }

    /**
     * Tear down previews idle longer than their parent's previewTtlDays.
     * Fire-and-forget per preview (serialized per PR) so a batch never stalls
     * the caller (the health-monitor interval).
     */
    static async reapExpired(nowMs: number): Promise<void> {
        const previews = await AppDataSource.getRepository(Project).find({
            where: { isPreview: true },
            relations: ['parentProject', 'githubRepo'],
        });
        for (const preview of previews) {
            const ttl = preview.parentProject?.previewTtlDays ?? 7;
            if (isPreviewExpired(preview.lastActivityAt, ttl, nowMs)) {
                const key = `${preview.parentProjectId}:${preview.prNumber}`;
                PreviewService.withPreviewLock(key, () => ProjectTeardownService.teardown(preview, undefined))
                    .catch((err) => console.error(`Failed to reap preview ${preview.id}:`, err));
            }
        }
    }
}
