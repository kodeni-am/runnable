import { describe, it, expect, vi, beforeEach } from 'vitest';

// cloneRepo only needs SandboxService; mock the heavy collaborators the module
// pulls in at import time so the real GithubService.cloneRepo runs in isolation.
const exec = vi.fn();
vi.mock('../sandbox.service', () => ({
    SandboxService: { exec: (...a: any[]) => exec(...a) },
}));
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: () => ({}) },
}));

import { GithubService } from '../github.service';
import { AppError } from '../../middleware/errorHandler';

const PROJECT_ID = 'c5891f32-1111-2222-3333-444455556666';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('GithubService.cloneRepo error classification', () => {
    it('throws a 400 AppError for a malformed repo URL (not a generic 500)', async () => {
        const err = await GithubService.cloneRepo(PROJECT_ID, 'not-a-url', '/tmp/x').catch((e) => e);
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(400);
        expect(exec).not.toHaveBeenCalled();
    });

    it('throws a 422 AppError (not a generic 500) when GitHub reports the repo not found', async () => {
        exec.mockResolvedValue({
            stdout: '',
            stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/kodeni-am/loop/' not found",
            exitCode: 128,
        });

        const err = await GithubService.cloneRepo(
            PROJECT_ID,
            'https://github.com/kodeni-am/loop',
            '/var/runnable/projects/loop',
            'main',
        ).catch((e) => e);

        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(422);
        // Message must be actionable and must never echo back an injected token.
        expect((err as AppError).message).toMatch(/not found|access/i);
    });

    it('reports a missing branch as a 422 AppError naming the branch', async () => {
        exec.mockResolvedValue({
            stdout: '',
            stderr: "fatal: Remote branch nope not found in upstream origin",
            exitCode: 128,
        });

        const err = await GithubService.cloneRepo(
            PROJECT_ID,
            'https://github.com/acme/app',
            '/var/runnable/projects/app',
            'nope',
        ).catch((e) => e);

        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(422);
        expect((err as AppError).message).toContain('nope');
    });

    it('never leaks an injected access token in the error message', async () => {
        exec.mockResolvedValue({
            stdout: '',
            stderr: "fatal: could not read Username for 'https://x-access-token:gho_SECRET123@github.com': terminal prompts disabled",
            exitCode: 128,
        });

        const err = await GithubService.cloneRepo(
            PROJECT_ID,
            'https://github.com/acme/app',
            '/var/runnable/projects/app',
            'main',
            'gho_SECRET123',
        ).catch((e) => e);

        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).message).not.toContain('gho_SECRET123');
    });
});
