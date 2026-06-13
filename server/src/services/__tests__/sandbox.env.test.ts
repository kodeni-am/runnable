import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxService } from '../sandbox.service';

// These tests run with sandbox disabled (SANDBOX_ENABLED is not 'true' under
// vitest), so commands spawn directly — exactly the path docker/compose take in
// production. They verify that Runnable's own environment (its listen PORT and
// secrets) is NOT inherited by spawned subprocesses, which is what hijacked the
// `${PORT}` interpolation in user compose files onto the API's own port 3001.

const PROJECT_ID = 'c5891f32-1111-2222-3333-444455556666';
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ['PORT', 'JWT_SECRET', 'DATABASE_PASSWORD', 'SOME_USER_VAR']) saved[k] = process.env[k];
    process.env.PORT = '3001';
    process.env.JWT_SECRET = 'topsecret-jwt-value';
    process.env.DATABASE_PASSWORD = 'topsecret-db-value';
    process.env.SOME_USER_VAR = 'passthrough-ok';
});

afterEach(() => {
    for (const k of ['PORT', 'JWT_SECRET', 'DATABASE_PASSWORD', 'SOME_USER_VAR']) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
});

describe('SandboxService child environment isolation', () => {
    it('does not leak the server PORT or secrets into a spawned command', async () => {
        const { stdout } = await SandboxService.exec(PROJECT_ID, 'sh', ['-c', 'env']);
        expect(stdout).not.toContain('PORT=3001');
        expect(stdout).not.toContain('topsecret-jwt-value');
        expect(stdout).not.toContain('topsecret-db-value');
    });

    it('still preserves PATH (docker/compose need it)', async () => {
        const { stdout } = await SandboxService.exec(PROJECT_ID, 'sh', ['-c', 'env']);
        expect(stdout).toMatch(/^PATH=/m);
    });

    it('passes through non-Runnable env vars', async () => {
        const { stdout } = await SandboxService.exec(PROJECT_ID, 'sh', ['-c', 'env']);
        expect(stdout).toContain('passthrough-ok');
    });

    it('lets an explicit env argument re-add/override a stripped var', async () => {
        const { stdout } = await SandboxService.exec(
            PROJECT_ID, 'sh', ['-c', 'printf %s "$PORT"'], undefined, { PORT: '9999' },
        );
        expect(stdout.trim()).toBe('9999');
    });
});
