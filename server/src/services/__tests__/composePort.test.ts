import { describe, it, expect } from 'vitest';
import net from 'net';
import { getFreeHostPort, resolveComposePort, isHostPortFree } from '../composePort';

describe('getFreeHostPort', () => {
    it('returns a port in the valid range that is actually bindable', async () => {
        const port = await getFreeHostPort();
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
        // It was free a moment ago — we should be able to bind it now.
        await new Promise<void>((resolve, reject) => {
            const srv = net.createServer();
            srv.once('error', reject);
            srv.listen(port, '0.0.0.0', () => srv.close(() => resolve()));
        });
    });
});

describe('resolveComposePort', () => {
    it('returns undefined when the user pinned PORT (their value wins)', async () => {
        expect(await resolveComposePort({ PORT: '5000' }, 4000, { reuse: true })).toBeUndefined();
        expect(await resolveComposePort({ PORT: 5000 }, null, { reuse: false })).toBeUndefined();
    });

    it('treats an empty/whitespace PORT as not pinned', async () => {
        const p = await resolveComposePort({ PORT: '   ' }, undefined, { reuse: false });
        expect(typeof p).toBe('number');
    });

    it('reuses the current port for stable paths (start / in-place)', async () => {
        expect(await resolveComposePort({}, 54321, { reuse: true })).toBe(54321);
        expect(await resolveComposePort(undefined, 54321, { reuse: true })).toBe(54321);
    });

    it('allocates a fresh port when reuse is off (blue-green parallel stack)', async () => {
        const p = await resolveComposePort({}, 54321, { reuse: false });
        expect(typeof p).toBe('number');
        expect(p).not.toBe(54321);
    });

    it('allocates a fresh port when there is no current port yet', async () => {
        const p = await resolveComposePort({}, null, { reuse: true });
        expect(typeof p).toBe('number');
        expect(p).toBeGreaterThan(0);
    });

    it('reuses a stored port that is still free when verifyFree is on', async () => {
        const free = await getFreeHostPort();
        expect(await resolveComposePort({}, free, { reuse: true, verifyFree: true })).toBe(free);
    });

    it('falls back to a fresh port when the stored port is taken (verifyFree)', async () => {
        // Occupy a port, then ask to reuse it with verification on.
        const taken = await getFreeHostPort();
        await new Promise<void>((resolve, reject) => {
            const srv = net.createServer();
            srv.once('error', reject);
            srv.listen(taken, '0.0.0.0', async () => {
                try {
                    const p = await resolveComposePort({}, taken, { reuse: true, verifyFree: true });
                    expect(p).not.toBe(taken);
                    expect(typeof p).toBe('number');
                    srv.close(() => resolve());
                } catch (e) { srv.close(() => reject(e)); }
            });
        });
    });

    it('reuses a taken port WITHOUT verifyFree (in-place owns its own stack)', async () => {
        const taken = await getFreeHostPort();
        await new Promise<void>((resolve, reject) => {
            const srv = net.createServer();
            srv.once('error', reject);
            srv.listen(taken, '0.0.0.0', async () => {
                try {
                    expect(await resolveComposePort({}, taken, { reuse: true })).toBe(taken);
                    srv.close(() => resolve());
                } catch (e) { srv.close(() => reject(e)); }
            });
        });
    });
});

describe('isHostPortFree', () => {
    it('returns false for an occupied port and true for a free one', async () => {
        const port = await getFreeHostPort();
        expect(await isHostPortFree(port)).toBe(true);
        await new Promise<void>((resolve, reject) => {
            const srv = net.createServer();
            srv.once('error', reject);
            srv.listen(port, '0.0.0.0', async () => {
                expect(await isHostPortFree(port)).toBe(false);
                srv.close(() => resolve());
            });
        });
    });
});
