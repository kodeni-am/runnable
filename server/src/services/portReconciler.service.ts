import fs from 'fs/promises';
import { Repository } from 'typeorm';
import { AppDataSource } from '../config/data-source';
import { Project, ServerType, ServiceStatus } from '../entities';
import { SandboxService } from './sandbox.service';
import { ServerConfigService } from './serverConfig.service';
import { ProcessService } from './process.service';
import { NotificationService } from './notification.service';
import { buildProxyOptions } from './proxyOptions';

/**
 * Extract the host port from `docker port <ctr> <internal>` output.
 *
 * Docker prints one line per binding, IPv4 and IPv6 separately:
 *
 *     0.0.0.0:32769
 *     [::]:32769
 *
 * The IPv4 line wins: Caddy's `localhost:N` upstream resolves to 127.0.0.1
 * first, so that is the binding that has to be right. The IPv6 line is only a
 * fallback for a stack published on `::` alone.
 */
export function parsePublishedPort(stdout: string): number | null {
    let ipv6Fallback: number | null = null;

    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        const match = trimmed.match(/:(\d+)$/);
        if (!match) continue;

        const port = Number(match[1]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

        if (trimmed.startsWith('[')) {
            ipv6Fallback ??= port;
            continue;
        }
        return port;
    }

    return ipv6Fallback;
}

/**
 * Keeps each project's proxied host port truthful.
 *
 * Runnable publishes app workloads on *ephemeral* host ports — `-p 0:<internal>`
 * for single containers, and for compose the `${PORT}` injection that a compose
 * file is free to ignore (`ports: ["8080"]` publishes on a random host port).
 * Docker picks a fresh one every time it starts the container, including when
 * `--restart unless-stopped` brings the whole box back after a reboot. The port
 * recorded at deploy time is therefore a snapshot, not a fact, and the Caddy
 * `reverse_proxy` written from it dials a port nothing listens on any more:
 * a permanent 502 that no container-level liveness check can see, because the
 * container is up and healthy the entire time.
 *
 * This service closes that gap by re-discovering the live port and repairing
 * the route — at boot, and on every health sweep.
 */
export class PortReconcilerService {
    private static sweeping = false;

    /**
     * The host port the project's workload is published on right now, or null
     * when nothing is published (workload down, or still coming up).
     */
    static async discoverLivePort(project: Project): Promise<number | null> {
        if (!project.containerId) return null;
        const internalPort = project.internalPort || 8080;
        let containerRef = project.containerId;

        if (project.useCompose) {
            if (!project.composeService) return null;
            // Resolve the service's container by compose labels rather than
            // via `docker compose port`: that would need the compose file, the
            // env file and an identical ${PORT} interpolation to all still be
            // present and valid. Repairing a route must not depend on any of
            // them — a project whose compose file was edited since the last
            // deploy still deserves a working proxy.
            const ps = await SandboxService.exec(project.id, 'docker', [
                'ps', '-q',
                '--filter', `label=com.docker.compose.project=${project.containerId}`,
                '--filter', `label=com.docker.compose.service=${project.composeService}`,
            ]);
            if (ps.exitCode !== 0) return null;

            const id = ps.stdout.trim().split('\n')[0]?.trim();
            if (!id) return null;
            containerRef = id;
        }

        const result = await SandboxService.exec(
            project.id, 'docker', ['port', containerRef, String(internalPort)]);
        if (result.exitCode !== 0) return null;

        return parsePublishedPort(result.stdout);
    }

    /** The port the on-disk proxy config currently routes to, or null if unknown. */
    private static async configuredPort(project: Project): Promise<number | null> {
        if (!project.configPath) return null;
        try {
            const content = await fs.readFile(project.configPath, 'utf-8');
            const match = content.match(/localhost:(\d+)/);
            return match ? Number(match[1]) : null;
        } catch {
            return null;
        }
    }

    /**
     * Re-point every running app project at the port its workload actually
     * listens on. Returns how many routes were rewritten; Caddy is reloaded
     * once for the whole sweep, not once per project — a reboot drifts every
     * project on the box at the same moment.
     */
    static async reconcileAll(): Promise<number> {
        if (PortReconcilerService.sweeping) return 0;
        PortReconcilerService.sweeping = true;

        try {
            const projectRepo = AppDataSource.getRepository(Project);
            const projects = await projectRepo.find({
                where: { status: ServiceStatus.RUNNING, serverType: ServerType.APP },
                relations: ['customDomains'],
            });

            let repaired = 0;
            for (const project of projects) {
                try {
                    if (await PortReconcilerService.reconcileProject(project, projectRepo)) repaired++;
                } catch (err) {
                    console.error(`Port reconciliation failed for project ${project.id}:`, err);
                }
            }

            if (repaired > 0) await ServerConfigService.reloadCaddy();
            return repaired;
        } finally {
            PortReconcilerService.sweeping = false;
        }
    }

    /** Returns true when the proxy config was rewritten (so a reload is owed). */
    private static async reconcileProject(
        project: Project,
        projectRepo: Repository<Project>,
    ): Promise<boolean> {
        if (!project.containerId) return false;

        // A lifecycle op owns the proxy config for as long as it runs, and a
        // blue-green deploy spends part of that time mid-cutover between the
        // old port and the new one. DEPLOYING is only emitted over the socket
        // and never persisted, so the row still reads RUNNING — the lock is
        // the only reliable way to see it. Never race it.
        if (ProcessService.isBusy(project.id)) return false;

        const live = await PortReconcilerService.discoverLivePort(project);
        // Nothing published means the workload is down or still starting.
        // Whether that is an outage is the health monitor's call; blanking or
        // guessing the route here would only turn a 502 into a broken config.
        if (live === null) return false;

        const drifted = live !== project.port;
        const onDisk = await PortReconcilerService.configuredPort(project);
        // Also repair a config file that disagrees with an otherwise correct
        // DB port — a half-finished cutover or a hand edit leaves exactly that.
        if (!drifted && (onDisk === null || onDisk === live)) return false;

        // Re-read under the same guards: shelling out to docker took time, and
        // a deploy or a stop may have started in the meantime.
        const fresh = await projectRepo.findOne({
            where: { id: project.id },
            relations: ['customDomains'],
        });
        if (!fresh || fresh.status !== ServiceStatus.RUNNING) return false;
        if (ProcessService.isBusy(project.id)) return false;

        const previous = fresh.port;
        const content = await ServerConfigService.generateConfig(
            await buildProxyOptions(fresh, fresh.customDomains, { port: live })
        );
        const configPath = await ServerConfigService.writeConfig(
            fresh.subdomain, content, fresh.serverType);
        await projectRepo.update(fresh.id, { port: live, configPath });

        if (previous !== live) {
            console.warn(
                `⚠️  ${fresh.subdomain}: proxied port drifted ${previous ?? 'unset'} → ${live}; route repaired`);
            await NotificationService.notify(fresh, {
                event: 'health.route_repaired',
                title: `${fresh.name} route repaired`,
                message:
                    `Docker republished this project on host port ${live} (the proxy still pointed at ` +
                    `${previous ?? 'nothing'}, which serves 502s). The route has been updated automatically.`,
                success: true,
                meta: { previousPort: String(previous ?? ''), port: String(live) },
            });
        }

        return true;
    }
}
