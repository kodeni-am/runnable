import { AppDataSource } from '../config/data-source';
import { Project, ServerType, ServiceStatus } from '../entities';
import { SandboxService } from './sandbox.service';
import { ProcessService } from './process.service';
import { NotificationService } from './notification.service';

interface HealthState {
    consecutiveFailures: number;
    restartCount: number;
    windowStartedAt: number;
}

const CHECK_INTERVAL_MS = 60_000;
const FAILURES_BEFORE_ACTION = 2; // tolerate one blip (e.g. mid-restart by Docker itself)
const MAX_RESTARTS_PER_WINDOW = 3;
const RESTART_WINDOW_MS = 60 * 60 * 1000;

export class HealthMonitorService {
    private static timer: NodeJS.Timeout | null = null;
    private static running = false;
    private static state = new Map<string, HealthState>();

    static start(): void {
        if (HealthMonitorService.timer) return;
        HealthMonitorService.timer = setInterval(() => {
            HealthMonitorService.checkAll().catch(err =>
                console.error('Health monitor sweep failed:', err)
            );
        }, CHECK_INTERVAL_MS);
        // Don't keep the process alive just for the monitor
        HealthMonitorService.timer.unref?.();
        console.log('🩺 Health monitor started (interval: 60s)');
    }

    static stop(): void {
        if (HealthMonitorService.timer) {
            clearInterval(HealthMonitorService.timer);
            HealthMonitorService.timer = null;
        }
    }

    /** Reset failure/restart bookkeeping, e.g. after a manual start/stop. */
    static reset(projectId: string): void {
        HealthMonitorService.state.delete(projectId);
    }

    static async checkAll(): Promise<void> {
        // Skip a sweep entirely if the previous one is still running
        if (HealthMonitorService.running) return;
        HealthMonitorService.running = true;
        try {
            const projectRepo = AppDataSource.getRepository(Project);
            const projects = await projectRepo.find({
                where: { status: ServiceStatus.RUNNING, serverType: ServerType.APP },
            });

            for (const project of projects) {
                try {
                    await HealthMonitorService.checkProject(project);
                } catch (err) {
                    console.error(`Health check failed for project ${project.id}:`, err);
                }
            }

            // Drop bookkeeping for projects that are no longer monitored
            const monitored = new Set(projects.map(p => p.id));
            for (const id of HealthMonitorService.state.keys()) {
                if (!monitored.has(id)) HealthMonitorService.state.delete(id);
            }
        } finally {
            HealthMonitorService.running = false;
        }
    }

    private static async isContainerRunning(project: Project): Promise<boolean> {
        if (!project.containerId) return false;

        if (project.useCompose) {
            // containerId holds the compose project name — healthy when at
            // least one of its containers is up
            const result = await SandboxService.exec(project.id, 'docker', [
                'ps', '-q', '--filter', `label=com.docker.compose.project=${project.containerId}`,
            ]);
            return result.exitCode === 0 && result.stdout.trim().length > 0;
        }

        const result = await SandboxService.exec(project.id, 'docker', [
            'inspect', '--format', '{{.State.Status}}', project.containerId,
        ]);
        return result.exitCode === 0 && result.stdout.trim() === 'running';
    }

    private static async checkProject(project: Project): Promise<void> {
        const healthy = await HealthMonitorService.isContainerRunning(project);
        const state = HealthMonitorService.state.get(project.id)
            ?? { consecutiveFailures: 0, restartCount: 0, windowStartedAt: Date.now() };

        if (healthy) {
            state.consecutiveFailures = 0;
            HealthMonitorService.state.set(project.id, state);
            return;
        }

        state.consecutiveFailures += 1;
        HealthMonitorService.state.set(project.id, state);
        if (state.consecutiveFailures < FAILURES_BEFORE_ACTION) return;

        // Re-check the DB status before acting: the container may be down
        // because a stop/redeploy started after we listed the projects.
        const projectRepo = AppDataSource.getRepository(Project);
        const fresh = await projectRepo.findOne({ where: { id: project.id } });
        if (!fresh || fresh.status !== ServiceStatus.RUNNING) {
            HealthMonitorService.state.delete(project.id);
            return;
        }

        if (Date.now() - state.windowStartedAt > RESTART_WINDOW_MS) {
            state.restartCount = 0;
            state.windowStartedAt = Date.now();
        }

        const canRestart = fresh.autoRestart && state.restartCount < MAX_RESTARTS_PER_WINDOW;

        await projectRepo.update(project.id, { status: ServiceStatus.ERROR });
        ProcessService.emitStatus(project.id, ServiceStatus.ERROR);
        await NotificationService.notify(fresh, {
            event: 'health.down',
            title: `${fresh.name} is down`,
            message: canRestart
                ? 'The container stopped unexpectedly. Attempting automatic restart.'
                : fresh.autoRestart
                    ? `The container stopped unexpectedly. Auto-restart limit reached (${MAX_RESTARTS_PER_WINDOW}/hour) — manual intervention required.`
                    : 'The container stopped unexpectedly. Auto-restart is disabled for this project.',
            success: false,
        });

        if (!canRestart) return;

        state.restartCount += 1;
        state.consecutiveFailures = 0;
        HealthMonitorService.state.set(project.id, state);

        // Not awaited: a restart is a full rebuild that can take minutes, and
        // awaiting it here would suspend health checks for every other
        // project. The guarded restart bails if the user stopped the project
        // (or a redeploy recovered it) before the lock was acquired.
        const attempt = state.restartCount;
        ProcessService.restartIfStillError(project.id)
            .then((restarted) => {
                if (!restarted) return;
                return NotificationService.notify(fresh, {
                    event: 'health.restarted',
                    title: `${fresh.name} restarted`,
                    message: `Automatic restart succeeded (attempt ${attempt}/${MAX_RESTARTS_PER_WINDOW} this hour).`,
                    success: true,
                });
            })
            .catch((err: any) =>
                NotificationService.notify(fresh, {
                    event: 'health.restart_failed',
                    title: `${fresh.name} restart failed`,
                    message: `Automatic restart failed: ${err?.message || 'unknown error'}`,
                    success: false,
                })
            );
    }
}
