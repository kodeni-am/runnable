# Passkey (WebAuthn) Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Existing users can add named passkeys from Settings and sign in with a one-tap "Sign in with a passkey" button on the Login page.

**Architecture:** A new `WebAuthnCredential` entity stores credentials per user. A `PasskeyService` (mirroring `AuthService`) wraps `@simplewebauthn/server`; new routes under `/api/auth/passkeys` handle registration/management (authenticated) and discoverable-credential login (public, rate-limited). Challenges live in a short-lived httpOnly cookie, like the existing `oauthNonce`. Login issues the same JWT cookies as password login.

**Tech Stack:** Express 5, TypeORM 0.3 (Postgres), vitest, React 19 + zustand + axios, `@simplewebauthn/server` v13, `@simplewebauthn/browser` v13.

**Spec:** `docs/superpowers/specs/2026-07-19-passkey-auth-design.md`

## Global Constraints

- rpID = hostname of `CLIENT_URL`; expectedOrigin = `CLIENT_URL` (default `http://localhost:5175`). No new env vars.
- Challenge cookie: name `webauthnChallenge`, httpOnly, `secure` in production, `sameSite: 'lax'`, maxAge 5 min, path `/`, cleared on every verify attempt (single-use).
- Login failures always return generic 401 `Invalid credentials` — never distinguish unknown credential from bad signature.
- Passkey list responses never include public keys or credential IDs: only `{ id, name, deviceType, backedUp, createdAt, lastUsedAt }`.
- Passkey names: trimmed, max 64 chars, default `Passkey` when blank.
- 4-space indentation, single quotes (match existing code style).
- Run server commands from repo root with `--workspace=server` / `--workspace=client`, or `cd server` / `cd client`.

---

### Task 1: WebAuthnCredential entity + migration

**Files:**
- Create: `server/src/entities/WebAuthnCredential.ts`
- Create: `server/src/migrations/1772642000000-AddWebAuthnCredentials.ts`
- Modify: `server/src/entities/index.ts`
- Modify: `server/src/entities/User.ts` (add `passkeys` relation)
- Modify: `server/src/config/data-source.ts` (register entity + migration)

**Interfaces:**
- Produces: `WebAuthnCredential` entity class with fields `id: string`, `userId: string`, `user: User`, `credentialId: string` (unique, base64url), `publicKey: string` (base64url), `counter: string` (bigint → string in TypeORM), `transports?: string[]`, `deviceType: string`, `backedUp: boolean`, `name: string`, `createdAt: Date`, `lastUsedAt?: Date | null`. Exported from `server/src/entities/index.ts`.

- [ ] **Step 1: Create the entity**

Create `server/src/entities/WebAuthnCredential.ts`:

```typescript
import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { User } from './User';

@Entity('webauthn_credentials')
export class WebAuthnCredential {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => User, (user) => user.passkeys, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column({ type: 'uuid' })
    userId: string;

    /** Base64url credential ID as produced by the authenticator. */
    @Index({ unique: true })
    @Column({ type: 'text' })
    credentialId: string;

    /** Base64url-encoded COSE public key. */
    @Column({ type: 'text' })
    publicKey: string;

    /**
     * WebAuthn signature counter. Postgres bigint comes back through
     * TypeORM as a string; parsed at the point of use.
     */
    @Column({ type: 'bigint', default: 0 })
    counter: string;

    @Column({ type: 'simple-json', nullable: true })
    transports?: string[];

    @Column({ default: 'singleDevice' })
    deviceType: string;

    @Column({ default: false })
    backedUp: boolean;

    /** User-supplied label, e.g. "MacBook Touch ID". */
    @Column({ length: 64 })
    name: string;

    @CreateDateColumn()
    createdAt: Date;

    @Column({ type: 'timestamp', nullable: true })
    lastUsedAt?: Date | null;
}
```

- [ ] **Step 2: Add the back-relation on User**

In `server/src/entities/User.ts`, extend the existing import from `'typeorm'` (it already imports `OneToMany`) and add after the `collaborations` property:

```typescript
    @OneToMany(() => WebAuthnCredential, (cred) => cred.user)
    passkeys: WebAuthnCredential[];
```

Add the import at the top (after the `ProjectCollaborator` import):

```typescript
import { WebAuthnCredential } from './WebAuthnCredential';
```

- [ ] **Step 3: Export from the entities barrel**

In `server/src/entities/index.ts` add:

```typescript
export { WebAuthnCredential } from './WebAuthnCredential';
```

- [ ] **Step 4: Create the migration**

Create `server/src/migrations/1772642000000-AddWebAuthnCredentials.ts` (timestamp continues the existing sequence; initial schema already installs `uuid-ossp`):

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWebAuthnCredentials1772642000000 implements MigrationInterface {
    name = 'AddWebAuthnCredentials1772642000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "userId" uuid NOT NULL,
                "credentialId" text NOT NULL,
                "publicKey" text NOT NULL,
                "counter" bigint NOT NULL DEFAULT 0,
                "transports" text,
                "deviceType" character varying NOT NULL DEFAULT 'singleDevice',
                "backedUp" boolean NOT NULL DEFAULT false,
                "name" character varying(64) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "lastUsedAt" TIMESTAMP,
                CONSTRAINT "PK_webauthn_credentials_id" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_webauthn_credentials_credentialId" UNIQUE ("credentialId"),
                CONSTRAINT "FK_webauthn_credentials_userId" FOREIGN KEY ("userId")
                    REFERENCES "users"("id") ON DELETE CASCADE
            )
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "IDX_webauthn_credentials_userId"
            ON "webauthn_credentials" ("userId")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "webauthn_credentials"`);
    }
}
```

- [ ] **Step 5: Register entity and migration in the data source**

In `server/src/config/data-source.ts`:

Add imports (after the `Deployment` entity import and after the last migration import respectively):

```typescript
import { WebAuthnCredential } from '../entities/WebAuthnCredential';
import { AddWebAuthnCredentials1772642000000 } from '../migrations/1772642000000-AddWebAuthnCredentials';
```

Append `WebAuthnCredential` to the `entities` array and `AddWebAuthnCredentials1772642000000` to the end of the `migrations` array.

- [ ] **Step 6: Verify it compiles**

Run: `npm run build --workspace=server`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/entities/WebAuthnCredential.ts server/src/entities/User.ts server/src/entities/index.ts server/src/migrations/1772642000000-AddWebAuthnCredentials.ts server/src/config/data-source.ts
git commit -m "feat: WebAuthnCredential entity and migration"
```

---

### Task 2: PasskeyService

**Files:**
- Modify: `server/package.json` (add `@simplewebauthn/server`)
- Modify: `server/src/config/index.ts` (add `clientUrl`)
- Create: `server/src/services/passkey.service.ts`
- Test: `server/src/services/__tests__/passkey.service.test.ts`

**Interfaces:**
- Consumes: `WebAuthnCredential` entity from Task 1; existing `AuthService.generateTokens(user)`, `AppError`, `AppDataSource`.
- Produces (used by Task 3 routes):
  - `PasskeyService.getRegistrationOptions(user: User): Promise<PublicKeyCredentialCreationOptionsJSON>` — options include `challenge` (string).
  - `PasskeyService.verifyRegistration(user: User, response: unknown, name: string, expectedChallenge: string): Promise<PasskeySummary>`
  - `PasskeyService.listPasskeys(userId: string): Promise<PasskeySummary[]>`
  - `PasskeyService.deletePasskey(userId: string, id: string): Promise<void>`
  - `PasskeyService.getLoginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>`
  - `PasskeyService.verifyLogin(response: unknown, expectedChallenge: string): Promise<{ user: User; accessToken: string; refreshToken: string }>`
  - `PasskeySummary` = `{ id: string; name: string; deviceType: string; backedUp: boolean; createdAt: Date; lastUsedAt: Date | null }`
  - `config.clientUrl: string`

- [ ] **Step 1: Install the server library**

Run: `npm install @simplewebauthn/server@^13 --workspace=server`
Expected: `@simplewebauthn/server` appears in `server/package.json` dependencies.

- [ ] **Step 2: Add clientUrl to config**

In `server/src/config/index.ts`, inside the `config` object after `nodeEnv`:

```typescript
    // Public URL of the SPA — also the WebAuthn expected origin; its
    // hostname is the WebAuthn rpID.
    clientUrl: process.env.CLIENT_URL || 'http://localhost:5175',
```

(`CLIENT_URL` is already in `STATIC_RUNNABLE_ENV_KEYS` — no change needed there.)

- [ ] **Step 3: Write the failing tests**

Create `server/src/services/__tests__/passkey.service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/server', () => ({
    generateRegistrationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
}));
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: vi.fn() },
}));
vi.mock('../auth.service', () => ({
    AuthService: {
        generateTokens: vi.fn(() => ({ accessToken: 'access', refreshToken: 'refresh' })),
    },
}));

import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { PasskeyService } from '../passkey.service';
import { AppDataSource } from '../../config/data-source';
import { AuthService } from '../auth.service';
import { WebAuthnCredential } from '../../entities/WebAuthnCredential';

const user = { id: 'user-1', username: 'ara', role: 'user', tokenVersion: 0 } as any;

let credRepo: any;

beforeEach(() => {
    vi.clearAllMocks();
    credRepo = {
        find: vi.fn(async () => []),
        findOne: vi.fn(async () => null),
        create: vi.fn((x: any) => x),
        save: vi.fn(async (x: any) => ({ id: 'cred-row-1', createdAt: new Date(), lastUsedAt: null, ...x })),
        delete: vi.fn(async () => ({ affected: 1 })),
    };
    vi.mocked(AppDataSource.getRepository).mockImplementation((entity: any) => {
        if (entity === WebAuthnCredential) return credRepo;
        throw new Error('unexpected repository');
    });
});

describe('PasskeyService.getRegistrationOptions', () => {
    it('excludes already-registered credentials and requires resident keys', async () => {
        credRepo.find.mockResolvedValue([
            { credentialId: 'existing-cred', transports: ['internal'] },
        ]);
        vi.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: 'chal' } as any);

        await PasskeyService.getRegistrationOptions(user);

        const args = vi.mocked(generateRegistrationOptions).mock.calls[0][0];
        expect(args.excludeCredentials).toEqual([
            { id: 'existing-cred', transports: ['internal'] },
        ]);
        expect(args.authenticatorSelection).toMatchObject({
            residentKey: 'required',
            userVerification: 'preferred',
        });
        expect(args.userName).toBe('ara');
    });
});

describe('PasskeyService.verifyRegistration', () => {
    const verifiedResult = {
        verified: true,
        registrationInfo: {
            credential: {
                id: 'new-cred-id',
                publicKey: new Uint8Array([1, 2, 3]),
                counter: 0,
                transports: ['internal'],
            },
            credentialDeviceType: 'multiDevice',
            credentialBackedUp: true,
        },
    } as any;

    it('stores the credential with base64url public key and default name', async () => {
        vi.mocked(verifyRegistrationResponse).mockResolvedValue(verifiedResult);

        const summary = await PasskeyService.verifyRegistration(user, {}, '   ', 'chal');

        expect(credRepo.create).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-1',
            credentialId: 'new-cred-id',
            publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
            counter: '0',
            deviceType: 'multiDevice',
            backedUp: true,
            name: 'Passkey',
        }));
        expect(summary).not.toHaveProperty('publicKey');
        expect(summary).not.toHaveProperty('credentialId');
        expect(summary.name).toBe('Passkey');
    });

    it('rejects a duplicate credential with 409', async () => {
        vi.mocked(verifyRegistrationResponse).mockResolvedValue(verifiedResult);
        credRepo.findOne.mockResolvedValue({ id: 'already-there' });

        await expect(PasskeyService.verifyRegistration(user, {}, 'x', 'chal'))
            .rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects when verification fails', async () => {
        vi.mocked(verifyRegistrationResponse).mockResolvedValue({ verified: false } as any);

        await expect(PasskeyService.verifyRegistration(user, {}, 'x', 'chal'))
            .rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects when the library throws', async () => {
        vi.mocked(verifyRegistrationResponse).mockRejectedValue(new Error('bad attestation'));

        await expect(PasskeyService.verifyRegistration(user, {}, 'x', 'chal'))
            .rejects.toMatchObject({ statusCode: 400 });
    });
});

describe('PasskeyService.verifyLogin', () => {
    const storedCred = () => ({
        id: 'cred-row-1',
        credentialId: 'known-cred',
        publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
        counter: '5',
        transports: ['internal'],
        user,
        lastUsedAt: null,
    });

    it('returns generic 401 for an unknown credential', async () => {
        credRepo.findOne.mockResolvedValue(null);

        await expect(PasskeyService.verifyLogin({ id: 'nope' }, 'chal'))
            .rejects.toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
        expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it('returns generic 401 when signature verification throws', async () => {
        credRepo.findOne.mockResolvedValue(storedCred());
        vi.mocked(verifyAuthenticationResponse).mockRejectedValue(new Error('bad sig'));

        await expect(PasskeyService.verifyLogin({ id: 'known-cred' }, 'chal'))
            .rejects.toMatchObject({ statusCode: 401, message: 'Invalid credentials' });
    });

    it('updates counter and lastUsedAt and issues tokens on success', async () => {
        const cred = storedCred();
        credRepo.findOne.mockResolvedValue(cred);
        vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
            verified: true,
            authenticationInfo: { newCounter: 6 },
        } as any);

        const result = await PasskeyService.verifyLogin({ id: 'known-cred' }, 'chal');

        expect(credRepo.save).toHaveBeenCalledWith(expect.objectContaining({
            counter: '6',
            lastUsedAt: expect.any(Date),
        }));
        expect(AuthService.generateTokens).toHaveBeenCalledWith(user);
        expect(result).toMatchObject({ user, accessToken: 'access', refreshToken: 'refresh' });
    });
});

describe('PasskeyService.deletePasskey', () => {
    it('deletes only within the owning user scope', async () => {
        await PasskeyService.deletePasskey('user-1', 'cred-row-1');
        expect(credRepo.delete).toHaveBeenCalledWith({ id: 'cred-row-1', userId: 'user-1' });
    });

    it('404s when nothing was deleted', async () => {
        credRepo.delete.mockResolvedValue({ affected: 0 });
        await expect(PasskeyService.deletePasskey('user-1', 'other'))
            .rejects.toMatchObject({ statusCode: 404 });
    });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test --workspace=server -- passkey.service`
Expected: FAIL — `Cannot find module '../passkey.service'` (or equivalent).

- [ ] **Step 5: Implement the service**

Create `server/src/services/passkey.service.ts`:

```typescript
import {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { AppDataSource } from '../config/data-source';
import { User } from '../entities';
import { WebAuthnCredential } from '../entities/WebAuthnCredential';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { AuthService } from './auth.service';

const credRepo = () => AppDataSource.getRepository(WebAuthnCredential);

// rpID is the hostname of the SPA origin; credentials are scoped to it.
const rpID = () => new URL(config.clientUrl).hostname;
const RP_NAME = 'Runnable';

export interface PasskeySummary {
    id: string;
    name: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: Date;
    lastUsedAt: Date | null;
}

function serializePasskey(cred: WebAuthnCredential): PasskeySummary {
    return {
        id: cred.id,
        name: cred.name,
        deviceType: cred.deviceType,
        backedUp: cred.backedUp,
        createdAt: cred.createdAt,
        lastUsedAt: cred.lastUsedAt ?? null,
    };
}

export class PasskeyService {
    static async getRegistrationOptions(user: User) {
        const existing = await credRepo().find({ where: { userId: user.id } });
        return generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: rpID(),
            // Stable per-user handle so an authenticator overwrites its own
            // old passkey for this account instead of accumulating copies.
            userID: new TextEncoder().encode(user.id),
            userName: user.username,
            userDisplayName: user.username,
            attestationType: 'none',
            excludeCredentials: existing.map((c) => ({
                id: c.credentialId,
                transports: c.transports as any,
            })),
            authenticatorSelection: {
                // Discoverable credential, required for one-tap login
                residentKey: 'required',
                userVerification: 'preferred',
            },
        });
    }

    static async verifyRegistration(
        user: User,
        response: unknown,
        name: string,
        expectedChallenge: string
    ): Promise<PasskeySummary> {
        let verification;
        try {
            verification = await verifyRegistrationResponse({
                response: response as any,
                expectedChallenge,
                expectedOrigin: config.clientUrl,
                expectedRPID: rpID(),
            });
        } catch {
            throw new AppError('Passkey registration could not be verified', 400);
        }
        if (!verification.verified || !verification.registrationInfo) {
            throw new AppError('Passkey registration could not be verified', 400);
        }

        const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

        const dup = await credRepo().findOne({ where: { credentialId: credential.id } });
        if (dup) {
            throw new AppError('This passkey is already registered', 409);
        }

        const record = credRepo().create({
            userId: user.id,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey).toString('base64url'),
            counter: String(credential.counter),
            transports: credential.transports,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            name: (name || '').trim().slice(0, 64) || 'Passkey',
        });
        const saved = await credRepo().save(record);
        return serializePasskey(saved);
    }

    static async listPasskeys(userId: string): Promise<PasskeySummary[]> {
        const creds = await credRepo().find({ where: { userId }, order: { createdAt: 'ASC' } });
        return creds.map(serializePasskey);
    }

    static async deletePasskey(userId: string, id: string): Promise<void> {
        // Scoped by userId so a foreign id 404s — never reveals whether the
        // passkey exists for someone else.
        const result = await credRepo().delete({ id, userId });
        if (!result.affected) {
            throw new AppError('Passkey not found', 404);
        }
    }

    static async getLoginOptions() {
        return generateAuthenticationOptions({
            rpID: rpID(),
            // Empty allowCredentials → discoverable-credential flow: the
            // browser/OS shows its own account picker.
            allowCredentials: [],
            userVerification: 'preferred',
        });
    }

    static async verifyLogin(
        response: unknown,
        expectedChallenge: string
    ): Promise<{ user: User; accessToken: string; refreshToken: string }> {
        const credentialId = (response as any)?.id;
        const cred = credentialId
            ? await credRepo().findOne({ where: { credentialId }, relations: ['user'] })
            : null;
        if (!cred) {
            throw new AppError('Invalid credentials', 401);
        }

        let verification;
        try {
            verification = await verifyAuthenticationResponse({
                response: response as any,
                expectedChallenge,
                expectedOrigin: config.clientUrl,
                expectedRPID: rpID(),
                credential: {
                    id: cred.credentialId,
                    publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
                    counter: parseInt(cred.counter, 10),
                    transports: cred.transports as any,
                },
            });
        } catch {
            throw new AppError('Invalid credentials', 401);
        }
        if (!verification.verified) {
            throw new AppError('Invalid credentials', 401);
        }

        cred.counter = String(verification.authenticationInfo.newCounter);
        cred.lastUsedAt = new Date();
        await credRepo().save(cred);

        const tokens = AuthService.generateTokens(cred.user);
        return { user: cred.user, ...tokens };
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test --workspace=server -- passkey.service`
Expected: PASS — all tests green.

- [ ] **Step 7: Run the full server suite (no regressions)**

Run: `npm test --workspace=server`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/package.json package-lock.json server/src/config/index.ts server/src/services/passkey.service.ts server/src/services/__tests__/passkey.service.test.ts
git commit -m "feat: PasskeyService with WebAuthn registration and login"
```

---

### Task 3: Passkey routes + mounting

**Files:**
- Modify: `server/src/routes/auth.routes.ts` (export `serializeUser`, `setAuthCookies`)
- Create: `server/src/routes/passkeys.routes.ts`
- Modify: `server/src/index.ts` (mount router)
- Modify: `server/package.json` (add `supertest` devDeps)
- Test: `server/src/__tests__/passkeys.routes.test.ts`

**Interfaces:**
- Consumes: `PasskeyService` (Task 2 signatures), `authenticate`/`AuthRequest` from `server/src/middleware/auth`, `serializeUser(user)` and `setAuthCookies(res, accessToken, refreshToken)` from `auth.routes.ts`.
- Produces: HTTP API mounted at `/api/auth/passkeys`:
  - `POST /register/options` (auth) → options JSON, sets `webauthnChallenge` cookie
  - `POST /register/verify` (auth) body `{ response, name }` → 201 PasskeySummary
  - `GET /` (auth) → `PasskeySummary[]`
  - `DELETE /:id` (auth) → `{ message: 'Passkey removed' }`
  - `POST /login/options` (public) → options JSON + challenge cookie
  - `POST /login/verify` (public) body `{ response }` → `{ user }` + auth cookies

- [ ] **Step 1: Export the shared helpers from auth.routes.ts**

In `server/src/routes/auth.routes.ts` change three declarations (no other changes):

```typescript
export const authLimiter = rateLimit({
```

```typescript
export function serializeUser(user: import('../entities').User) {
```

```typescript
export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
```

- [ ] **Step 2: Install supertest**

Run: `npm install -D supertest@^7 @types/supertest@^6 --workspace=server`
Expected: both appear in `server/package.json` devDependencies.

- [ ] **Step 3: Write the failing route tests**

Create `server/src/__tests__/passkeys.routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

vi.mock('../services/passkey.service', () => ({
    PasskeyService: {
        getRegistrationOptions: vi.fn(),
        verifyRegistration: vi.fn(),
        listPasskeys: vi.fn(),
        deletePasskey: vi.fn(),
        getLoginOptions: vi.fn(),
        verifyLogin: vi.fn(),
    },
}));
vi.mock('../middleware/auth', () => ({
    authenticate: vi.fn((req: any, res: any, next: any) => {
        if (req.headers['x-test-auth'] === 'yes') {
            req.user = { id: 'user-1', email: 'a@b.c', username: 'ara', role: 'user', isApproved: true };
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    }),
}));

import passkeyRoutes from '../routes/passkeys.routes';
import { PasskeyService } from '../services/passkey.service';
import { errorHandler } from '../middleware/errorHandler';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth/passkeys', passkeyRoutes);
    app.use(errorHandler);
    return app;
}

const CHALLENGE_COOKIE = 'webauthnChallenge=test-challenge';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('passkey registration routes', () => {
    it('rejects unauthenticated register/options', async () => {
        await request(makeApp()).post('/api/auth/passkeys/register/options').expect(401);
    });

    it('returns options and sets the challenge cookie', async () => {
        vi.mocked(PasskeyService.getRegistrationOptions).mockResolvedValue({ challenge: 'abc' } as any);

        const res = await request(makeApp())
            .post('/api/auth/passkeys/register/options')
            .set('x-test-auth', 'yes')
            .expect(200);

        expect(res.body.challenge).toBe('abc');
        const cookies = res.headers['set-cookie'].join(';');
        expect(cookies).toContain('webauthnChallenge=abc');
        expect(cookies).toContain('HttpOnly');
    });

    it('register/verify consumes the challenge cookie and clears it', async () => {
        vi.mocked(PasskeyService.verifyRegistration).mockResolvedValue({ id: 'p1', name: 'My key' } as any);

        const res = await request(makeApp())
            .post('/api/auth/passkeys/register/verify')
            .set('x-test-auth', 'yes')
            .set('Cookie', CHALLENGE_COOKIE)
            .send({ response: { id: 'cred' }, name: 'My key' })
            .expect(201);

        expect(PasskeyService.verifyRegistration).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'user-1' }),
            { id: 'cred' },
            'My key',
            'test-challenge'
        );
        // Cookie cleared (expired) after use
        expect(res.headers['set-cookie'].join(';')).toContain('webauthnChallenge=;');
    });

    it('register/verify without a challenge cookie → 400', async () => {
        await request(makeApp())
            .post('/api/auth/passkeys/register/verify')
            .set('x-test-auth', 'yes')
            .send({ response: {}, name: 'x' })
            .expect(400);
        expect(PasskeyService.verifyRegistration).not.toHaveBeenCalled();
    });
});

describe('passkey management routes', () => {
    it('lists the current user passkeys', async () => {
        vi.mocked(PasskeyService.listPasskeys).mockResolvedValue([{ id: 'p1' }] as any);

        const res = await request(makeApp())
            .get('/api/auth/passkeys')
            .set('x-test-auth', 'yes')
            .expect(200);

        expect(PasskeyService.listPasskeys).toHaveBeenCalledWith('user-1');
        expect(res.body).toEqual([{ id: 'p1' }]);
    });

    it('deletes a passkey scoped to the current user', async () => {
        vi.mocked(PasskeyService.deletePasskey).mockResolvedValue(undefined);

        await request(makeApp())
            .delete('/api/auth/passkeys/p1')
            .set('x-test-auth', 'yes')
            .expect(200);

        expect(PasskeyService.deletePasskey).toHaveBeenCalledWith('user-1', 'p1');
    });
});

describe('passkey login routes', () => {
    it('login/options is public and sets the challenge cookie', async () => {
        vi.mocked(PasskeyService.getLoginOptions).mockResolvedValue({ challenge: 'login-chal' } as any);

        const res = await request(makeApp())
            .post('/api/auth/passkeys/login/options')
            .expect(200);

        expect(res.headers['set-cookie'].join(';')).toContain('webauthnChallenge=login-chal');
    });

    it('login/verify sets auth cookies and returns the serialized user', async () => {
        vi.mocked(PasskeyService.verifyLogin).mockResolvedValue({
            user: {
                id: 'user-1', email: 'a@b.c', username: 'ara', role: 'user',
                isApproved: true, githubId: null, googleId: null,
            },
            accessToken: 'the-access-token',
            refreshToken: 'the-refresh-token',
        } as any);

        const res = await request(makeApp())
            .post('/api/auth/passkeys/login/verify')
            .set('Cookie', CHALLENGE_COOKIE)
            .send({ response: { id: 'cred' } })
            .expect(200);

        expect(PasskeyService.verifyLogin).toHaveBeenCalledWith({ id: 'cred' }, 'test-challenge');
        const cookies = res.headers['set-cookie'].join(';');
        expect(cookies).toContain('accessToken=the-access-token');
        expect(cookies).toContain('refreshToken=the-refresh-token');
        expect(res.body.user).toMatchObject({ id: 'user-1', username: 'ara' });
        expect(res.body.user).not.toHaveProperty('passwordHash');
    });

    it('login/verify without a challenge cookie → 400', async () => {
        await request(makeApp())
            .post('/api/auth/passkeys/login/verify')
            .send({ response: { id: 'cred' } })
            .expect(400);
        expect(PasskeyService.verifyLogin).not.toHaveBeenCalled();
    });
});
```

(Verified: `server/src/middleware/errorHandler.ts` exports `errorHandler` and `AppError` with a `statusCode` property.)

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test --workspace=server -- passkeys.routes`
Expected: FAIL — `Cannot find module '../routes/passkeys.routes'`.

- [ ] **Step 5: Implement the routes**

Create `server/src/routes/passkeys.routes.ts`:

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { PasskeyService } from '../services/passkey.service';
import { authLimiter, serializeUser, setAuthCookies } from './auth.routes';
import { config } from '../config';

const router = Router();
const isProduction = config.nodeEnv === 'production';

const CHALLENGE_COOKIE = 'webauthnChallenge';

function setChallengeCookie(res: Response, challenge: string) {
    res.cookie(CHALLENGE_COOKIE, challenge, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000,
        path: '/',
    });
}

// Single-use: read and immediately clear, success or failure.
function consumeChallenge(req: Request, res: Response): string | null {
    const challenge = req.cookies?.[CHALLENGE_COOKIE];
    res.clearCookie(CHALLENGE_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    return challenge || null;
}

// --- Management (authenticated) ---

router.post('/register/options', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const options = await PasskeyService.getRegistrationOptions(req.user!);
        setChallengeCookie(res, options.challenge);
        res.json(options);
    } catch (error) {
        next(error);
    }
});

router.post('/register/verify', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        const challenge = consumeChallenge(req, res);
        if (!challenge) {
            res.status(400).json({ error: 'Challenge expired, try again' });
            return;
        }
        const passkey = await PasskeyService.verifyRegistration(
            req.user!,
            req.body?.response,
            req.body?.name || '',
            challenge
        );
        res.status(201).json(passkey);
    } catch (error) {
        next(error);
    }
});

router.get('/', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        res.json(await PasskeyService.listPasskeys(req.user!.id));
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
        await PasskeyService.deletePasskey(req.user!.id, req.params.id);
        res.json({ message: 'Passkey removed' });
    } catch (error) {
        next(error);
    }
});

// --- Login (public, rate-limited) ---

router.post('/login/options', authLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const options = await PasskeyService.getLoginOptions();
        setChallengeCookie(res, options.challenge);
        res.json(options);
    } catch (error) {
        next(error);
    }
});

router.post('/login/verify', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const challenge = consumeChallenge(req, res);
        if (!challenge) {
            res.status(400).json({ error: 'Challenge expired, try again' });
            return;
        }
        const result = await PasskeyService.verifyLogin(req.body?.response, challenge);
        setAuthCookies(res, result.accessToken, result.refreshToken);
        res.json({ user: serializeUser(result.user) });
    } catch (error) {
        next(error);
    }
});

export default router;
```

- [ ] **Step 6: Mount the router**

In `server/src/index.ts`:

Add the import after the `authRoutes` import:

```typescript
import passkeyRoutes from './routes/passkeys.routes';
```

Add the mount directly after the `app.use('/api/auth', authRoutes);` line:

```typescript
    app.use('/api/auth/passkeys', passkeyRoutes);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test --workspace=server -- passkeys.routes`
Expected: PASS.

- [ ] **Step 8: Full server suite + build**

Run: `npm test --workspace=server && npm run build --workspace=server`
Expected: PASS, build exits 0.

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/auth.routes.ts server/src/routes/passkeys.routes.ts server/src/index.ts server/src/__tests__/passkeys.routes.test.ts server/package.json package-lock.json
git commit -m "feat: passkey registration, management, and login routes"
```

---

### Task 4: Client API module + auth store action

**Files:**
- Modify: `client/package.json` (add `@simplewebauthn/browser`)
- Create: `client/src/api/passkeys.ts`
- Modify: `client/src/api/client.ts` (add passkeys to AUTH_ENDPOINTS)
- Modify: `client/src/store/authStore.ts` (add `loginWithPasskey`)

**Interfaces:**
- Consumes: HTTP API from Task 3; existing axios `api` instance; zustand store.
- Produces (used by Tasks 5–6):
  - `passkeysApi.registerOptions() / registerVerify({ response, name }) / list() / remove(id) / loginOptions() / loginVerify({ response })`
  - `PasskeySummary` interface `{ id, name, deviceType, backedUp, createdAt, lastUsedAt }` (dates as ISO strings)
  - `useAuthStore().loginWithPasskey(): Promise<void>` — runs the full options → `startAuthentication` → verify flow and sets the user in state.

- [ ] **Step 1: Install the browser library**

Run: `npm install @simplewebauthn/browser@^13 --workspace=client`
Expected: appears in `client/package.json` dependencies.

- [ ] **Step 2: Create the API module**

Create `client/src/api/passkeys.ts`:

```typescript
import api from './client';

export interface PasskeySummary {
    id: string;
    name: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: string;
    lastUsedAt: string | null;
}

export const passkeysApi = {
    registerOptions: () => api.post('/auth/passkeys/register/options'),
    registerVerify: (data: { response: unknown; name: string }) =>
        api.post<PasskeySummary>('/auth/passkeys/register/verify', data),
    list: () => api.get<PasskeySummary[]>('/auth/passkeys'),
    remove: (id: string) => api.delete(`/auth/passkeys/${id}`),
    loginOptions: () => api.post('/auth/passkeys/login/options'),
    loginVerify: (data: { response: unknown }) =>
        api.post<{ user: unknown }>('/auth/passkeys/login/verify', data),
};
```

- [ ] **Step 3: Keep the 401 interceptor away from passkey login**

In `client/src/api/client.ts` change the `AUTH_ENDPOINTS` line to:

```typescript
const AUTH_ENDPOINTS = ['/auth/me', '/auth/login', '/auth/register', '/auth/refresh', '/auth/logout', '/auth/passkeys/login'];
```

(A failed passkey login must surface its 401 directly, not trigger a token-refresh retry.)

- [ ] **Step 4: Add the store action**

In `client/src/store/authStore.ts`:

Add imports at the top:

```typescript
import { startAuthentication } from '@simplewebauthn/browser';
import { passkeysApi } from '../api/passkeys';
```

Add to the `AuthState` interface after `login`:

```typescript
    loginWithPasskey: () => Promise<void>;
```

Add the implementation after the `login` action:

```typescript
    loginWithPasskey: async () => {
        set({ isLoading: true });
        try {
            const { data: options } = await passkeysApi.loginOptions();
            const response = await startAuthentication({ optionsJSON: options });
            const { data } = await passkeysApi.loginVerify({ response });
            // Tokens are set as HTTP-only cookies by the server
            set({ user: data.user as User, isAuthenticated: true, isLoading: false });
        } catch (error) {
            set({ isLoading: false });
            throw error;
        }
    },
```

- [ ] **Step 5: Verify the client builds**

Run: `npm run build --workspace=client`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add client/package.json package-lock.json client/src/api/passkeys.ts client/src/api/client.ts client/src/store/authStore.ts
git commit -m "feat: passkey API client and loginWithPasskey store action"
```

---

### Task 5: Login page — "Sign in with a passkey"

**Files:**
- Modify: `client/src/pages/Login.tsx`

**Interfaces:**
- Consumes: `useAuthStore().loginWithPasskey` (Task 4).

- [ ] **Step 1: Add the button and handler**

In `client/src/pages/Login.tsx`:

Change the lucide import to include `KeyRound`:

```typescript
import { Github, Mail, KeyRound } from 'lucide-react';
```

Destructure `loginWithPasskey` from the store:

```typescript
    const { login, loginWithPasskey, isLoading } = useAuthStore();
```

Add the handler after `handleSubmit`:

```typescript
    const handlePasskeyLogin = async () => {
        setError('');
        try {
            await loginWithPasskey();
            navigate('/');
        } catch (err: any) {
            // User dismissed the browser prompt — not an error worth showing
            if (err?.name === 'NotAllowedError' || err?.code === 'ERROR_CEREMONY_ABORTED') return;
            setError(err.response?.data?.error || 'Passkey sign-in failed');
        }
    };
```

Add the button directly after the closing `</div>` of `oauth-buttons` (hidden when WebAuthn is unsupported):

```tsx
                {!!window.PublicKeyCredential && (
                    <button
                        type="button"
                        onClick={handlePasskeyLogin}
                        className="btn btn-secondary btn-full"
                        style={{ marginTop: 12 }}
                        disabled={isLoading}
                    >
                        <KeyRound size={18} />
                        Sign in with a passkey
                    </button>
                )}
```

- [ ] **Step 2: Verify the client builds**

Run: `npm run build --workspace=client`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Login.tsx
git commit -m "feat: passkey sign-in button on the login page"
```

---

### Task 6: Settings page — Passkeys section

**Files:**
- Modify: `client/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: `passkeysApi` and `PasskeySummary` (Task 4), `startRegistration` from `@simplewebauthn/browser`.

- [ ] **Step 1: Add state, effects, and handlers**

In `client/src/pages/Settings.tsx`:

Update imports at the top of the file:

```typescript
import { useEffect, useState, type FormEvent } from 'react';
import { Shield, User, Key, KeyRound, Trash2 } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { passkeysApi, type PasskeySummary } from '../api/passkeys';
```

(Keep the existing `Layout`, `useAuthStore`, `usePageTitle`, `authApi` imports.)

Add inside the `Settings` component after the email state block:

```typescript
    const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
    const [pkName, setPkName] = useState('');
    const [pkError, setPkError] = useState('');
    const [pkSuccess, setPkSuccess] = useState('');
    const [pkLoading, setPkLoading] = useState(false);
    const webauthnSupported = !!window.PublicKeyCredential;

    useEffect(() => {
        passkeysApi.list()
            .then(({ data }) => setPasskeys(data))
            .catch(() => { /* non-fatal — section just shows empty */ });
    }, []);

    const handleAddPasskey = async (e: FormEvent) => {
        e.preventDefault();
        setPkError('');
        setPkSuccess('');
        setPkLoading(true);
        try {
            const { data: options } = await passkeysApi.registerOptions();
            const response = await startRegistration({ optionsJSON: options });
            const { data: created } = await passkeysApi.registerVerify({ response, name: pkName });
            setPasskeys((prev) => [...prev, created]);
            setPkName('');
            setPkSuccess('Passkey added');
        } catch (err: any) {
            // User dismissed the browser prompt — quiet no-op
            if (err?.name !== 'NotAllowedError' && err?.code !== 'ERROR_CEREMONY_ABORTED') {
                setPkError(err.response?.data?.error || 'Failed to add passkey');
            }
        } finally {
            setPkLoading(false);
        }
    };

    const handleDeletePasskey = async (id: string) => {
        if (!confirm('Remove this passkey? You will no longer be able to sign in with it.')) return;
        setPkError('');
        try {
            await passkeysApi.remove(id);
            setPasskeys((prev) => prev.filter((p) => p.id !== id));
        } catch (err: any) {
            setPkError(err.response?.data?.error || 'Failed to remove passkey');
        }
    };
```

- [ ] **Step 2: Add the Passkeys section to the JSX**

After the "Connected Accounts" `<div style={{ marginTop: 32 }}>…</div>` block (before `</div>` closing `page-content`), add:

```tsx
                <div style={{ marginTop: 32 }}>
                    <h3 style={{ marginBottom: 16 }}>Passkeys</h3>
                    <div className="info-card glass" style={{ maxWidth: 520 }}>
                        {pkError && <div className="alert alert-error">{pkError}</div>}
                        {pkSuccess && <div className="alert alert-success">{pkSuccess}</div>}

                        {passkeys.length > 0 && (
                            <div style={{ marginBottom: 16 }}>
                                {passkeys.map((pk) => (
                                    <div
                                        key={pk.id}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}
                                    >
                                        <div>
                                            <div style={{ fontSize: 14, fontWeight: 500 }}>
                                                <KeyRound size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                                                {pk.name}
                                            </div>
                                            <div style={{ fontSize: 12, opacity: 0.7 }}>
                                                Added {new Date(pk.createdAt).toLocaleDateString()}
                                                {pk.lastUsedAt && ` · Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}`}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleDeletePasskey(pk.id)}
                                            className="btn btn-secondary"
                                            style={{ fontSize: 13, padding: '6px 10px' }}
                                            title="Remove passkey"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {webauthnSupported ? (
                            <form onSubmit={handleAddPasskey}>
                                <div className="form-group">
                                    <label>Passkey Name</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="e.g. MacBook Touch ID"
                                        value={pkName}
                                        onChange={(e) => setPkName(e.target.value)}
                                        maxLength={64}
                                    />
                                </div>
                                <button type="submit" className="btn btn-primary" disabled={pkLoading}>
                                    {pkLoading ? <span className="spinner" /> : 'Add Passkey'}
                                </button>
                            </form>
                        ) : (
                            <p style={{ fontSize: 14, opacity: 0.7 }}>Your browser doesn't support passkeys.</p>
                        )}
                    </div>
                </div>
```

- [ ] **Step 3: Verify the client builds**

Run: `npm run build --workspace=client`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/Settings.tsx
git commit -m "feat: passkey management section in settings"
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

- [ ] **Step 2: Manual E2E with Chrome's virtual authenticator**

1. Start the stack: `npm run dev` (requires local Postgres per `docker-compose.yml` / `.env`).
2. Open Chrome at `http://localhost:5175`, log in with email/password.
3. DevTools → More tools → WebAuthn → check "Enable virtual authenticator environment" → add a virtual authenticator (protocol `ctap2`, transport `internal`, ✔ resident keys, ✔ user verification).
4. Settings → Passkeys → name it "Virtual key" → Add Passkey. Expect it to appear in the list with today's date, and a credential to appear in the DevTools WebAuthn panel.
5. Log out. On `/login`, click "Sign in with a passkey". Expect to land on the dashboard, logged in.
6. Back in Settings, expect "Last used" to now be set. Delete the passkey; expect it to disappear.
7. Verify the login rejection path: in the DevTools WebAuthn panel the old credential still exists on the authenticator but was deleted server-side — clicking "Sign in with a passkey" and choosing it should show "Invalid credentials" (or the browser reports no matching passkey, depending on Chrome version).

Expected: all of the above behave as described. If anything fails, fix and commit before proceeding.

- [ ] **Step 3: Final commit (if fixes were made)**

```bash
git add -A && git commit -m "fix: passkey E2E polish"
```
