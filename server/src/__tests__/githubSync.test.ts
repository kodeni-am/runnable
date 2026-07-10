import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/sandbox.service', () => ({
    SandboxService: { exec: vi.fn() },
}));
vi.mock('../services/process.service', () => ({
    ProcessService: { redeployExclusive: vi.fn(), emitStatus: vi.fn() },
}));
vi.mock('../services/notification.service', () => ({
    NotificationService: { notify: vi.fn() },
}));
vi.mock('../config/data-source', () => ({
    AppDataSource: { getRepository: vi.fn() },
}));

import { GithubService } from '../services/github.service';
import { SandboxService } from '../services/sandbox.service';
import { ProcessService } from '../services/process.service';
import { AppDataSource } from '../config/data-source';
import { Project, GithubRepo, Deployment, ServiceStatus } from '../entities';

const LOCAL_SHA = 'a'.repeat(40);
const REMOTE_SHA = 'b'.repeat(40);

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

/** Fake `git` that answers from the given local/remote SHAs. */
function stubGit(localSha: string, remoteSha: string) {
    vi.mocked(SandboxService.exec).mockImplementation(async (_p: any, _cmd: any, args: any) => {
        const a = (args as string[]).join(' ');
        if (a.startsWith('fetch')) return ok();
        if (a === 'rev-parse HEAD') return ok(`${localSha}\n`);
        if (a === 'rev-parse FETCH_HEAD') return ok(`${remoteSha}\n`);
        if (a.startsWith('reset')) return ok();
        if (a.startsWith('log')) return ok(`${remoteSha}\nnew commit subject\n`);
        throw new Error(`unexpected git invocation: ${a}`);
    });
}

let projectRepo: any;
let githubRepoRepo: any;
let deployRepo: any;

function stubProject(status: ServiceStatus) {
    projectRepo = {
        findOne: vi.fn(async () => ({
            id: 'proj-1',
            name: 'demo',
            status,
            directoryPath: '/srv/demo',
            githubRepo: { branch: 'main', repoUrl: 'https://github.com/o/r' },
        })),
        update: vi.fn(async () => undefined),
    };
    githubRepoRepo = { save: vi.fn(async (x: any) => x) };
    deployRepo = {
        create: vi.fn((d: any) => d),
        save: vi.fn(async (d: any) => ({ id: 'dep-1', ...d })),
    };
    vi.mocked(AppDataSource.getRepository).mockImplementation((entity: any) => {
        if (entity === Project) return projectRepo;
        if (entity === GithubRepo) return githubRepoRepo;
        if (entity === Deployment) return deployRepo;
        throw new Error('unexpected repository');
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    // Mirror the real redeployExclusive contract from Task 1.
    vi.mocked(ProcessService.redeployExclusive).mockImplementation(async (_id: any, prepare: any) => {
        if (await prepare() === false) return { ran: false };
        return { ran: true, strategy: 'blue-green', durationMs: 1234, healthGate: 'passed' };
    });
});

describe('GithubService.syncLatest', () => {
    it('skips the deploy when the branch tip is already checked out and the project is running', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, LOCAL_SHA);

        const result = await GithubService.syncLatest('proj-1');

        expect(result).toEqual({ deployed: false, upToDate: true, commitSha: LOCAL_SHA });
        expect(deployRepo.save).not.toHaveBeenCalled();
        expect(projectRepo.update).not.toHaveBeenCalled();
        const gitCalls = vi.mocked(SandboxService.exec).mock.calls.map((c: any) => (c[2] as string[])[0]);
        expect(gitCalls).not.toContain('reset');
    });

    it('deploys at the same commit when the project is not running', async () => {
        stubProject(ServiceStatus.ERROR);
        stubGit(LOCAL_SHA, LOCAL_SHA);

        const result = await GithubService.syncLatest('proj-1');

        expect(result.deployed).toBe(true);
        expect(result.upToDate).toBe(false);
        expect(deployRepo.save).toHaveBeenCalledOnce();
        expect(deployRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'manual', status: 'success', branch: 'main' }),
        );
    });

    it('resets to the branch tip and deploys when there is a new commit', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, REMOTE_SHA);

        const result = await GithubService.syncLatest('proj-1');

        expect(result.deployed).toBe(true);
        expect(result.commitSha).toBe(REMOTE_SHA);
        expect(SandboxService.exec).toHaveBeenCalledWith(
            'proj-1', 'git', ['reset', '--hard', 'FETCH_HEAD'], '/srv/demo',
        );
        expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: ServiceStatus.DEPLOYING });
        expect(deployRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'manual', commitSha: REMOTE_SHA, commitMessage: 'new commit subject' }),
        );
    });

    it('rethrows a fetch failure without marking the project errored', async () => {
        stubProject(ServiceStatus.RUNNING);
        vi.mocked(SandboxService.exec).mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'could not read Username' });

        await expect(GithubService.syncLatest('proj-1')).rejects.toThrow(/Git fetch failed/);
        expect(projectRepo.update).not.toHaveBeenCalled();
        expect(deployRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a project with no GitHub repo connected', async () => {
        stubProject(ServiceStatus.RUNNING);
        projectRepo.findOne = vi.fn(async () => ({ id: 'proj-1', status: ServiceStatus.RUNNING, directoryPath: '/srv/demo' }));

        await expect(GithubService.syncLatest('proj-1')).rejects.toThrow(/No GitHub repo connected/);
        expect(ProcessService.redeployExclusive).not.toHaveBeenCalled();
    });

    it('delegates a failure after the reset to recordDeployFailure and rethrows', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, REMOTE_SHA);
        // Simulate a deploy that fails *after* `prepare` has already reset the
        // working tree and returned `true` — unlike the fetch-failure test above,
        // `started` is true here, so syncLatest must delegate to
        // recordDeployFailure rather than rethrowing untouched.
        vi.mocked(ProcessService.redeployExclusive).mockImplementation(async (_id: any, prepare: any) => {
            await prepare();
            throw new Error('build failed');
        });

        await expect(GithubService.syncLatest('proj-1')).rejects.toThrow(/build failed/);

        // recordDeployFailure's observable effects: project marked ERROR (a
        // plain Error is not a DeployError, so nothing "kept serving"), and a
        // failed Deployment row recorded with the manual trigger.
        expect(projectRepo.update).toHaveBeenCalledWith('proj-1', { status: ServiceStatus.ERROR });
        expect(deployRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'manual', status: 'failed', branch: 'main', error: 'build failed' }),
        );
        expect(deployRepo.save).toHaveBeenCalled();
    });

    it('rebuilds at the same commit when force is set on a running project', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, LOCAL_SHA);

        const result = await GithubService.syncLatest('proj-1', { force: true });

        expect(result.deployed).toBe(true);
        expect(result.upToDate).toBe(false);
        expect(SandboxService.exec).toHaveBeenCalledWith(
            'proj-1', 'git', ['reset', '--hard', 'FETCH_HEAD'], '/srv/demo',
        );
        expect(deployRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'manual', status: 'success' }),
        );
    });

    it('still skips when force is absent on a running project at the tip', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, LOCAL_SHA);

        const result = await GithubService.syncLatest('proj-1');

        expect(result).toEqual({ deployed: false, upToDate: true, commitSha: LOCAL_SHA });
    });

    it('advances to the branch tip when force is set and the repo is behind', async () => {
        stubProject(ServiceStatus.RUNNING);
        stubGit(LOCAL_SHA, REMOTE_SHA);

        const result = await GithubService.syncLatest('proj-1', { force: true });

        expect(result.deployed).toBe(true);
        expect(result.commitSha).toBe(REMOTE_SHA);
    });
});
