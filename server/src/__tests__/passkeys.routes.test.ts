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
        const cookies = ((res.headers['set-cookie'] || []) as string[]).join(';');
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
        expect(((res.headers['set-cookie'] || []) as string[]).join(';')).toContain('webauthnChallenge=;');
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

        expect(((res.headers['set-cookie'] || []) as string[]).join(';')).toContain('webauthnChallenge=login-chal');
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
        const cookies = ((res.headers['set-cookie'] || []) as string[]).join(';');
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
