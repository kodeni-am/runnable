import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all heavy collaborators BEFORE importing the service.
const findOne = vi.fn();
const update = vi.fn();
const save = vi.fn((x) => x);
const create = vi.fn((x) => x);
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: () => ({ findOne, update, save, create }) },
}));
const provisionCore = vi.fn();
vi.mock('../projectProvisioning.service', () => ({
    ProjectProvisioningService: { provisionCore: (...a: any[]) => provisionCore(...a) },
}));
const teardown = vi.fn();
vi.mock('../projectTeardown.service', () => ({
    ProjectTeardownService: { teardown: (...a: any[]) => teardown(...a) },
}));
const loadRegistryToken = vi.fn(async (_projectId: string): Promise<string | null> => null);
vi.mock('../process.service', () => ({
    ProcessService: { start: vi.fn(), redeploy: vi.fn(async () => true), captureDeployLog: vi.fn(async () => undefined), loadRegistryToken: (id: string) => loadRegistryToken(id) },
}));
vi.mock('../github.service', () => ({
    GithubService: { cloneRepo: vi.fn(), pullLatest: vi.fn(), recordDeployment: vi.fn() },
}));
vi.mock('../notification.service', () => ({
    NotificationService: { notify: vi.fn() },
}));

import { PreviewService } from '../preview.service';
import type { PullRequestInfo } from '../preview.helpers';

const parent: any = {
    id: 'parent-1', name: 'App', subdomain: 'app', userId: 'owner-1',
    serverType: 'app', previewsEnabled: true, previewBaseDomain: 'preview.example.com',
    githubRepo: { repoUrl: 'https://github.com/acme/app', isPrivate: false, branch: 'main' },
    envVars: {}, previewEnvOverrides: {},
};
const pr: PullRequestInfo = {
    number: 5, head: { ref: 'feat/x', repo: { full_name: 'acme/app' } }, base: { repo: { full_name: 'acme/app' } },
};

beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockReset();
    loadRegistryToken.mockReset();
    loadRegistryToken.mockResolvedValue(null);
});

describe('PreviewService.handlePullRequest guards', () => {
    it('skips when previews are disabled', async () => {
        const r = await PreviewService.handlePullRequest({ ...parent, previewsEnabled: false }, 'opened', pr);
        expect(r).toBe('previews-disabled');
        expect(provisionCore).not.toHaveBeenCalled();
    });
    it('skips fork PRs', async () => {
        const forkPr: PullRequestInfo = { ...pr, head: { ref: 'x', repo: { full_name: 'evil/app' } } };
        const r = await PreviewService.handlePullRequest(parent, 'opened', forkPr);
        expect(r).toBe('fork-skipped');
        expect(provisionCore).not.toHaveBeenCalled();
    });
});

describe('PreviewService routing', () => {
    it('creates a new preview when none exists on opened', async () => {
        findOne.mockResolvedValueOnce(null);                 // findPreview → none
        findOne.mockResolvedValueOnce({ id: 'owner-1', githubToken: 't' }); // owner
        provisionCore.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x', });
        const r = await PreviewService.handlePullRequest(parent, 'opened', pr);
        expect(r).toBe('created');
        expect(provisionCore).toHaveBeenCalledOnce();
    });

    it('propagates the parent\'s private registry config to a new preview, fetching the select:false ciphertext explicitly', async () => {
        const registryParent = {
            ...parent,
            npmRegistryUrl: 'https://npm.pkg.github.com/',
            npmRegistryScope: '@acme',
            // Not set here: a normally-loaded/joined project never carries
            // npmAuthTokenEncrypted (select: false), so the fix must not
            // depend on it being present on `parent`.
        };
        findOne.mockResolvedValueOnce(null);                 // findPreview → none
        findOne.mockResolvedValueOnce({ id: 'owner-1', githubToken: 't' }); // owner
        loadRegistryToken.mockResolvedValueOnce('cipher-x');
        provisionCore.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x' });

        const r = await PreviewService.handlePullRequest(registryParent, 'opened', pr);

        expect(r).toBe('created');
        expect(loadRegistryToken).toHaveBeenCalledWith('parent-1');
        const extras = provisionCore.mock.calls[0][4];
        expect(extras.npmRegistryUrl).toBe('https://npm.pkg.github.com/');
        expect(extras.npmRegistryScope).toBe('@acme');
        expect(extras.npmAuthTokenEncrypted).toBe('cipher-x');
    });

    it('does not look up a registry token for a parent with no registry configured', async () => {
        findOne.mockResolvedValueOnce(null);
        findOne.mockResolvedValueOnce({ id: 'owner-1', githubToken: 't' });
        provisionCore.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x' });

        await PreviewService.handlePullRequest(parent, 'opened', pr);

        expect(loadRegistryToken).not.toHaveBeenCalled();
        const extras = provisionCore.mock.calls[0][4];
        expect(extras.npmAuthTokenEncrypted).toBeUndefined();
    });

    it('redeploys when a preview already exists on synchronize', async () => {
        findOne.mockResolvedValueOnce({ id: 'preview-1', directoryPath: '/srv/x' }); // findPreview → exists
        const r = await PreviewService.handlePullRequest(parent, 'synchronize', pr);
        expect(r).toBe('redeployed');
        expect(provisionCore).not.toHaveBeenCalled();
    });

    it('tears down on closed', async () => {
        findOne.mockResolvedValueOnce({ id: 'preview-1' }); // findPreview → exists
        const r = await PreviewService.handlePullRequest(parent, 'closed', pr);
        expect(r).toBe('destroyed');
        expect(teardown).toHaveBeenCalledOnce();
    });

    it('serializes a fast opened→synchronize burst (no double create)', async () => {
        findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'owner-1', githubToken: 't' });
        provisionCore.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x' });
        findOne.mockResolvedValue({ id: 'preview-1', directoryPath: '/srv/x' });

        const p1 = PreviewService.handlePullRequest(parent, 'opened', pr);
        const p2 = PreviewService.handlePullRequest(parent, 'synchronize', pr);
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1).toBe('created');
        expect(r2).toBe('redeployed');
        expect(provisionCore).toHaveBeenCalledOnce();
    });
});
