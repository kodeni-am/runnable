import http from 'http';

/**
 * True when ANYTHING speaking HTTP answers on 127.0.0.1:port — any status
 * code counts (a 500 is still "the app is up"). False on connection refused,
 * reset, or no response within timeoutMs.
 */
export function probeHttp(port: number, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}
