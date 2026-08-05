import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

vi.mock('../services/appSettings.service', () => ({
    AppSettingsService: {
        get: vi.fn(),
        allowsPublicRegistration: vi.fn(),
        update: vi.fn(),
    },
}));
vi.mock('../services/auth.service', () => ({
    AuthService: {
        register: vi.fn(),
        login: vi.fn(),
    },
}));
vi.mock('../middleware/auth', () => ({
    authenticate: vi.fn((_req: any, res: any) => res.status(401).json({ error: 'Unauthorized' })),
}));
vi.mock('passport', () => ({
    default: { authenticate: vi.fn(() => (_req: any, _res: any, next: any) => next()), use: vi.fn() },
}));

import authRoutes from '../routes/auth.routes';
import { AppSettingsService } from '../services/appSettings.service';
import { AuthService } from '../services/auth.service';
import { errorHandler } from '../middleware/errorHandler';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    return app;
}

const VALID = { email: 'user@example.com', username: 'johndoe', password: 'hunter2hunter2' };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('POST /api/auth/register — public registration gate', () => {
    it('refuses to create an account when registration is closed', async () => {
        vi.mocked(AppSettingsService.allowsPublicRegistration).mockResolvedValue(false);

        const res = await request(makeApp()).post('/api/auth/register').send(VALID).expect(403);

        expect(res.body.error).toMatch(/closed/i);
        // The gate must short-circuit before any account is created.
        expect(AuthService.register).not.toHaveBeenCalled();
    });

    it('proceeds to create an account when registration is open', async () => {
        vi.mocked(AppSettingsService.allowsPublicRegistration).mockResolvedValue(true);
        vi.mocked(AuthService.register).mockResolvedValue({
            user: { id: 'u1', ...VALID, role: 'user', isApproved: false },
            accessToken: 'a',
            refreshToken: 'r',
        } as any);

        await request(makeApp()).post('/api/auth/register').send(VALID).expect(201);

        expect(AuthService.register).toHaveBeenCalledWith(VALID.email, VALID.username, VALID.password);
    });

    it('still requires all three fields when registration is open', async () => {
        vi.mocked(AppSettingsService.allowsPublicRegistration).mockResolvedValue(true);

        await request(makeApp()).post('/api/auth/register').send({ email: 'a@b.co' }).expect(400);

        expect(AuthService.register).not.toHaveBeenCalled();
    });
});

describe('GET /api/auth/registration-status', () => {
    it('reports an open instance without requiring auth', async () => {
        vi.mocked(AppSettingsService.allowsPublicRegistration).mockResolvedValue(true);

        const res = await request(makeApp()).get('/api/auth/registration-status').expect(200);

        expect(res.body).toEqual({ allowPublicRegistration: true });
    });

    it('reports a closed instance', async () => {
        vi.mocked(AppSettingsService.allowsPublicRegistration).mockResolvedValue(false);

        const res = await request(makeApp()).get('/api/auth/registration-status').expect(200);

        expect(res.body).toEqual({ allowPublicRegistration: false });
    });
});
