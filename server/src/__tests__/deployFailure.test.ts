import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/sandbox.service', () => ({ SandboxService: { exec: vi.fn() } }));
vi.mock('../services/process.service', () => ({
    ProcessService: { redeployExclusive: vi.fn(), redeploy: vi.fn(), emitStatus: vi.fn() },
}));
vi.mock('../services/notification.service', () => ({ NotificationService: { notify: vi.fn() } }));
vi.mock('../config/data-source', () => ({ AppDataSource: { getRepository: vi.fn() } }));

import { GithubService } from '../services/github.service';
import { ProcessService } from '../services/process.service';
import { NotificationService } from '../services/notification.service';
import { AppDataSource } from '../config/data-source';
import { DeployError } from '../services/deployError';
import { Project, Deployment, ServiceStatus } from '../entities';

const SHA = 'c'.repeat(40);
const project = { id: 'proj-1', name: 'demo' } as any;

let projectRepo: any;
let deployRepo: any;

beforeEach(() => {
    vi.clearAllMocks();
    projectRepo = { update: vi.fn(async () => undefined) };
    deployRepo = { create: vi.fn((d: any) => d), save: vi.fn(async (d: any) => ({ id: 'dep-1', ...d })) };
    vi.mocked(AppDataSource.getRepository).mockImplementation((entity: any) => {
        if (entity === Project) return projectRepo;
        if (entity === Deployment) return deployRepo;
        throw new Error('unexpected repository');
    });
});

const call = (opts: any, error: any) => (GithubService as any).recordDeployFailure(project, opts, error);

describe('GithubService.recordDeployFailure', () => {
    it('marks the project errored and records the failure when nothing is serving', async () => {
        const stillServing = await call(
            { kind: 'deploy', trigger: 'webhook', branch: 'main', commitSha: SHA },
            new Error('build blew up'),
        );

        expect(stillServing).toBe(false);
        expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: ServiceStatus.ERROR });
        expect(ProcessService.emitStatus).not.toHaveBeenCalled();
        expect(deployRepo.create).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed', trigger: 'webhook', branch: 'main', commitSha: SHA,
            error: 'build blew up', stillServing: false,
        }));
        expect(NotificationService.notify).toHaveBeenCalledWith(project, expect.objectContaining({
            event: 'deploy.failed', title: 'demo deploy failed', success: false,
        }));
    });

    it('keeps the project running when the old version still serves', async () => {
        const err = new DeployError('health gate failed', true, 'blue-green');
        const stillServing = await call({ kind: 'deploy', trigger: 'manual', branch: 'main' }, err);

        expect(stillServing).toBe(true);
        expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: ServiceStatus.RUNNING });
        expect(ProcessService.emitStatus).toHaveBeenCalledWith('proj-1', ServiceStatus.RUNNING);
        expect(deployRepo.create).toHaveBeenCalledWith(expect.objectContaining({
            trigger: 'manual', stillServing: true, strategy: 'blue-green',
        }));
        expect(NotificationService.notify).toHaveBeenCalledWith(project, expect.objectContaining({
            message: expect.stringContaining('previous version kept serving'),
        }));
    });

    it('uses rollback copy for the rollback kind', async () => {
        const err = new DeployError('rollback broke', true, 'recreate');
        await call({ kind: 'rollback', trigger: 'rollback', branch: 'main', commitSha: SHA }, err);

        expect(NotificationService.notify).toHaveBeenCalledWith(project, expect.objectContaining({
            event: 'rollback.failed',
            title: 'demo rollback failed',
            message: expect.stringContaining('current version kept serving'),
        }));
    });

    it('stores the deploy log and puts its last lines in the notification', async () => {
        deployRepo.query = vi.fn(async () => undefined);
        const err: any = new DeployError('Railpack build failed with exit code 1', true, 'blue-green');
        err.deployLog = 'Building…\nnpm ERR! missing script: build\n\n❌ Deploy failed: Railpack build failed with exit code 1\n';

        await call({ kind: 'deploy', trigger: 'webhook', branch: 'main' }, err);

        expect(deployRepo.create).toHaveBeenCalledWith(expect.objectContaining({ log: err.deployLog }));
        // Older rows of this project lose their log
        expect(deployRepo.query).toHaveBeenCalledWith(expect.stringContaining('SET "log" = NULL'), ['proj-1']);
        const message = vi.mocked(NotificationService.notify).mock.calls[0][1].message;
        expect(message).toContain('Last log lines:\nBuilding…\nnpm ERR! missing script: build');
        expect(message).not.toContain('❌');
    });

    it('adds no log section when the deploy never reached the build', async () => {
        await call({ kind: 'deploy', trigger: 'webhook', branch: 'main' }, new Error('Git pull failed'));

        const message = vi.mocked(NotificationService.notify).mock.calls[0][1].message;
        expect(message).toBe('Git pull failed');
    });

    it('does not throw when recording the deployment row fails', async () => {
        deployRepo.save = vi.fn(async () => { throw new Error('db down'); });

        await expect(call({ kind: 'deploy', trigger: 'webhook', branch: 'main' }, new Error('x'))).resolves.toBe(false);
    });
});
