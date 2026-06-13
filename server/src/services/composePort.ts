import net from 'net';

/**
 * Allocate a free TCP host port by binding to :0 on 0.0.0.0 (the interface
 * docker publishes on) and reading back the kernel-assigned port. There is an
 * inherent small TOCTOU window between closing this probe socket and docker
 * binding the port; acceptable for a single-tenant self-hosted manager, and the
 * old stack's port is never returned because it is still held.
 */
export function getFreeHostPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '0.0.0.0', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object' && addr.port) {
                const { port } = addr;
                srv.close(() => resolve(port));
            } else {
                srv.close(() => reject(new Error('Could not allocate a free host port')));
            }
        });
    });
}

/**
 * Decide the host port to inject as `PORT` into a compose `up`, so a compose
 * file's `${PORT:-8080}` resolves to a real, free host port instead of a fixed
 * default that collides when multiple stacks share it — matching the
 * platform-assigns-PORT convention (Heroku/Railway) compose authors expect.
 *
 * - A user-pinned `PORT` (set in the project's own env vars) always wins:
 *   returns undefined so their value — already written to `.runnable.env` —
 *   is used untouched.
 * - `reuse: true` (initial start / in-place redeploy): keep the project's
 *   current port so the proxy and the running stack stay stable.
 * - otherwise (blue-green parallel stack, or a project with no port yet):
 *   allocate a fresh free port, necessarily distinct from the still-running
 *   old stack's port.
 */
export async function resolveComposePort(
    userEnv: Record<string, unknown> | undefined,
    currentPort: number | null | undefined,
    opts: { reuse: boolean },
): Promise<number | undefined> {
    const pinned = userEnv?.PORT;
    if (pinned !== undefined && String(pinned).trim() !== '') return undefined;
    if (opts.reuse && currentPort && currentPort > 0) return currentPort;
    return getFreeHostPort();
}
