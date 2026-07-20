import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { encryptSecret } from '../crypto.service';
import { ProcessService } from '../process.service';

let dir: string;
let logPath: string;

// withNpmrc is private; exercise it through the class the way buildAppImage does.
const withNpmrc = (project: any, encryptedToken: string | null, fn: (token: string | null) => Promise<void>) =>
    (ProcessService as any).withNpmrc(project, encryptedToken, logPath, fn);

const npmrcPath = () => path.join(dir, '.npmrc');
const backupPath = () => path.join(dir, '.npmrc.runnable-backup');

const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));

const TOKEN_CIPHERTEXT = () => encryptSecret('tok-secret');

function configuredProject() {
    return {
        id: 'proj-1',
        directoryPath: dir,
        npmRegistryUrl: 'https://npm.pkg.github.com/',
        npmRegistryScope: '@acme',
    };
}

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npmrc-test-'));
    logPath = path.join(dir, 'build.log');
    await fs.writeFile(logPath, '');
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('withNpmrc', () => {
    it('writes .npmrc with the decrypted token while the callback runs', async () => {
        let seen = '';
        let seenToken: string | null = null;
        await withNpmrc(configuredProject(), TOKEN_CIPHERTEXT(), async (token: string | null) => {
            seen = await fs.readFile(npmrcPath(), 'utf-8');
            seenToken = token;
        });
        expect(seen).toContain('@acme:registry=https://npm.pkg.github.com/');
        expect(seen).toContain('//npm.pkg.github.com/:_authToken=tok-secret');
        expect(seenToken).toBe('tok-secret');
    });

    it('deletes .npmrc after a successful run', async () => {
        await withNpmrc(configuredProject(), TOKEN_CIPHERTEXT(), async () => { });
        expect(await exists(npmrcPath())).toBe(false);
    });

    it('deletes .npmrc even when the callback throws', async () => {
        await expect(
            withNpmrc(configuredProject(), TOKEN_CIPHERTEXT(), async () => { throw new Error('build blew up'); })
        ).rejects.toThrow('build blew up');
        expect(await exists(npmrcPath())).toBe(false);
    });

    it('backs up and restores a repo-provided .npmrc', async () => {
        await fs.writeFile(npmrcPath(), 'legacy=true\n');
        await withNpmrc(configuredProject(), TOKEN_CIPHERTEXT(), async () => {
            const during = await fs.readFile(npmrcPath(), 'utf-8');
            expect(during).toContain('_authToken=tok-secret');
        });
        expect(await fs.readFile(npmrcPath(), 'utf-8')).toBe('legacy=true\n');
        expect(await exists(backupPath())).toBe(false);
    });

    it('restores a repo-provided .npmrc even when the callback throws', async () => {
        await fs.writeFile(npmrcPath(), 'legacy=true\n');
        await expect(
            withNpmrc(configuredProject(), TOKEN_CIPHERTEXT(), async () => { throw new Error('nope'); })
        ).rejects.toThrow('nope');
        expect(await fs.readFile(npmrcPath(), 'utf-8')).toBe('legacy=true\n');
    });

    it('writes nothing and passes a null token when no registry is configured', async () => {
        let seenToken: string | null = 'unset';
        await withNpmrc({ id: 'p', directoryPath: dir }, null, async (token: string | null) => {
            seenToken = token;
            expect(await exists(npmrcPath())).toBe(false);
        });
        expect(seenToken).toBeNull();
    });

    it('writes nothing when a url is set but no token is stored', async () => {
        await withNpmrc(
            { id: 'p', directoryPath: dir, npmRegistryUrl: 'https://registry.npmjs.org/' },
            null,
            async () => { expect(await exists(npmrcPath())).toBe(false); }
        );
    });

    it('fails the build with a clear log line when the token cannot be decrypted', async () => {
        await expect(
            withNpmrc(configuredProject(), 'v1.bogus.bogus.bogus', async () => { })
        ).rejects.toThrow(/could not be decrypted/i);
        const log = await fs.readFile(logPath, 'utf-8');
        expect(log).toMatch(/could not be decrypted/i);
        expect(log).toMatch(/re-enter it in project settings/i);
        expect(await exists(npmrcPath())).toBe(false);
    });
});
