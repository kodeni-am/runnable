import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessService } from '../services/process.service';

describe('ProcessService.redeployExclusive', () => {
    let deployOrRecreate: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        // `deployOrRecreate` is private only to TypeScript; at runtime it is a
        // plain static property, so we can swap it for a stub.
        deployOrRecreate = vi.fn(async () => ({ strategy: 'recreate' as const }));
        (ProcessService as any).deployOrRecreate = deployOrRecreate;
    });

    it('skips the deploy when prepare returns false', async () => {
        const result = await ProcessService.redeployExclusive('p1', async () => false);

        expect(result).toEqual({ ran: false });
        expect(deployOrRecreate).not.toHaveBeenCalled();
    });

    it('deploys when prepare returns true', async () => {
        const result = await ProcessService.redeployExclusive('p2', async () => true);

        expect(result.ran).toBe(true);
        expect(deployOrRecreate).toHaveBeenCalledWith('p2');
    });

    it('deploys when prepare returns undefined (rollback path)', async () => {
        const result = await ProcessService.redeployExclusive('p3', async () => { /* void */ });

        expect(result.ran).toBe(true);
        expect(deployOrRecreate).toHaveBeenCalledWith('p3');
    });
});
