import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import { probeHttp } from '../httpProbe';

let servers: Array<http.Server | net.Server> = [];
afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
});

function listen(server: http.Server | net.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as net.AddressInfo).port);
        });
    });
}

describe('probeHttp', () => {
    it('resolves true on a 200 response', async () => {
        const server = http.createServer((_req, res) => res.end('ok'));
        servers.push(server);
        const port = await listen(server);
        expect(await probeHttp(port)).toBe(true);
    });

    it('resolves true on a 500 response (any HTTP answer counts)', async () => {
        const server = http.createServer((_req, res) => { res.statusCode = 500; res.end('boom'); });
        servers.push(server);
        const port = await listen(server);
        expect(await probeHttp(port)).toBe(true);
    });

    it('resolves false on a closed port', async () => {
        // Grab a port then close it so nothing listens there
        const server = http.createServer();
        servers.push(server);
        const port = await listen(server);
        await new Promise(r => server.close(r));
        expect(await probeHttp(port)).toBe(false);
    });

    it('resolves false when the socket accepts but never answers', async () => {
        const server = net.createServer(() => { /* accept, say nothing */ });
        servers.push(server);
        const port = await listen(server);
        expect(await probeHttp(port, 300)).toBe(false);
    });
});
