import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { validateRegistryInput, serializeNpmRegistry } from '../routes/projects.routes';

describe('validateRegistryInput', () => {
    it('accepts an https url with no scope', () => {
        expect(validateRegistryInput('https://registry.npmjs.org/', undefined))
            .toEqual({ url: 'https://registry.npmjs.org/', scope: null });
    });

    it('accepts a valid scope', () => {
        expect(validateRegistryInput('https://npm.pkg.github.com/', '@acme'))
            .toEqual({ url: 'https://npm.pkg.github.com/', scope: '@acme' });
    });

    it('trims surrounding whitespace', () => {
        expect(validateRegistryInput('  https://registry.npmjs.org/  ', ' @acme '))
            .toEqual({ url: 'https://registry.npmjs.org/', scope: '@acme' });
    });

    it('rejects a non-http scheme', () => {
        expect(() => validateRegistryInput('ftp://registry.example.com/', null))
            .toThrow(/valid http/i);
    });

    it('rejects a non-absolute url', () => {
        expect(() => validateRegistryInput('registry.npmjs.org', null)).toThrow(/valid http/i);
        expect(() => validateRegistryInput('', null)).toThrow(/valid http/i);
    });

    it('rejects a scope without a leading @', () => {
        expect(() => validateRegistryInput('https://registry.npmjs.org/', 'acme'))
            .toThrow(/scope/i);
    });

    it('rejects a scope with illegal characters', () => {
        expect(() => validateRegistryInput('https://registry.npmjs.org/', '@ac me'))
            .toThrow(/scope/i);
        expect(() => validateRegistryInput('https://registry.npmjs.org/', '@AC/ME'))
            .toThrow(/scope/i);
    });
});

describe('serializeNpmRegistry', () => {
    it('reports configured when a url is set', () => {
        expect(serializeNpmRegistry({ npmRegistryUrl: 'https://r/', npmRegistryScope: '@a' } as any))
            .toEqual({ url: 'https://r/', scope: '@a', configured: true });
    });

    it('reports not configured when no url is set', () => {
        expect(serializeNpmRegistry({} as any))
            .toEqual({ url: null, scope: null, configured: false });
    });

    it('never includes the token', () => {
        const out: any = serializeNpmRegistry({
            npmRegistryUrl: 'https://r/',
            npmAuthTokenEncrypted: 'v1.a.b.c',
        } as any);
        expect(JSON.stringify(out)).not.toContain('v1.a.b.c');
        expect(out).not.toHaveProperty('npmAuthTokenEncrypted');
        expect(out).not.toHaveProperty('token');
    });
});

// --- Route-level tests -----------------------------------------------------
//
// These drive the real PUT/DELETE handlers through express + supertest, with
// the DB repository and auth/project-access middleware mocked out, following
// the pattern in passkeys.routes.test.ts.

vi.mock('../services/sandbox.service', () => ({ SandboxService: { exec: vi.fn() } }));
vi.mock('../services/process.service', () => ({
    ProcessService: { redeployExclusive: vi.fn(), redeploy: vi.fn(), emitStatus: vi.fn() },
}));
vi.mock('../services/healthMonitor.service', () => ({ HealthMonitorService: {} }));
vi.mock('../services/serverConfig.service', () => ({ ServerConfigService: {} }));
vi.mock('../services/projectProvisioning.service', () => ({ ProjectProvisioningService: {} }));
vi.mock('../services/projectTeardown.service', () => ({ ProjectTeardownService: {} }));
vi.mock('../services/github.service', () => ({ GithubService: {} }));
vi.mock('../services/preview.service', () => ({ PreviewService: {} }));
vi.mock('../config/data-source', () => ({ AppDataSource: { getRepository: vi.fn() } }));

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';

let currentProject: any;

vi.mock('../middleware/auth', () => ({
    authenticate: vi.fn((req: any, _res: any, next: any) => {
        req.user = { id: 'user-1', email: 'a@b.c', username: 'ara', role: 'user', isApproved: true };
        next();
    }),
    requireApproval: vi.fn((_req: any, _res: any, next: any) => next()),
    requireProjectAccess: vi.fn(() => (req: any, _res: any, next: any) => {
        req.project = currentProject;
        next();
    }),
}));

import projectRoutes from '../routes/projects.routes';
import { AppDataSource } from '../config/data-source';
import { errorHandler } from '../middleware/errorHandler';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);
    app.use(errorHandler);
    return app;
}

let projectRepo: { update: ReturnType<typeof vi.fn> };

beforeEach(() => {
    vi.clearAllMocks();
    currentProject = { id: PROJECT_ID, npmRegistryUrl: undefined, npmRegistryScope: undefined };
    projectRepo = { update: vi.fn(async () => undefined) };
    vi.mocked(AppDataSource.getRepository).mockImplementation(() => projectRepo as any);
});

describe('DELETE /:id/npm-registry', () => {
    it('returns 200 and clears all three fields with null (not undefined)', async () => {
        currentProject = { id: PROJECT_ID, npmRegistryUrl: 'https://r/', npmRegistryScope: '@a' };

        const res = await request(makeApp())
            .delete(`/api/projects/${PROJECT_ID}/npm-registry`)
            .expect(200);

        expect(res.body).toEqual({ message: 'Registry configuration removed' });
        expect(projectRepo.update).toHaveBeenCalledTimes(1);
        const [, payload] = projectRepo.update.mock.calls[0];
        expect(payload).toEqual({
            npmRegistryUrl: null,
            npmRegistryScope: null,
            npmAuthTokenEncrypted: null,
        });
        expect(payload.npmRegistryUrl).toBeNull();
        expect(payload.npmRegistryScope).toBeNull();
        expect(payload.npmAuthTokenEncrypted).toBeNull();
    });
});

describe('PUT /:id/npm-registry', () => {
    it('persists a null scope when omitted, and the response matches what was persisted', async () => {
        currentProject = { id: PROJECT_ID, npmRegistryUrl: undefined, npmRegistryScope: undefined };

        const res = await request(makeApp())
            .put(`/api/projects/${PROJECT_ID}/npm-registry`)
            .send({ url: 'https://registry.npmjs.org/', token: 'secret-token' })
            .expect(200);

        expect(projectRepo.update).toHaveBeenCalledTimes(1);
        const [, payload] = projectRepo.update.mock.calls[0];
        expect(payload.npmRegistryScope).toBeNull();
        expect(res.body.npmRegistry.scope).toBe(payload.npmRegistryScope);
        expect(res.body.npmRegistry).toEqual({
            url: 'https://registry.npmjs.org/',
            scope: null,
            configured: true,
        });
    });

    it('stores an encrypted token, never the raw token', async () => {
        currentProject = { id: PROJECT_ID, npmRegistryUrl: undefined, npmRegistryScope: undefined };
        const rawToken = 'super-secret-raw-token';

        await request(makeApp())
            .put(`/api/projects/${PROJECT_ID}/npm-registry`)
            .send({ url: 'https://registry.npmjs.org/', token: rawToken })
            .expect(200);

        const [, payload] = projectRepo.update.mock.calls[0];
        expect(typeof payload.npmAuthTokenEncrypted).toBe('string');
        expect(payload.npmAuthTokenEncrypted.length).toBeGreaterThan(0);
        expect(payload.npmAuthTokenEncrypted).not.toBe(rawToken);
        expect(payload.npmAuthTokenEncrypted).not.toContain(rawToken);
    });

    it('does not overwrite an existing token when the token is omitted', async () => {
        currentProject = {
            id: PROJECT_ID,
            npmRegistryUrl: 'https://registry.npmjs.org/',
            npmRegistryScope: '@old',
        };

        const res = await request(makeApp())
            .put(`/api/projects/${PROJECT_ID}/npm-registry`)
            .send({ url: 'https://registry.npmjs.org/', scope: '@new' })
            .expect(200);

        const [, payload] = projectRepo.update.mock.calls[0];
        expect(payload).not.toHaveProperty('npmAuthTokenEncrypted');
        expect(payload.npmRegistryScope).toBe('@new');
        expect(res.body.npmRegistry.scope).toBe('@new');
    });

    it('does not overwrite with a blank token', async () => {
        currentProject = {
            id: PROJECT_ID,
            npmRegistryUrl: 'https://registry.npmjs.org/',
            npmRegistryScope: '@old',
        };

        await request(makeApp())
            .put(`/api/projects/${PROJECT_ID}/npm-registry`)
            .send({ url: 'https://registry.npmjs.org/', token: '   ' })
            .expect(200);

        const [, payload] = projectRepo.update.mock.calls[0];
        expect(payload).not.toHaveProperty('npmAuthTokenEncrypted');
    });

    it('returns 400 when no token is provided and none is stored yet', async () => {
        currentProject = { id: PROJECT_ID, npmRegistryUrl: undefined, npmRegistryScope: undefined };

        await request(makeApp())
            .put(`/api/projects/${PROJECT_ID}/npm-registry`)
            .send({ url: 'https://registry.npmjs.org/' })
            .expect(400);

        expect(projectRepo.update).not.toHaveBeenCalled();
    });

    it('never leaks the raw token or the ciphertext in the response body', async () => {
        currentProject = { id: PROJECT_ID, npmRegistryUrl: undefined, npmRegistryScope: undefined };
        const rawToken = 'another-super-secret-token';

        const res = await request(makeApp())
            .put(`/api/projects/${PROJECT_ID}/npm-registry`)
            .send({ url: 'https://registry.npmjs.org/', token: rawToken })
            .expect(200);

        const [, payload] = projectRepo.update.mock.calls[0];
        const serialized = JSON.stringify(res.body);
        expect(serialized).not.toContain(rawToken);
        expect(serialized).not.toContain(payload.npmAuthTokenEncrypted);
    });
});
