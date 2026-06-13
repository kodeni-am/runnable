import { describe, it, expect } from 'vitest';
import net from 'net';
import { getFreeHostPort, resolveComposePort } from '../composePort';

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
});
