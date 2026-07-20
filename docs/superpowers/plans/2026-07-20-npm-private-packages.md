# NPM Private Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project install dependencies from a private npm registry using a per-project registry URL, optional scope, and an encrypted auth token.

**Architecture:** Three nullable columns on `Project` hold the config, with the token encrypted at rest by a new AES-256-GCM helper keyed off `JWT_SECRET`. At build time `ProcessService.buildAppImage` writes a literal `.npmrc` into the project directory (the only mechanism both the build command and railpack's in-image install honor) and removes it in a `finally`. Three containment measures close the on-disk exposure: a Caddy dotfile rule, a file-browser dotfile guard, and token masking in build logs.

**Tech Stack:** Node `crypto` (built-in, no new dependency), Express 5, TypeORM 0.3 (Postgres), vitest, React 19 + zustand + axios.

**Spec:** `docs/superpowers/specs/2026-07-20-npm-private-packages-design.md`

## Global Constraints

- No new environment variables. The encryption key derives from `config.jwt.secret`.
- Encrypted payload format: `v1.<iv-b64url>.<authTag-b64url>.<ciphertext-b64url>`.
- The auth token is **never** returned by any API response, in any form.
- `.npmrc` is deleted in a `finally`, and any pre-existing `.npmrc` is restored.
- Projects with no registry configured must follow a byte-for-byte unchanged build path.
- Invariant enforced by the API: `npmRegistryUrl` is set if and only if a token is stored. `configured` is therefore derived as `!!npmRegistryUrl`.
- 4-space indentation, single quotes (match existing code style).
- Run commands from repo root with `--workspace=server` / `--workspace=client`.

---

### Task 1: Crypto service

**Files:**
- Create: `server/src/services/crypto.service.ts`
- Test: `server/src/services/__tests__/crypto.service.test.ts`

**Interfaces:**
- Consumes: `config.jwt.secret` from `server/src/config`; `AppError` from `server/src/middleware/errorHandler`.
- Produces: `encryptSecret(plaintext: string): string` and `decryptSecret(payload: string): string`, both exported from `server/src/services/crypto.service.ts`.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/__tests__/crypto.service.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../crypto.service';

describe('crypto.service', () => {
    it('round-trips a secret', () => {
        const plain = 'npm_AbCdEf1234567890';
        expect(decryptSecret(encryptSecret(plain))).toBe(plain);
    });

    it('round-trips unicode and empty-ish values', () => {
        expect(decryptSecret(encryptSecret('tökén-✓'))).toBe('tökén-✓');
        expect(decryptSecret(encryptSecret(' '))).toBe(' ');
    });

    it('produces different ciphertext each call (random IV)', () => {
        const a = encryptSecret('same-input');
        const b = encryptSecret('same-input');
        expect(a).not.toBe(b);
        expect(decryptSecret(a)).toBe('same-input');
        expect(decryptSecret(b)).toBe('same-input');
    });

    it('emits the v1 four-part format', () => {
        const parts = encryptSecret('x').split('.');
        expect(parts).toHaveLength(4);
        expect(parts[0]).toBe('v1');
    });

    it('rejects a tampered ciphertext', () => {
        const [v, iv, tag, ct] = encryptSecret('secret-value').split('.');
        const flipped = ct[0] === 'A' ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
        expect(() => decryptSecret(`${v}.${iv}.${tag}.${flipped}`)).toThrow();
    });

    it('rejects a tampered auth tag', () => {
        const [v, iv, tag, ct] = encryptSecret('secret-value').split('.');
        const flipped = tag[0] === 'A' ? `B${tag.slice(1)}` : `A${tag.slice(1)}`;
        expect(() => decryptSecret(`${v}.${iv}.${flipped}.${ct}`)).toThrow();
    });

    it('rejects an unknown version prefix', () => {
        const parts = encryptSecret('secret-value').split('.');
        parts[0] = 'v2';
        expect(() => decryptSecret(parts.join('.'))).toThrow();
    });

    it('rejects a malformed payload', () => {
        expect(() => decryptSecret('not-a-payload')).toThrow();
        expect(() => decryptSecret('')).toThrow();
        expect(() => decryptSecret('v1.a.b')).toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server -- crypto.service`
Expected: FAIL with `Cannot find module '../crypto.service'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/crypto.service.ts`:

```typescript
import crypto from 'crypto';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';

// Fixed application salt: the key must be reproducible across restarts and
// across the two self-hosted instances, so it cannot be random per-process.
// Security comes from JWT_SECRET's entropy, not from salt secrecy.
const KEY_SALT = 'runnable.secret.v1';
const VERSION = 'v1';
const IV_BYTES = 12; // GCM standard nonce length

let cachedKey: Buffer | null = null;

// scryptSync is deliberately slow; derive once per process, not per call.
function key(): Buffer {
    if (!cachedKey) {
        cachedKey = crypto.scryptSync(config.jwt.secret, KEY_SALT, 32);
    }
    return cachedKey;
}

/**
 * Encrypt a secret for storage at rest. Returns
 * `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 */
export function encryptSecret(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
    ].join('.');
}

/**
 * Decrypt a value produced by encryptSecret. Throws on any malformed,
 * tampered, or unknown-version payload — a wrong JWT_SECRET fails loudly
 * rather than yielding garbage.
 */
export function decryptSecret(payload: string): string {
    const parts = (payload || '').split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new AppError('Could not decrypt secret', 500);
    }
    try {
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const ciphertext = Buffer.from(parts[3], 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        throw new AppError('Could not decrypt secret', 500);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=server -- crypto.service`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run full suite and build**

Run: `npm test --workspace=server && npm run build --workspace=server`
Expected: PASS (125 existing + 8 new), build exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/crypto.service.ts server/src/services/__tests__/crypto.service.test.ts
git commit -m "feat: AES-256-GCM secret encryption helper"
```

---

### Task 2: Project columns, migration, and .npmrc content builder

**Files:**
- Modify: `server/src/entities/Project.ts`
- Create: `server/src/migrations/1772643000000-AddNpmRegistry.ts`
- Modify: `server/src/config/data-source.ts`
- Create: `server/src/services/npmrc.ts`
- Test: `server/src/services/__tests__/npmrc.test.ts`

**Interfaces:**
- Produces:
  - `Project.npmRegistryUrl?: string`, `Project.npmRegistryScope?: string`, `Project.npmAuthTokenEncrypted?: string` (the last with `select: false`).
  - `buildNpmrcContent(url: string, scope: string | null | undefined, token: string): string` exported from `server/src/services/npmrc.ts`.
  - `maskToken(text: string, token: string): string` exported from the same file.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/__tests__/npmrc.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildNpmrcContent, maskToken } from '../npmrc';

describe('buildNpmrcContent', () => {
    it('makes the registry the default when no scope is given', () => {
        const out = buildNpmrcContent('https://registry.npmjs.org/', null, 'tok123');
        expect(out).toContain('registry=https://registry.npmjs.org/');
        expect(out).not.toContain('@');
        expect(out).toContain('//registry.npmjs.org/:_authToken=tok123');
    });

    it('scopes the registry when a scope is given', () => {
        const out = buildNpmrcContent('https://npm.pkg.github.com/', '@acme', 'tok123');
        expect(out).toContain('@acme:registry=https://npm.pkg.github.com/');
        expect(out).toContain('//npm.pkg.github.com/:_authToken=tok123');
    });

    it('keeps the path for registries served under a subpath', () => {
        const out = buildNpmrcContent('https://gitlab.com/api/v4/packages/npm/', '@grp', 'tok');
        expect(out).toContain('//gitlab.com/api/v4/packages/npm/:_authToken=tok');
    });

    it('normalizes a missing trailing slash', () => {
        const out = buildNpmrcContent('https://npm.pkg.github.com', '@acme', 'tok');
        expect(out).toContain('//npm.pkg.github.com/:_authToken=tok');
    });

    it('ends with a newline', () => {
        expect(buildNpmrcContent('https://registry.npmjs.org/', null, 't')).toMatch(/\n$/);
    });
});

describe('maskToken', () => {
    it('replaces every occurrence of the token', () => {
        const text = 'auth failed for tok123 (tok123)';
        expect(maskToken(text, 'tok123')).toBe('auth failed for *** (***)');
    });

    it('returns the text unchanged when the token is absent', () => {
        expect(maskToken('all good', 'tok123')).toBe('all good');
    });

    it('is a no-op for an empty token', () => {
        expect(maskToken('literally anything', '')).toBe('literally anything');
    });

    it('treats the token literally, not as a regex', () => {
        expect(maskToken('value a.c here', 'a.c')).toBe('value *** here');
        expect(maskToken('value abc here', 'a.c')).toBe('value abc here');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server -- npmrc`
Expected: FAIL with `Cannot find module '../npmrc'`.

- [ ] **Step 3: Write the content builder**

Create `server/src/services/npmrc.ts`:

```typescript
/**
 * Compose .npmrc content for a private registry.
 *
 * npm keys auth by the registry's origin+path with no scheme and a trailing
 * slash — `//host/path/:_authToken=…`. With a scope, the registry is bound to
 * that scope only; without one it becomes the default registry.
 */
export function buildNpmrcContent(url: string, scope: string | null | undefined, token: string): string {
    const parsed = new URL(url);
    const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    const authKey = `//${parsed.host}${pathname}`;
    const registryLine = scope
        ? `${scope}:registry=${parsed.origin}${pathname}`
        : `registry=${parsed.origin}${pathname}`;
    return `${registryLine}\n${authKey}:_authToken=${token}\n`;
}

/** Replace every literal occurrence of the token with *** for log output. */
export function maskToken(text: string, token: string): string {
    if (!token) return text;
    return text.split(token).join('***');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=server -- npmrc`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add the entity columns**

In `server/src/entities/Project.ts`, add these three properties immediately after the existing `envVars` property:

```typescript
    /** Private npm registry base URL, e.g. https://npm.pkg.github.com/ */
    @Column({ nullable: true })
    npmRegistryUrl?: string;

    /** Optional npm scope the registry is bound to, e.g. "@acme". */
    @Column({ nullable: true })
    npmRegistryScope?: string;

    /**
     * Registry auth token, encrypted by crypto.service. `select: false` keeps
     * it out of every default query so it can never serialize into an API
     * response — it must be loaded explicitly with addSelect.
     */
    @Column({ type: 'text', nullable: true, select: false })
    npmAuthTokenEncrypted?: string;
```

- [ ] **Step 6: Create the migration**

Create `server/src/migrations/1772643000000-AddNpmRegistry.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNpmRegistry1772643000000 implements MigrationInterface {
    name = 'AddNpmRegistry1772643000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "projects"
            ADD COLUMN IF NOT EXISTS "npmRegistryUrl" character varying,
            ADD COLUMN IF NOT EXISTS "npmRegistryScope" character varying,
            ADD COLUMN IF NOT EXISTS "npmAuthTokenEncrypted" text
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "projects"
            DROP COLUMN IF EXISTS "npmRegistryUrl",
            DROP COLUMN IF EXISTS "npmRegistryScope",
            DROP COLUMN IF EXISTS "npmAuthTokenEncrypted"
        `);
    }
}
```

- [ ] **Step 7: Register the migration**

In `server/src/config/data-source.ts` add the import after the `AddWebAuthnCredentials1772642000000` import:

```typescript
import { AddNpmRegistry1772643000000 } from '../migrations/1772643000000-AddNpmRegistry';
```

and append `AddNpmRegistry1772643000000` to the end of the `migrations` array. (`Project` is already in the `entities` array — no change needed there.)

- [ ] **Step 8: Run full suite and build**

Run: `npm test --workspace=server && npm run build --workspace=server`
Expected: PASS, build exits 0.

- [ ] **Step 9: Commit**

```bash
git add server/src/entities/Project.ts server/src/migrations/1772643000000-AddNpmRegistry.ts server/src/config/data-source.ts server/src/services/npmrc.ts server/src/services/__tests__/npmrc.test.ts
git commit -m "feat: npm registry columns, migration, and .npmrc content builder"
```

---

### Task 3: `.npmrc` lifecycle in the build, and log scrubbing

**Files:**
- Modify: `server/src/services/sandbox.service.ts` (add optional `scrub` to `spawn`)
- Modify: `server/src/services/process.service.ts` (`buildAppImage`, `logAndCheck`)
- Test: `server/src/services/__tests__/npmrcLifecycle.test.ts`

**Interfaces:**
- Consumes: `buildNpmrcContent(url, scope, token)` and `maskToken(text, token)` from `server/src/services/npmrc.ts` (Task 2); `decryptSecret(payload)` from `server/src/services/crypto.service.ts` (Task 1); `Project.npmRegistryUrl` / `npmRegistryScope` / `npmAuthTokenEncrypted` (Task 2).
- Produces:
  - `SandboxService.spawn(projectId, command, args, logPath, cwd?, env?, scrub?)` — new optional 7th parameter `scrub?: (chunk: string) => string`.
  - `ProcessService.loadRegistryToken(projectId: string): Promise<string | null>` — private static; fetches the `select: false` ciphertext explicitly.
  - `ProcessService.withNpmrc<T>(project, encryptedToken, buildLogPath, fn)` — private static helper that sets up `.npmrc`, runs `fn(token)`, and always tears down. Called by `buildAppImage`.

**Note on the token load:** `npmAuthTokenEncrypted` is `select: false`, so it is absent from ordinary project queries. `buildAppImage` is the single consumer and both of its call sites (`process.service.ts:167` in `doStart` and `:836` in the blue-green deploy path) receive an already-loaded `project`. Rather than changing every upstream load, `buildAppImage` fetches the ciphertext itself in one place via `loadRegistryToken`.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/__tests__/npmrcLifecycle.test.ts`. This exercises the real filesystem in a temp directory, so it verifies actual file behavior rather than mocks:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server -- npmrcLifecycle`
Expected: FAIL — `withNpmrc is not a function`.

- [ ] **Step 3: Add the optional scrub parameter to spawn**

In `server/src/services/sandbox.service.ts`, change the `spawn` signature and the two data handlers. Replace:

```typescript
    static async spawn(projectId: string, command: string, args: string[], logPath: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<number> {
```

with:

```typescript
    /**
     * @param scrub Optional per-chunk transform applied before the chunk is
     * written to the log — used to mask credentials in build output.
     */
    static async spawn(projectId: string, command: string, args: string[], logPath: string, cwd?: string, env?: NodeJS.ProcessEnv, scrub?: (chunk: string) => string): Promise<number> {
```

and replace these two lines:

```typescript
            child.stdout?.on('data', (data) => logStream.write(data));
            child.stderr?.on('data', (data) => logStream.write(data));
```

with:

```typescript
            const write = (data: any) => logStream.write(scrub ? scrub(String(data)) : data);
            child.stdout?.on('data', write);
            child.stderr?.on('data', write);
```

- [ ] **Step 4: Add the withNpmrc helper**

In `server/src/services/process.service.ts`, add these imports at the top (alongside the existing imports):

```typescript
import { buildNpmrcContent, maskToken } from './npmrc';
import { decryptSecret } from './crypto.service';
```

Add this private static method to the `ProcessService` class, directly above `buildAppImage`:

```typescript
    /**
     * Run `fn` with a private-registry `.npmrc` present in the project
     * directory, then always remove it.
     *
     * The file must be real (not an env-var reference): `railpack build` runs
     * its own npm install inside the image and receives only buildkitEnv, so
     * `${NPM_TOKEN}` interpolation would be undefined exactly where
     * dependencies are installed. Both install steps read the project
     * directory, so a literal file is the one thing that works for both.
     *
     * `fn` receives the plaintext token (or null) so callers can mask it in
     * log output.
     */
    private static async withNpmrc<T>(
        project: Project,
        encryptedToken: string | null,
        buildLogPath: string,
        fn: (token: string | null) => Promise<T>,
    ): Promise<T> {
        if (!project.npmRegistryUrl || !encryptedToken) {
            return fn(null);
        }

        let token: string;
        try {
            token = decryptSecret(encryptedToken);
        } catch {
            // Almost always a rotated JWT_SECRET. Say so plainly instead of
            // letting the build fail later with an opaque registry 401.
            const message = 'Stored npm registry token could not be decrypted — re-enter it in project settings';
            await fs.appendFile(buildLogPath, `\n${message}\n`);
            throw new Error(message);
        }

        const npmrcPath = path.join(project.directoryPath, '.npmrc');
        const backupPath = `${npmrcPath}.runnable-backup`;

        // Preserve a repo-provided .npmrc rather than clobbering it.
        const hadExisting = await fs.rename(npmrcPath, backupPath).then(() => true, () => false);
        await fs.writeFile(npmrcPath, buildNpmrcContent(project.npmRegistryUrl, project.npmRegistryScope, token), { mode: 0o600 });

        try {
            return await fn(token);
        } finally {
            await fs.rm(npmrcPath, { force: true }).catch(() => { });
            if (hadExisting) {
                await fs.rename(backupPath, npmrcPath).catch(() => { });
            }
        }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace=server -- npmrcLifecycle`
Expected: PASS, 7 tests.

- [ ] **Step 5b: Add the loadRegistryToken helper**

`npmAuthTokenEncrypted` is `select: false`, so it is absent from the `project` objects both `buildAppImage` call sites pass in. Add this private static method to `ProcessService`, directly above `withNpmrc`:

```typescript
    /**
     * Fetch the encrypted registry token. It is a `select: false` column, so
     * it never arrives on a normally-loaded project — this is the one place
     * that asks for it, keeping the secret off every other code path.
     */
    private static async loadRegistryToken(projectId: string): Promise<string | null> {
        const row = await projectRepo.createQueryBuilder('p')
            .select('p.npmAuthTokenEncrypted', 'token')
            .where('p.id = :id', { id: projectId })
            .getRawOne();
        return row?.token || null;
    }
```

Check how the repository is referenced at the top of `process.service.ts` — if it is a function (`projectRepo()`) rather than a constant, call it accordingly.

- [ ] **Step 6: Wire withNpmrc and scrubbing into buildAppImage**

In `server/src/services/process.service.ts`, replace the body of `buildAppImage` **after** the `buildkitEnv` declaration (i.e. the build-command block and the railpack block) with this wrapped version. Everything before it — the BuildKit ensure block and `buildkitEnv` — is unchanged:

```typescript
        const encryptedToken = await ProcessService.loadRegistryToken(project.id);
        await ProcessService.withNpmrc(project, encryptedToken, buildLogPath, async (npmToken) => {
            const scrub = npmToken ? (text: string) => maskToken(text, npmToken) : undefined;

            // Run build command (user-provided or auto-detected)
            if (effectiveBuildCommand) {
                await fs.appendFile(buildLogPath, `\n--- Build Command: ${effectiveBuildCommand} ---\n`);
                const buildEnv = { ...buildkitEnv, ...userEnv };
                const buildResult = await SandboxService.exec(project.id, 'sh', ['-c', effectiveBuildCommand], project.directoryPath, buildEnv);
                await ProcessService.logAndCheck(buildLogPath, buildResult, 'Build', scrub);
            }

            // Build image using railpack (Streaming)
            await fs.appendFile(buildLogPath, "\n--- Railpack Build (Streaming) ---\n");
            const buildExitCode = await SandboxService.spawn(project.id, 'railpack', ['build', '.', '--name', imageName], buildLogPath, project.directoryPath, buildkitEnv, scrub);

            if (buildExitCode !== 0) {
                throw new Error(`Railpack build failed with exit code ${buildExitCode}. See logs for details.`);
            }
        });
```

- [ ] **Step 7: Add the scrub parameter to logAndCheck**

In the same file, change `logAndCheck` to accept and apply an optional scrub. Replace:

```typescript
    private static async logAndCheck(
        buildLogPath: string,
        result: { stdout: string; stderr: string; exitCode: number },
        step: string,
    ): Promise<void> {
        const logContent = `\n--- ${step} ---\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nEXIT CODE: ${result.exitCode}\n\n`;
        await fs.appendFile(buildLogPath, logContent);
```

with:

```typescript
    private static async logAndCheck(
        buildLogPath: string,
        result: { stdout: string; stderr: string; exitCode: number },
        step: string,
        scrub?: (text: string) => string,
    ): Promise<void> {
        const raw = `\n--- ${step} ---\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nEXIT CODE: ${result.exitCode}\n\n`;
        const logContent = scrub ? scrub(raw) : raw;
        await fs.appendFile(buildLogPath, logContent);
```

Every existing caller omits the new parameter and is unaffected.

- [ ] **Step 8: Run full suite and build**

Run: `npm test --workspace=server && npm run build --workspace=server`
Expected: PASS, build exits 0. If `process.service.ts` does not already import `path` or `fs/promises`, add those imports — check the top of the file first.

- [ ] **Step 9: Commit**

```bash
git add server/src/services/sandbox.service.ts server/src/services/process.service.ts server/src/services/__tests__/npmrcLifecycle.test.ts
git commit -m "feat: write private-registry .npmrc during build and mask token in logs"
```

---

### Task 4: Containment — Caddy dotfile rule and file-browser guard

**Files:**
- Modify: `server/src/services/serverConfig.service.ts` (static block)
- Modify: `server/src/services/fileManager.service.ts` (`validatePath`)
- Test: `server/src/services/__tests__/dotfileContainment.test.ts`

**Interfaces:**
- Consumes: `ServerConfigService.generateConfig(options)` and `FileManagerService` static methods, both already existing.
- Produces: no new exports — behavior changes only.

- [ ] **Step 1: Write the failing test**

Create `server/src/services/__tests__/dotfileContainment.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ServerConfigService } from '../serverConfig.service';
import { FileManagerService } from '../fileManager.service';
import { ServerType } from '../../entities';

describe('static site dotfile protection', () => {
    it('blocks dotfile requests for static sites', async () => {
        const out = await ServerConfigService.generateConfig({
            subdomain: 'site',
            directoryPath: '/srv/site',
            port: 0,
            serverType: ServerType.STATIC,
        });
        expect(out).toContain('@dot path /.*');
        expect(out).toContain('respond @dot 403');
    });
});

describe('file browser dotfile guard', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotfile-test-'));
        await fs.writeFile(path.join(dir, '.npmrc'), 'secret=1\n');
        await fs.writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>');
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('refuses to read a dotfile', async () => {
        await expect(FileManagerService.readFile(dir, '.npmrc'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses to read a dotfile in a subdirectory', async () => {
        await fs.mkdir(path.join(dir, 'sub'));
        await fs.writeFile(path.join(dir, 'sub', '.env'), 'X=1');
        await expect(FileManagerService.readFile(dir, 'sub/.env'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses to write a dotfile', async () => {
        await expect(FileManagerService.writeFile(dir, '.npmrc', 'hacked'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('refuses to delete a dotfile', async () => {
        await expect(FileManagerService.deleteFile(dir, '.npmrc'))
            .rejects.toMatchObject({ statusCode: 403 });
    });

    it('still allows normal files', async () => {
        const { content } = await FileManagerService.readFile(dir, 'index.html');
        expect(content).toBe('<h1>hi</h1>');
        await FileManagerService.writeFile(dir, 'page.html', 'ok');
        expect(await fs.readFile(path.join(dir, 'page.html'), 'utf-8')).toBe('ok');
    });

    it('still allows listing the directory root', async () => {
        const files = await FileManagerService.listFiles(dir, '');
        expect(files.map(f => f.name)).toContain('index.html');
        expect(files.map(f => f.name)).not.toContain('.npmrc');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server -- dotfileContainment`
Expected: FAIL — the Caddy assertions and the 403 expectations both fail.

- [ ] **Step 3: Add the Caddy dotfile rule**

In `server/src/services/serverConfig.service.ts`, in the `ServerType.STATIC` branch, replace:

```typescript
            configStr += `${domainList} {
${tlsBlock}  root * ${options.directoryPath}
  file_server
```

with:

```typescript
            configStr += `${domainList} {
${tlsBlock}  root * ${options.directoryPath}
  @dot path /.*
  respond @dot 403
  file_server
```

This also protects `.runnable.env` and `.git`, which are served today.

- [ ] **Step 4: Add the file-browser dotfile guard**

In `server/src/services/fileManager.service.ts`, extend `validatePath` so every caller inherits the guard. Replace the existing method with:

```typescript
    private static validatePath(baseDir: string, filePath: string): string {
        const base = path.resolve(baseDir);
        const resolved = path.resolve(base, filePath);
        // Require the resolved path to be the base dir itself or strictly inside it.
        // A bare prefix check would let "../foo-bar" escape from base ".../foo".
        if (resolved !== base && !resolved.startsWith(base + path.sep)) {
            throw new AppError('Invalid file path: path traversal detected', 400);
        }
        // Dotfiles hold credentials the browser must never expose or overwrite
        // (.npmrc written during builds, .runnable.env, .git internals).
        // listFiles already hides them; this closes direct-path access.
        const relative = path.relative(base, resolved);
        if (relative && relative.split(path.sep).some(segment => segment.startsWith('.'))) {
            throw new AppError('Access to dotfiles is not permitted', 403);
        }
        return resolved;
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test --workspace=server -- dotfileContainment`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run full suite and build**

Run: `npm test --workspace=server && npm run build --workspace=server`
Expected: PASS, build exits 0. If any pre-existing test relied on reading a dotfile through `FileManagerService`, that is a real behavior change — report it rather than loosening the guard.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/serverConfig.service.ts server/src/services/fileManager.service.ts server/src/services/__tests__/dotfileContainment.test.ts
git commit -m "feat: block dotfile access via static serving and file browser"
```

---

### Task 5: Registry config API

**Files:**
- Modify: `server/src/routes/projects.routes.ts`
- Test: `server/src/__tests__/npmRegistry.routes.test.ts`

**Interfaces:**
- Consumes: `encryptSecret` from `server/src/services/crypto.service.ts` (Task 1); `Project.npmRegistryUrl` / `npmRegistryScope` / `npmAuthTokenEncrypted` (Task 2); the existing `requireProjectAccess(ProjectPermission.CAN_EDIT_CONFIG)` middleware and `AppDataSource`.
- Produces:
  - `PUT /api/projects/:id/npm-registry` — body `{ url, scope?, token? }` → `{ npmRegistry: { url, scope, configured } }`
  - `DELETE /api/projects/:id/npm-registry` → `{ message: 'Registry configuration removed' }`
  - `GET /api/projects/:id` response gains `npmRegistry: { url, scope, configured }`.

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/npmRegistry.routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=server -- npmRegistry.routes`
Expected: FAIL — `validateRegistryInput is not exported`.

- [ ] **Step 3: Add the helpers and routes**

In `server/src/routes/projects.routes.ts`, add the import near the other service imports:

```typescript
import { encryptSecret } from '../services/crypto.service';
```

Add these two exported helpers near the top of the file, after the imports:

```typescript
// npm scope grammar: "@" followed by npm's package-name character set.
const SCOPE_RE = /^@[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Validate and normalize registry input. Throws AppError(400) on bad input.
 */
export function validateRegistryInput(rawUrl: unknown, rawScope: unknown): { url: string; scope: string | null } {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new AppError('A valid http(s) registry URL is required', 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new AppError('A valid http(s) registry URL is required', 400);
    }

    const scopeInput = typeof rawScope === 'string' ? rawScope.trim() : '';
    if (!scopeInput) {
        return { url, scope: null };
    }
    if (!SCOPE_RE.test(scopeInput)) {
        throw new AppError('Scope must look like "@my-org"', 400);
    }
    return { url, scope: scopeInput };
}

/**
 * Public shape of a project's registry config. The token is never included —
 * `configured` is derived from the URL, which the API keeps in lockstep with
 * the stored token.
 */
export function serializeNpmRegistry(project: Project): { url: string | null; scope: string | null; configured: boolean } {
    return {
        url: project.npmRegistryUrl || null,
        scope: project.npmRegistryScope || null,
        configured: !!project.npmRegistryUrl,
    };
}
```

Change the existing `GET /:id` handler to include the registry block:

```typescript
router.get('/:id', requireProjectAccess(), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        res.json({ ...project, npmRegistry: serializeNpmRegistry(project) });
    } catch (error) {
        next(error);
    }
});
```

Add the two new routes (place them after the existing `PUT /:id` handler):

```typescript
// Set the private npm registry config (requires canEditConfig)
router.put('/:id/npm-registry', requireProjectAccess(ProjectPermission.CAN_EDIT_CONFIG), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        const { url, scope } = validateRegistryInput(req.body?.url, req.body?.scope);

        const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
        const repo = AppDataSource.getRepository(Project);

        // An omitted token keeps the stored one, so the URL or scope can be
        // changed without re-entering the secret. A token is required when
        // nothing is stored yet — this maintains the invariant that a URL is
        // present only when a token is too.
        const update: Partial<Project> = { npmRegistryUrl: url, npmRegistryScope: scope ?? undefined };
        if (token) {
            update.npmAuthTokenEncrypted = encryptSecret(token);
        } else if (!project.npmRegistryUrl) {
            throw new AppError('An auth token is required', 400);
        }

        await repo.update(project.id, update);
        res.json({ npmRegistry: { url, scope, configured: true } });
    } catch (error) {
        next(error);
    }
});

// Remove the private npm registry config (requires canEditConfig)
router.delete('/:id/npm-registry', requireProjectAccess(ProjectPermission.CAN_EDIT_CONFIG), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const project = (req as any).project as Project;
        await AppDataSource.getRepository(Project).update(project.id, {
            npmRegistryUrl: undefined,
            npmRegistryScope: undefined,
            npmAuthTokenEncrypted: undefined,
        });
        res.json({ message: 'Registry configuration removed' });
    } catch (error) {
        next(error);
    }
});
```

Check the top of the file for the existing `AppError`, `AppDataSource`, `Project`, and `ProjectPermission` imports and add any that are missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=server -- npmRegistry.routes`
Expected: PASS, 10 tests.

- [ ] **Step 5: Confirm the token never reaches the client**

Run: `grep -n "npmAuthTokenEncrypted" server/src/routes/projects.routes.ts`
Expected: no matches. The route file must never read, assign, or serialize the ciphertext — `PUT` writes it through `repo.update` only, and `serializeNpmRegistry` derives `configured` from the URL. (The build path loads it separately via `ProcessService.loadRegistryToken`, added in Task 3.)

- [ ] **Step 6: Run full suite and build**

Run: `npm test --workspace=server && npm run build --workspace=server`
Expected: PASS, build exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/projects.routes.ts server/src/__tests__/npmRegistry.routes.test.ts
git commit -m "feat: npm registry configuration API"
```

---

### Task 6: Client API and project settings UI

**Files:**
- Modify: `client/src/api/projects.ts`
- Modify: `client/src/pages/ProjectDetail.tsx` — the only view rendering project configuration (it owns the `envVars` editor; place the new card alongside it)

**Interfaces:**
- Consumes: the endpoints from Task 5.
- Produces: `projectsApi.setNpmRegistry(id, data)` and `projectsApi.removeNpmRegistry(id)`.

- [ ] **Step 1: Add the API methods**

In `client/src/api/projects.ts`, add to the exported `projectsApi` object (match the file's existing style — check whether it uses `api.put('/projects/...')` or a different prefix and follow it):

```typescript
    setNpmRegistry: (id: string, data: { url: string; scope: string; token: string }) =>
        api.put<{ npmRegistry: NpmRegistry }>(`/projects/${id}/npm-registry`, data),
    removeNpmRegistry: (id: string) => api.delete(`/projects/${id}/npm-registry`),
```

and add the shared type near the file's other interfaces:

```typescript
export interface NpmRegistry {
    url: string | null;
    scope: string | null;
    configured: boolean;
}
```

- [ ] **Step 2: Add the settings card**

In `client/src/pages/ProjectDetail.tsx`, add this section alongside the existing configuration cards. Match the surrounding file's class names and form patterns — the code below uses the conventions from `client/src/pages/Settings.tsx` (`info-card glass`, `form-group`, `form-input`, `alert alert-error`, `alert alert-success`, `btn btn-primary`, `btn btn-secondary`, `spinner`); if `ProjectDetail.tsx` differs, follow what that file already does:

```tsx
<div style={{ marginTop: 32 }}>
    <h3 style={{ marginBottom: 16 }}>NPM Registry</h3>
    <div className="info-card glass" style={{ maxWidth: 520 }}>
        {npmError && <div className="alert alert-error">{npmError}</div>}
        {npmSuccess && <div className="alert alert-success">{npmSuccess}</div>}
        <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
            Install dependencies from a private registry. The token is encrypted and never shown again.
        </p>
        <form onSubmit={handleSaveRegistry}>
            <div className="form-group">
                <label>Registry URL</label>
                <input
                    type="url"
                    className="form-input"
                    placeholder="https://npm.pkg.github.com/"
                    value={npmUrl}
                    onChange={(e) => setNpmUrl(e.target.value)}
                    required
                />
            </div>
            <div className="form-group">
                <label>Scope (optional)</label>
                <input
                    type="text"
                    className="form-input"
                    placeholder="@my-org"
                    value={npmScope}
                    onChange={(e) => setNpmScope(e.target.value)}
                />
            </div>
            <div className="form-group">
                <label>Auth Token</label>
                <input
                    type="password"
                    className="form-input"
                    placeholder="••••••••"
                    value={npmToken}
                    onChange={(e) => setNpmToken(e.target.value)}
                    required={!npmConfigured}
                />
                {npmConfigured && (
                    <small style={{ opacity: 0.7 }}>A token is saved. Leave blank to keep it.</small>
                )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn-primary" disabled={npmLoading}>
                    {npmLoading ? <span className="spinner" /> : 'Save Registry'}
                </button>
                {npmConfigured && (
                    <button type="button" className="btn btn-secondary" onClick={handleRemoveRegistry} disabled={npmLoading}>
                        Remove
                    </button>
                )}
            </div>
        </form>
    </div>
</div>
```

with this state and these handlers in the component (initialize from the project's `npmRegistry` block once it loads):

```typescript
const [npmUrl, setNpmUrl] = useState('');
const [npmScope, setNpmScope] = useState('');
const [npmToken, setNpmToken] = useState('');
const [npmConfigured, setNpmConfigured] = useState(false);
const [npmError, setNpmError] = useState('');
const [npmSuccess, setNpmSuccess] = useState('');
const [npmLoading, setNpmLoading] = useState(false);

useEffect(() => {
    const reg = (project as any)?.npmRegistry;
    if (reg) {
        setNpmUrl(reg.url || '');
        setNpmScope(reg.scope || '');
        setNpmConfigured(reg.configured);
    }
}, [project]);

const handleSaveRegistry = async (e: FormEvent) => {
    e.preventDefault();
    setNpmError('');
    setNpmSuccess('');
    setNpmLoading(true);
    try {
        const { data } = await projectsApi.setNpmRegistry(project.id, {
            url: npmUrl,
            scope: npmScope,
            token: npmToken,
        });
        setNpmConfigured(data.npmRegistry.configured);
        setNpmToken('');
        setNpmSuccess('Registry saved. It applies on the next deploy.');
    } catch (err: any) {
        setNpmError(err.response?.data?.error || 'Failed to save registry');
    } finally {
        setNpmLoading(false);
    }
};

const handleRemoveRegistry = async () => {
    if (!confirm('Remove the private registry configuration?')) return;
    setNpmError('');
    setNpmSuccess('');
    setNpmLoading(true);
    try {
        await projectsApi.removeNpmRegistry(project.id);
        setNpmUrl('');
        setNpmScope('');
        setNpmToken('');
        setNpmConfigured(false);
        setNpmSuccess('Registry configuration removed.');
    } catch (err: any) {
        setNpmError(err.response?.data?.error || 'Failed to remove registry');
    } finally {
        setNpmLoading(false);
    }
};
```

- [ ] **Step 3: Verify the client builds**

Run: `npm run build --workspace=client`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add client/src/api/projects.ts client/src/pages/ProjectDetail.tsx
git commit -m "feat: npm registry configuration UI"
```

- [ ] **Step 5: Document the JWT_SECRET consequence**

`README.md` has no environment-variable reference section today (its headings are the OAuth setup guides and "Server Deployment (Ubuntu)"). Add a new top-level section at the end of the file, after the existing "Management Commands" subsection:

```markdown
## Private NPM Registries

A project can install from a private npm registry: set the registry URL, an
optional scope, and an auth token in the project's settings. The token is
encrypted at rest and written to a temporary `.npmrc` only for the duration of
each build.

### Rotating JWT_SECRET

`JWT_SECRET` also derives the key that encrypts stored private-registry npm
tokens. Rotating it invalidates every session (expected) **and** makes stored
registry tokens undecryptable — affected projects fail their next build with
"Stored npm registry token could not be decrypted" until the token is re-entered
in project settings.
```

- [ ] **Step 6: Commit the documentation**

```bash
git add README.md
git commit -m "docs: note JWT_SECRET rotation affects stored registry tokens"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only; fix anything found and commit fixes).

- [ ] **Step 1: Full automated check**

Run from repo root:

```bash
npm test --workspace=server && npm run build --workspace=server && npm run build --workspace=client
```

Expected: all pass.

- [ ] **Step 2: Verify the generated .npmrc against a real registry**

With the dev stack running:

1. Configure a project with `https://registry.npmjs.org/`, no scope, and a valid npm read token (a token for a private package you control).
2. Deploy the project. Confirm the build log shows the install succeeding and that the token appears nowhere in `<storage>/logs/<subdomain>-build.log` — grep it: `grep -c '<token>' <logfile>` must print `0`.
3. Confirm `.npmrc` is absent from the project directory after the deploy: `ls -la <directoryPath>/.npmrc` must report no such file.
4. Deliberately break it: set an invalid token, redeploy, confirm the build fails with npm's 401 in the log and the token is still masked.

- [ ] **Step 3: Verify containment**

1. For a static project, request `https://<subdomain>.<domain>/.npmrc` and confirm a 403.
2. In the file browser, confirm `.npmrc` is not listed and that a direct read request returns 403.

- [ ] **Step 4: Verify the no-registry path is unchanged**

Deploy a project with no registry configured. Confirm the build log is identical in shape to before this feature (no `.npmrc` step) and that no `.npmrc` is created at any point.

- [ ] **Step 5: Final commit (if fixes were made)**

```bash
git add -A && git commit -m "fix: npm private packages E2E polish"
```
