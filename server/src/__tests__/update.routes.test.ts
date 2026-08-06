import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/update.service', () => ({
    UpdateService: { status: vi.fn(), check: vi.fn(), start: vi.fn() },
    UPDATE_LOG_PATH: '/var/runnable/update.log',
}));
vi.mock('../middleware/auth', () => ({
    authenticate: vi.fn((_req: any, _res: any, next: any) => next()),
    requireRole: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));
vi.mock('../services/buildCache.service', () => ({ BuildCacheService: { usage: vi.fn(), prune: vi.fn() } }));
vi.mock('../services/appSettings.service', () => ({
    AppSettingsService: { get: vi.fn(), update: vi.fn(), allowsPublicRegistration: vi.fn() },
}));

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock('fs/promises', () => ({ default: { readFile: readFileMock }, readFile: readFileMock }));

import systemRoutes from '../routes/system.routes';
import { UpdateService } from '../services/update.service';
import { errorHandler } from '../middleware/errorHandler';
import { AppError } from '../middleware/errorHandler';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/system', systemRoutes);
    app.use(errorHandler);
    return app;
}

const STATUS = {
    current: 'aaa1111', behind: 2,
    commits: [{ sha: 'bbb2222', subject: 'feat: x' }],
    checkedAt: '2026-08-05T10:00:00.000Z', error: null,
    state: { phase: 'idle', prevCommit: null, newCommit: null, startedAt: null, finishedAt: null, error: null },
};

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/system/update', () => {
    it('returns the merged status', async () => {
        vi.mocked(UpdateService.status).mockResolvedValue(STATUS as any);

        const res = await request(makeApp()).get('/api/system/update').expect(200);

        expect(res.body.behind).toBe(2);
        expect(res.body.state.phase).toBe('idle');
    });
});

describe('POST /api/system/update/check', () => {
    it('forces a fresh check', async () => {
        vi.mocked(UpdateService.check).mockResolvedValue(STATUS as any);
        vi.mocked(UpdateService.status).mockResolvedValue(STATUS as any);

        await request(makeApp()).post('/api/system/update/check').expect(200);

        expect(UpdateService.check).toHaveBeenCalledWith(true);
    });
});

describe('POST /api/system/update', () => {
    it('starts an update and reports the new status', async () => {
        vi.mocked(UpdateService.start).mockResolvedValue(undefined);
        vi.mocked(UpdateService.status).mockResolvedValue(STATUS as any);

        await request(makeApp()).post('/api/system/update').expect(202);

        expect(UpdateService.start).toHaveBeenCalled();
    });

    it('surfaces a 409 when an update is already running', async () => {
        vi.mocked(UpdateService.start).mockRejectedValue(new AppError('An update is already in progress', 409));

        const res = await request(makeApp()).post('/api/system/update').expect(409);

        expect(res.body.error).toMatch(/already in progress/i);
    });

    it('surfaces a 400 when there is nothing to update', async () => {
        vi.mocked(UpdateService.start).mockRejectedValue(new AppError('Already up to date', 400));

        await request(makeApp()).post('/api/system/update').expect(400);
    });
});

describe('GET /api/system/update/log', () => {
    it('returns the log contents', async () => {
        readFileMock.mockResolvedValue('line one\nline two');

        const res = await request(makeApp()).get('/api/system/update/log').expect(200);

        expect(res.body.log).toContain('line two');
    });

    // Before the first update there is no log; that is not an error.
    it('returns an empty log when the file does not exist', async () => {
        const err: any = new Error('ENOENT');
        err.code = 'ENOENT';
        readFileMock.mockRejectedValue(err);

        const res = await request(makeApp()).get('/api/system/update/log').expect(200);

        expect(res.body.log).toBe('');
    });
});
