import { describe, it, expect, vi, beforeEach } from 'vitest';

const find = vi.fn();
const findOne = vi.fn();
const update = vi.fn();
vi.mock('../../config/data-source', () => ({
    AppDataSource: { getRepository: () => ({ find, findOne, update }) },
}));

const exec = vi.fn(async () => ({ stdout: 'ctr-abc\n', stderr: '', exitCode: 0 }));
vi.mock('../sandbox.service', () => ({
    SandboxService: { exec: (...a: any[]) => (exec as any)(...a) },
}));

const emitStatus = vi.fn();
const restartIfStillError = vi.fn(async () => false);
vi.mock('../process.service', () => ({
    ProcessService: {
        emitStatus: (...a: any[]) => (emitStatus as any)(...a),
        restartIfStillError: (...a: any[]) => (restartIfStillError as any)(...a),
    },
}));

const notify = vi.fn(async () => { });
vi.mock('../notification.service', () => ({
    NotificationService: { notify: (...a: any[]) => (notify as any)(...a) },
}));

vi.mock('../preview.service', () => ({
    PreviewService: { reapExpired: vi.fn(async () => { }) },
}));

const reconcileAll = vi.fn(async () => 0);
vi.mock('../portReconciler.service', () => ({
    PortReconcilerService: { reconcileAll: (...a: any[]) => (reconcileAll as any)(...a) },
}));

const probeHttp = vi.fn(async () => true);
vi.mock('../httpProbe', () => ({
    probeHttp: (...a: any[]) => (probeHttp as any)(...a),
}));

import { HealthMonitorService } from '../healthMonitor.service';

const project: any = {
    id: 'p-1', name: 'FinTax', subdomain: 'fintax', serverType: 'app', status: 'running',
    useCompose: true, composeService: 'frontend', containerId: 'runnable-02be5e0d',
    port: 32769, autoRestart: true,
};

/** The container is up: `docker ps -q` returns an id. */
const containerUp = () => exec.mockResolvedValue({ stdout: 'ctr-abc\n', stderr: '', exitCode: 0 } as any);

beforeEach(() => {
    vi.clearAllMocks();
    HealthMonitorService.reset('p-1');
    find.mockResolvedValue([project]);
    findOne.mockResolvedValue(project);
    containerUp();
    probeHttp.mockResolvedValue(true);
    reconcileAll.mockResolvedValue(0);
});

describe('route probe', () => {
    it('probes the host port Caddy dials, not just the container', async () => {
        await HealthMonitorService.checkAll();
        expect(probeHttp).toHaveBeenCalledWith(32769, expect.any(Number));
        expect(notify).not.toHaveBeenCalled();
    });

    it('reconciles drifted ports before probing, so a repairable route is never alerted on', async () => {
        const order: string[] = [];
        reconcileAll.mockImplementation(async () => { order.push('reconcile'); return 0; });
        probeHttp.mockImplementation(async () => { order.push('probe'); return true; });

        await HealthMonitorService.checkAll();
        expect(order).toEqual(['reconcile', 'probe']);
    });

    it('tolerates a single failed probe without alerting', async () => {
        probeHttp.mockResolvedValue(false);
        await HealthMonitorService.checkAll();
        expect(notify).not.toHaveBeenCalled();
    });

    it('alerts once the route stays dead across sweeps', async () => {
        probeHttp.mockResolvedValue(false);
        await HealthMonitorService.checkAll();
        await HealthMonitorService.checkAll();

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(project, expect.objectContaining({
            event: 'health.route_down', success: false,
        }));
    });

    it('does not re-alert every sweep while the route stays down', async () => {
        probeHttp.mockResolvedValue(false);
        for (let i = 0; i < 5; i++) await HealthMonitorService.checkAll();
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('notifies recovery and re-arms for the next outage', async () => {
        probeHttp.mockResolvedValue(false);
        await HealthMonitorService.checkAll();
        await HealthMonitorService.checkAll();

        probeHttp.mockResolvedValue(true);
        await HealthMonitorService.checkAll();
        expect(notify).toHaveBeenLastCalledWith(project, expect.objectContaining({
            event: 'health.route_restored', success: true,
        }));

        probeHttp.mockResolvedValue(false);
        await HealthMonitorService.checkAll();
        await HealthMonitorService.checkAll();
        expect(notify).toHaveBeenLastCalledWith(project, expect.objectContaining({
            event: 'health.route_down',
        }));
        expect(notify).toHaveBeenCalledTimes(3);
    });

    it('never restarts a project over a dead route — the container is fine', async () => {
        probeHttp.mockResolvedValue(false);
        await HealthMonitorService.checkAll();
        await HealthMonitorService.checkAll();
        expect(restartIfStillError).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it('skips the probe for a project with no recorded port', async () => {
        find.mockResolvedValue([{ ...project, port: undefined }]);
        await HealthMonitorService.checkAll();
        expect(probeHttp).not.toHaveBeenCalled();
    });

    it('does not probe a project whose container is down', async () => {
        exec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);
        await HealthMonitorService.checkAll();
        expect(probeHttp).not.toHaveBeenCalled();
    });
});
