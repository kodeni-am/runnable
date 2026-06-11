import { describe, it, expect, vi, beforeEach } from 'vitest';

const findOne = vi.fn();
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: () => ({ findOne }) },
}));

import { TlsCheckService } from '../tlsCheck.service';

beforeEach(() => { findOne.mockReset(); });

describe('TlsCheckService.isLivePreviewHostname', () => {
    it('returns true when the hostname matches a live preview', async () => {
        findOne.mockResolvedValue({ subdomain: 'pr-5-app-abc', baseDomain: 'preview.example.com', isPreview: true });
        expect(await TlsCheckService.isLivePreviewHostname('pr-5-app-abc.preview.example.com')).toBe(true);
        expect(findOne).toHaveBeenCalledWith({ where: { subdomain: 'pr-5-app-abc', isPreview: true } });
    });

    it('returns false when no preview has that subdomain', async () => {
        findOne.mockResolvedValue(null);
        expect(await TlsCheckService.isLivePreviewHostname('pr-9-x.preview.example.com')).toBe(false);
    });

    it('returns false when the base domain does not match the stored one', async () => {
        findOne.mockResolvedValue({ subdomain: 'pr-5-app-abc', baseDomain: 'preview.example.com', isPreview: true });
        expect(await TlsCheckService.isLivePreviewHostname('pr-5-app-abc.evil.com')).toBe(false);
    });

    it('returns false for a domain with no dot', async () => {
        expect(await TlsCheckService.isLivePreviewHostname('localhost')).toBe(false);
        expect(findOne).not.toHaveBeenCalled();
    });

    it('returns false for empty input', async () => {
        expect(await TlsCheckService.isLivePreviewHostname('')).toBe(false);
    });
});
