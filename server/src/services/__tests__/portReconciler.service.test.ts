import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock every collaborator BEFORE importing the service under test.
const find = vi.fn();
const findOne = vi.fn();
const update = vi.fn();
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: () => ({ find, findOne, update }) },
}));

const exec = vi.fn();
vi.mock('../sandbox.service', () => ({
    SandboxService: { exec: (...a: any[]) => (exec as any)(...a) },
}));

const generateConfig = vi.fn(async () => 'generated-caddyfile');
const writeConfig = vi.fn(async (sub: string) => `/etc/caddy/sites/${sub}.caddyfile`);
const reloadCaddy = vi.fn(async () => { });
vi.mock('../serverConfig.service', () => ({
    ServerConfigService: {
        generateConfig: (...a: any[]) => (generateConfig as any)(...a),
        writeConfig: (...a: any[]) => (writeConfig as any)(...a),
        reloadCaddy: (...a: any[]) => (reloadCaddy as any)(...a),
    },
}));

const isBusy = vi.fn(() => false);
vi.mock('../process.service', () => ({
    ProcessService: { isBusy: (...a: any[]) => (isBusy as any)(...a) },
}));

const notify = vi.fn(async () => { });
vi.mock('../notification.service', () => ({
    NotificationService: { notify: (...a: any[]) => (notify as any)(...a) },
}));

const readFile = vi.fn(async () => 'reverse_proxy localhost:32784');
vi.mock('fs/promises', () => ({
    default: { readFile: (...a: any[]) => (readFile as any)(...a) },
}));

import { PortReconcilerService, parsePublishedPort } from '../portReconciler.service';

const composeProject = (over: Record<string, unknown> = {}): any => ({
    id: 'p-1', name: 'FinTax', subdomain: 'fintax', serverType: 'app', status: 'running',
    useCompose: true, composeService: 'frontend', internalPort: 8080,
    containerId: 'runnable-02be5e0d', port: 32784,
    configPath: '/etc/caddy/sites/fintax.caddyfile',
    directoryPath: '/var/runnable/projects/fintax', customDomains: [], ...over,
});

const singleProject = (over: Record<string, unknown> = {}): any => composeProject({
    id: 'p-2', subdomain: 'blog', useCompose: false, composeService: undefined,
    containerId: 'runnable-aabbccdd', port: 41000,
    configPath: '/etc/caddy/sites/blog.caddyfile', ...over,
});

/** Wire `docker ps -q` (compose lookup) and `docker port` results. */
function mockDocker(opts: { psId?: string | null; portOut?: string; portExit?: number }) {
    exec.mockImplementation(async (_id: string, _cmd: string, args: string[]) => {
        if (args[0] === 'ps') {
            return { stdout: opts.psId === null ? '' : `${opts.psId ?? 'ctr-abc'}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: opts.portOut ?? '', stderr: '', exitCode: opts.portExit ?? 0 };
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    isBusy.mockReturnValue(false);
    generateConfig.mockResolvedValue('generated-caddyfile');
    writeConfig.mockImplementation(async (sub: string) => `/etc/caddy/sites/${sub}.caddyfile`);
    findOne.mockImplementation(async ({ where }: any) =>
        [composeProject(), singleProject()].find(p => p.id === where.id) ?? null);
    readFile.mockResolvedValue('reverse_proxy localhost:32784');
});

describe('parsePublishedPort', () => {
    it('reads the IPv4 binding docker prints first', () => {
        expect(parsePublishedPort('0.0.0.0:32769\n[::]:32769\n')).toBe(32769);
    });

    it('falls back to the IPv6 binding when that is all docker published', () => {
        expect(parsePublishedPort('[::]:32769\n')).toBe(32769);
    });

    it('prefers the IPv4 binding when the two disagree', () => {
        expect(parsePublishedPort('[::]:41001\n0.0.0.0:41000\n')).toBe(41000);
    });

    it('returns null for empty or unparsable output', () => {
        expect(parsePublishedPort('')).toBeNull();
        expect(parsePublishedPort('\n  \n')).toBeNull();
        expect(parsePublishedPort('no port here')).toBeNull();
    });

    it('rejects out-of-range ports', () => {
        expect(parsePublishedPort('0.0.0.0:0')).toBeNull();
        expect(parsePublishedPort('0.0.0.0:70000')).toBeNull();
    });
});

describe('discoverLivePort', () => {
    it('resolves a compose service by project+service label, then asks docker port', async () => {
        mockDocker({ psId: 'ctr-abc', portOut: '0.0.0.0:32769\n' });
        expect(await PortReconcilerService.discoverLivePort(composeProject())).toBe(32769);

        const psArgs = exec.mock.calls[0][2];
        expect(psArgs).toContain('label=com.docker.compose.project=runnable-02be5e0d');
        expect(psArgs).toContain('label=com.docker.compose.service=frontend');
        expect(exec.mock.calls[1][2]).toEqual(['port', 'ctr-abc', '8080']);
    });

    it('asks docker port directly for a single-container project', async () => {
        mockDocker({ portOut: '0.0.0.0:41005\n' });
        expect(await PortReconcilerService.discoverLivePort(singleProject())).toBe(41005);
        expect(exec.mock.calls[0][2]).toEqual(['port', 'runnable-aabbccdd', '8080']);
    });

    it('returns null when the compose stack has no container for the service', async () => {
        mockDocker({ psId: null });
        expect(await PortReconcilerService.discoverLivePort(composeProject())).toBeNull();
    });

    it('returns null when docker port fails', async () => {
        mockDocker({ portOut: '', portExit: 1 });
        expect(await PortReconcilerService.discoverLivePort(singleProject())).toBeNull();
    });
});

describe('reconcileAll', () => {
    it('repairs the route when docker moved the published port (the reboot case)', async () => {
        find.mockResolvedValue([composeProject()]);
        mockDocker({ portOut: '0.0.0.0:32769\n' });

        expect(await PortReconcilerService.reconcileAll()).toBe(1);

        expect(generateConfig).toHaveBeenCalledWith(expect.objectContaining({
            subdomain: 'fintax', port: 32769,
        }));
        expect(update).toHaveBeenCalledWith('p-1', expect.objectContaining({ port: 32769 }));
        expect(reloadCaddy).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.anything(),
            expect.objectContaining({ event: 'health.route_repaired', success: true }));
    });

    it('does nothing when the recorded port still matches the live one', async () => {
        find.mockResolvedValue([composeProject()]);
        mockDocker({ portOut: '0.0.0.0:32784\n' });
        readFile.mockResolvedValue('reverse_proxy localhost:32784');

        expect(await PortReconcilerService.reconcileAll()).toBe(0);
        expect(writeConfig).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(reloadCaddy).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
    });

    it('rewrites a caddyfile that drifted from a correct DB port, without notifying', async () => {
        find.mockResolvedValue([composeProject()]);
        mockDocker({ portOut: '0.0.0.0:32784\n' });
        readFile.mockResolvedValue('reverse_proxy localhost:11111');

        expect(await PortReconcilerService.reconcileAll()).toBe(1);
        expect(generateConfig).toHaveBeenCalledWith(expect.objectContaining({ port: 32784 }));
        expect(reloadCaddy).toHaveBeenCalledTimes(1);
        expect(notify).not.toHaveBeenCalled();
    });

    it('leaves the route alone when nothing is published (workload down)', async () => {
        find.mockResolvedValue([composeProject()]);
        mockDocker({ psId: null });

        expect(await PortReconcilerService.reconcileAll()).toBe(0);
        expect(writeConfig).not.toHaveBeenCalled();
        expect(reloadCaddy).not.toHaveBeenCalled();
    });

    it('skips a project with a lifecycle op in flight, never racing a deploy cutover', async () => {
        find.mockResolvedValue([composeProject()]);
        mockDocker({ portOut: '0.0.0.0:32769\n' });
        isBusy.mockReturnValue(true);

        expect(await PortReconcilerService.reconcileAll()).toBe(0);
        expect(exec).not.toHaveBeenCalled();
        expect(writeConfig).not.toHaveBeenCalled();
    });

    it('aborts the write if a deploy started while docker was being queried', async () => {
        find.mockResolvedValue([composeProject()]);
        mockDocker({ portOut: '0.0.0.0:32769\n' });
        isBusy.mockReturnValueOnce(false).mockReturnValue(true);

        expect(await PortReconcilerService.reconcileAll()).toBe(0);
        expect(writeConfig).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it('aborts the write if the project stopped being RUNNING mid-sweep', async () => {
        find.mockResolvedValue([composeProject()]);
        mockDocker({ portOut: '0.0.0.0:32769\n' });
        findOne.mockResolvedValue(composeProject({ status: 'stopped' }));

        expect(await PortReconcilerService.reconcileAll()).toBe(0);
        expect(writeConfig).not.toHaveBeenCalled();
    });

    it('skips projects with no container recorded', async () => {
        find.mockResolvedValue([composeProject({ containerId: null })]);
        expect(await PortReconcilerService.reconcileAll()).toBe(0);
        expect(exec).not.toHaveBeenCalled();
    });

    it('reloads caddy once for a whole reboot-drifted fleet', async () => {
        find.mockResolvedValue([composeProject(), singleProject()]);
        mockDocker({ portOut: '0.0.0.0:32769\n' });
        findOne.mockImplementation(async ({ where }: any) =>
            where.id === 'p-1' ? composeProject() : singleProject());

        expect(await PortReconcilerService.reconcileAll()).toBe(2);
        expect(writeConfig).toHaveBeenCalledTimes(2);
        expect(reloadCaddy).toHaveBeenCalledTimes(1);
    });

    it('keeps reconciling the fleet when one project throws', async () => {
        find.mockResolvedValue([composeProject(), singleProject()]);
        let first = true;
        exec.mockImplementation(async (_id: string, _cmd: string, args: string[]) => {
            if (args[0] === 'ps') {
                if (first) { first = false; throw new Error('docker daemon unreachable'); }
                return { stdout: 'ctr-abc\n', stderr: '', exitCode: 0 };
            }
            return { stdout: '0.0.0.0:32769\n', stderr: '', exitCode: 0 };
        });
        findOne.mockResolvedValue(singleProject());

        expect(await PortReconcilerService.reconcileAll()).toBe(1);
        expect(reloadCaddy).toHaveBeenCalledTimes(1);
    });
});
