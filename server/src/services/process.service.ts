import { ChildProcess, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { AppDataSource } from '../config/data-source';
import { Project, ServiceStatus, ServerType } from '../entities';
import { SandboxService } from './sandbox.service';
import { ServerConfigService } from './serverConfig.service';
import { DetectService } from './detect.service';
import { ComposePolicyService } from './composePolicy.service';
import { BuildCacheService } from './buildCache.service';
import { parse as parseYaml } from 'yaml';
import { assessParallelSafety } from './composeSafety';
import { resolveComposePort } from './composePort';
import { probeHttp } from './httpProbe';
import {
    containerGenerations, nextContainerGeneration,
    composeGenerations, nextComposeGeneration,
} from './deployNames';
import { DeployError, DeployStrategy, HealthGateResult, DeployPhase } from './deployError';
import { HealthMonitorService } from './healthMonitor.service';

interface ManagedProcess {
    process: ChildProcess;
    projectId: string;
    logFile: string;
}

const managedProcesses = new Map<string, ManagedProcess>();

// Zero-downtime deploy tuning. The health gate is generous because the
// legacy path never verified listening at all — a slow-booting app (long
// migrations) must not become undeployable; it degrades to a warned cutover.
const HEALTH_GATE_TIMEOUT_MS = 180_000;
const HEALTH_PROBE_INTERVAL_MS = 1_000;
const RETIRE_GRACE_MS = 10_000;

export interface DeployOutcome {
    strategy: DeployStrategy;
    healthGate: HealthGateResult;
    strategyReason?: string;
}

export interface RedeployResult {
    ran: boolean;
    strategy?: DeployStrategy;
    healthGate?: HealthGateResult;
    strategyReason?: string;
    durationMs?: number;
}

export class ProcessService {
    private static io: any;

    static setSocketIO(io: any) {
        ProcessService.io = io;
    }

    // Lifecycle ops (start/stop/restart/redeploy) for the same project must
    // never overlap: a second build racing the first deadlocks buildkit, and
    // a webhook's `git reset --hard` corrupts a build that is copying the
    // working tree. Ops queue per project; other projects are unaffected.
    private static readonly projectLocks = new Map<string, Promise<unknown>>();
    private static readonly queuedRedeploys = new Set<string>();

    private static withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
        const prev = ProcessService.projectLocks.get(projectId) ?? Promise.resolve();
        const next = prev.catch(() => { }).then(fn);
        ProcessService.projectLocks.set(projectId, next);
        next.finally(() => {
            if (ProcessService.projectLocks.get(projectId) === next) {
                ProcessService.projectLocks.delete(projectId);
            }
        }).catch(() => { });
        return next;
    }

    static start(projectId: string): Promise<void> {
        return ProcessService.withProjectLock(projectId, () => ProcessService.doStart(projectId));
    }

    private static async doStart(projectId: string): Promise<void> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: ['customDomains'],
        });

        if (!project) throw new Error('Project not found');
        if (managedProcesses.has(projectId)) {
            throw new Error('Service is already running');
        }

        // Ensure config is up to date
        const customDomains = (project.customDomains || [])
            .filter(d => d.verified)
            .map(d => d.domain);

        let actualPort = project.port || 8080;

        // If the project is an APP, we build and run via Docker + Railpack
        if (project.serverType === ServerType.APP) {
            try {
                // Set BUILDING status immediately
                project.status = ServiceStatus.BUILDING;
                await projectRepo.save(project);
                ProcessService.emitStatus(projectId, ServiceStatus.BUILDING);

                const containerName = `runnable-${projectId.substring(0, 8)}`;
                const buildLogPath = ProcessService.buildLogPathFor(project);

                // Ensure logs directory exists
                await fs.mkdir(path.dirname(buildLogPath), { recursive: true });

                // Clear previous build logs
                await fs.writeFile(buildLogPath, `Building project ${project.name} (${projectId})...\n`);

                // Auto-detect project type if no custom commands set
                const detection = await DetectService.detect(project.directoryPath);
                await fs.appendFile(buildLogPath, `Detected runtime: ${detection.runtime}\n`);
                if (detection.buildCommand) {
                    await fs.appendFile(buildLogPath, `Auto-detected build command: ${detection.buildCommand}\n`);
                }
                if (detection.startCommand) {
                    await fs.appendFile(buildLogPath, `Auto-detected start command: ${detection.startCommand}\n`);
                }

                // Use user-provided commands, falling back to auto-detected defaults
                const effectiveBuildCommand = project.buildCommand || detection.buildCommand;

                // Parse project env vars — needed by both compose and Railpack paths
                const userEnv = typeof project.envVars === 'string'
                    ? JSON.parse(project.envVars)
                    : (project.envVars || {});

                // Determine whether to use docker compose or the Railpack single-container path
                const useCompose = project.useCompose || detection.useCompose;
                const composeFile = project.composeFile || detection.composeFile || 'docker-compose.yml';

                if (useCompose) {
                    // ── DOCKER COMPOSE DEPLOYMENT PATH ──────────────────────────────────
                    const composeName = `runnable-${projectId.substring(0, 8)}`;
                    await ProcessService.validateComposeAndWriteEnv(project, userEnv, buildLogPath, composeName, composeFile);

                    // Bring down any previous compose stack for this project,
                    // including orphaned blue-green generations
                    await SandboxService.exec(
                        projectId, 'docker',
                        [...ProcessService.composeBaseArgs(project, composeName, composeFile), 'down', '--remove-orphans'],
                        project.directoryPath,
                    );
                    await ProcessService.sweepComposeGenerations(project, [composeName]);

                    // Start reuses the project's existing port (stable across restarts)
                    // only if it's actually free — the creation-time port isn't unique
                    // across compose projects, so a colliding one falls back to a fresh
                    // free port. (The stack was just brought down, so a port that's truly
                    // ours reads as free here.)
                    const injectPort = await resolveComposePort(userEnv, project.port, { reuse: true, verifyFree: true });
                    actualPort = await ProcessService.composeUpAndWaitForPort(project, composeName, buildLogPath, composeFile, [], injectPort);
                    // Store the compose project name in containerId so stop/logs can reference it
                    project.containerId = composeName;
                    project.port = actualPort;

                } else {
                    // ── RAILPACK / DOCKERFILE DEPLOYMENT PATH ───────────────────────────
                    await ProcessService.buildAppImage(project, effectiveBuildCommand, userEnv, buildLogPath);

                    // Kill existing container and any orphaned blue/green generations
                    await ProcessService.sweepContainerGenerations(project, [], false);

                    actualPort = await ProcessService.runAppContainerAndWaitForPort(project, containerName, userEnv, buildLogPath);

                    // Save container information to database. internalPort is left as
                    // stored — writing the 8080 fallback back would make a cleared
                    // (null) internal port silently reappear in the settings UI.
                    project.containerId = containerName;
                    project.port = actualPort; // update the proxied port for ServerConfigService
                }
            } catch (err: any) {
                console.error(`App build/run failed for project ${projectId}:`, err);
                project.status = ServiceStatus.ERROR;
                await projectRepo.save(project);
                ProcessService.emitStatus(projectId, ServiceStatus.ERROR);
                throw new Error(`Failed to start app container: ${err.message}`);
            }
        }

        const configContent = await ServerConfigService.generateConfig({
            subdomain: project.subdomain,
            directoryPath: project.directoryPath,
            port: (project as any).port || 8080,
            serverType: (project as any).serverType || ServerType.STATIC,
            customDomains: (project as any).customDomains?.map((cd: any) => ({
                domain: cd.domain,
                redirectTarget: cd.redirectTarget || null
            })) || [],
            baseDomain: (project as any).baseDomain || undefined,
            onDemandTls: (project as any).isPreview === true,
        });
        const configPath = await ServerConfigService.writeConfig(
            project.subdomain,
            configContent,
            project.serverType
        );

        project.configPath = configPath;
        project.status = ServiceStatus.RUNNING;
        await projectRepo.save(project);

        // Reload the master reverse proxy
        await ServerConfigService.reloadCaddy();

        // Emit status update
        ProcessService.emitStatus(projectId, ServiceStatus.RUNNING);

        // Opportunistic build-cache GC. Fire-and-forget: enforceCap never
        // throws, and a deploy must never wait on (or fail from) a prune.
        void BuildCacheService.enforceCap();
    }

    // ── Shared build/run helpers (used by doStart and doDeploy) ─────────────

    private static buildLogPathFor(project: Project): string {
        const storageDir = path.resolve(config.hosting.servDir, '..');
        return path.join(storageDir, 'logs', `${project.subdomain}-build.log`);
    }

    private static async logAndCheck(
        buildLogPath: string,
        result: { stdout: string; stderr: string; exitCode: number },
        step: string,
    ): Promise<void> {
        const logContent = `\n--- ${step} ---\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nEXIT CODE: ${result.exitCode}\n\n`;
        await fs.appendFile(buildLogPath, logContent);
        if (result.exitCode !== 0) {
            throw new Error(`${step} failed with exit code ${result.exitCode}. See logs for details.`);
        }
    }

    private static composeBaseArgs(project: Project, composeName: string, composeFile: string): string[] {
        const envFilePath = path.join(project.directoryPath, '.runnable.env');
        return ['compose', '-p', composeName, '--env-file', envFilePath, '-f', composeFile];
    }

    /**
     * Validate the compose file and write the project's env file. Screens the
     * stack for host-escape directives BEFORE running it. Validates the output
     * of `docker compose config` rather than the raw file: config applies
     * ${VAR} interpolation (from the user-controlled env file), resolves YAML
     * merge keys/anchors and `extends`, and normalizes volumes to long form —
     * so the validated structure matches exactly what `up` will run. Enforced
     * here (not at config-save) because the file is user-editable in the file
     * browser until deploy.
     *
     * Returns the parsed normalized config so callers can also run the
     * parallel-safety assessment without a second `config` invocation.
     */
    private static async validateComposeAndWriteEnv(
        project: Project,
        userEnv: Record<string, string>,
        buildLogPath: string,
        composeName: string,
        composeFile: string,
    ): Promise<any> {
        if (!project.composeService) {
            throw new Error(
                'Compose deployment requires a "Primary Service" name. ' +
                'Go to the project Settings tab and set the "Primary Service" field ' +
                'to the name of the compose service that exposes the HTTP port.'
            );
        }

        await fs.appendFile(buildLogPath, `\nUsing docker compose (file: ${composeFile}, service: ${project.composeService}, project: ${composeName})\n`);

        // Confine the compose file to the project directory — it's
        // passed to `docker compose -f` below.
        const composeAbsPath = path.resolve(project.directoryPath, composeFile);
        const projectBase = path.resolve(project.directoryPath);
        if (composeAbsPath !== projectBase && !composeAbsPath.startsWith(projectBase + path.sep)) {
            throw new Error('Compose file path is outside the project directory');
        }

        // Pre-scan the raw file for env_file/extends/include paths
        // that would make the upcoming `docker compose config` (root)
        // read host files. Must happen before config runs.
        try {
            const rawCompose = await fs.readFile(composeAbsPath, 'utf-8');
            ComposePolicyService.validateRawReferences(rawCompose, project.directoryPath);
        } catch (err: any) {
            if (err instanceof Error && err.name === 'ComposePolicyError') {
                await fs.appendFile(buildLogPath, `\n❌ Compose rejected by security policy: ${err.message}\n`);
                throw new Error(`Compose file rejected: ${err.message}`);
            }
            throw new Error(`Compose file not found: ${composeFile}`);
        }

        // Write project env vars to a .runnable.env file so they are available
        // for variable interpolation in the compose YAML and for `environment:`
        // keys without explicit values.
        const envFilePath = path.join(project.directoryPath, '.runnable.env');
        const envFileContent = Object.entries(userEnv)
            .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n')}`)
            .join('\n');
        await fs.writeFile(envFilePath, envFileContent + '\n');
        await fs.appendFile(buildLogPath,
            `Wrote ${Object.keys(userEnv).length} env var(s) to .runnable.env\n`);

        const configResult = await SandboxService.exec(
            project.id, 'docker',
            [...ProcessService.composeBaseArgs(project, composeName, composeFile), 'config'],
            project.directoryPath,
        );
        if (configResult.exitCode !== 0) {
            await fs.appendFile(buildLogPath, `\n❌ Invalid compose file:\n${configResult.stderr}\n`);
            throw new Error(`Invalid compose file: ${configResult.stderr.trim() || 'docker compose config failed'}`);
        }
        let doc: any;
        try {
            doc = parseYaml(configResult.stdout);
            ComposePolicyService.validate(doc);
        } catch (err: any) {
            await fs.appendFile(buildLogPath, `\n❌ Compose rejected by security policy: ${err.message}\n`);
            throw new Error(`Compose file rejected: ${err.message}`);
        }
        return doc;
    }

    /**
     * `up --build -d` (streaming) on the given compose project name, then
     * discover the primary service's published host port.
     */
    private static async composeUpAndWaitForPort(
        project: Project,
        composeName: string,
        buildLogPath: string,
        composeFile: string,
        extraUpArgs: string[] = [],
        injectPort?: number,
    ): Promise<number> {
        const composeBase = ProcessService.composeBaseArgs(project, composeName, composeFile);

        // Supply `PORT` to the compose file's `${PORT}` interpolation. Passed via
        // the subprocess env (which wins over --env-file), and to the discovery
        // calls too so they interpolate identically. Undefined when the user
        // pinned their own PORT — then their .runnable.env value is used as-is.
        const composeEnv = injectPort !== undefined ? { PORT: String(injectPort) } : undefined;
        if (injectPort !== undefined) {
            await fs.appendFile(buildLogPath, `Assigned host port ${injectPort} for $\{PORT}\n`);
        }

        await fs.appendFile(buildLogPath, '\n--- Docker Compose Up (streaming) ---\n');
        const composeExitCode = await SandboxService.spawn(
            project.id, 'docker',
            [...composeBase, 'up', '--build', '-d', ...extraUpArgs],
            buildLogPath,
            project.directoryPath,
            composeEnv,
        );

        if (composeExitCode !== 0) {
            throw new Error(`docker compose up failed with exit code ${composeExitCode}. See build logs for details.`);
        }

        // Discover the host port published by the primary service
        const composeService = project.composeService!;
        const internalPort = project.internalPort || 8080;
        let actualHostPort: number | null = null;

        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const portResult = await SandboxService.exec(
                project.id, 'docker',
                [...composeBase, 'port', composeService, String(internalPort)],
                project.directoryPath,
                composeEnv,
            );
            await fs.appendFile(buildLogPath,
                `[Port wait] attempt ${attempt + 1}: ${portResult.stdout.trim() || portResult.stderr.trim()}\n`);

            const match = portResult.stdout.match(/:(\d+)/);
            if (match) {
                actualHostPort = parseInt(match[1], 10);
                break;
            }
        }

        if (!actualHostPort) {
            const psResult = await SandboxService.exec(
                project.id, 'docker',
                [...composeBase, 'ps'],
                project.directoryPath,
                composeEnv,
            );
            await fs.appendFile(buildLogPath, `--- Compose PS ---\n${psResult.stdout}\n`);
            throw new Error(
                `Could not determine host port for compose service "${composeService}" ` +
                `(internal: ${internalPort}) after 15s. ` +
                `Make sure the service exposes port ${internalPort} in the compose file.`
            );
        }
        return actualHostPort;
    }

    /** BuildKit ensure + optional build command + Railpack image build (streaming). */
    private static async buildAppImage(
        project: Project,
        effectiveBuildCommand: string | undefined,
        userEnv: Record<string, string>,
        buildLogPath: string,
    ): Promise<void> {
        const imageName = `runnable-img-${project.id.substring(0, 8)}`;

        // Ensure BuildKit is running (required for railpack)
        const buildkitCheck = await SandboxService.exec(project.id, 'docker', ['ps', '-a', '--filter', 'name=runnable-buildkit', '--format', '{{.Status}}']);
        if (!buildkitCheck.stdout.includes('Up')) {
            await fs.appendFile(buildLogPath, "Starting BuildKit daemon...\n");
            // Remove if exists but not running
            await SandboxService.exec(project.id, 'docker', ['rm', '-f', 'runnable-buildkit']);
            const bkResult = await SandboxService.exec(project.id, 'docker', [
                'run', '-d', '--name', 'runnable-buildkit', '--privileged', 'moby/buildkit:latest'
            ]);
            if (bkResult.exitCode !== 0) {
                await fs.appendFile(buildLogPath, `Failed to start BuildKit: ${bkResult.stderr}\n`);
                throw new Error("Failed to start BuildKit daemon");
            }
        }

        const buildkitEnv = {
            BUILDKIT_HOST: 'docker-container://runnable-buildkit'
        };

        // Run build command (user-provided or auto-detected)
        if (effectiveBuildCommand) {
            await fs.appendFile(buildLogPath, `\n--- Build Command: ${effectiveBuildCommand} ---\n`);
            const buildEnv = { ...buildkitEnv, ...userEnv };
            const buildResult = await SandboxService.exec(project.id, 'sh', ['-c', effectiveBuildCommand], project.directoryPath, buildEnv);
            await ProcessService.logAndCheck(buildLogPath, buildResult, 'Build');
        }

        // Build image using railpack (Streaming)
        await fs.appendFile(buildLogPath, "\n--- Railpack Build (Streaming) ---\n");
        const buildExitCode = await SandboxService.spawn(project.id, 'railpack', ['build', '.', '--name', imageName], buildLogPath, project.directoryPath, buildkitEnv);

        if (buildExitCode !== 0) {
            throw new Error(`Railpack build failed with exit code ${buildExitCode}. See logs for details.`);
        }
    }

    /**
     * `docker run` the built image under the given container name (dynamic
     * host port) and wait for the container to be running with a mapped port.
     */
    private static async runAppContainerAndWaitForPort(
        project: Project,
        containerName: string,
        userEnv: Record<string, string>,
        buildLogPath: string,
    ): Promise<number> {
        const imageName = `runnable-img-${project.id.substring(0, 8)}`;
        const internalPort = project.internalPort || 8080;
        const runArgs = [
            'run', '-d',
            '--name', containerName,
            '-p', `0:${internalPort}`, // Dynamic host port mapping
            '-e', `PORT=${internalPort}`,
            '--restart', 'unless-stopped',
        ];

        // Inject user-defined environment variables
        Object.entries(userEnv).forEach(([key, value]) => {
            runArgs.push('-e', `${key}=${value}`);
        });

        runArgs.push(imageName);

        // Only override the container start command if the user explicitly set one.
        // Railpack's entrypoint is ["/bin/bash", "-c"] and handles setting up the
        // nix environment, PATH, and runtime dependencies. We must NOT replace that
        // with --entrypoint sh. Instead, pass the custom command as CMD args AFTER
        // the image name — Docker will feed it to Railpack's entrypoint as-is.
        if (project.startCommand) {
            runArgs.push(project.startCommand);
        }

        const runResult = await SandboxService.exec(project.id, 'docker', runArgs);
        await ProcessService.logAndCheck(buildLogPath, runResult, 'Docker Run');

        // Wait for the container to be running, then inspect the dynamic host port.
        let actualHostPort: number | null = null;
        for (let attempt = 0; attempt < 10; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const stateResult = await SandboxService.exec(project.id, 'docker', [
                'inspect', '--format', '{{.State.Status}}', containerName,
            ]);
            const state = stateResult.stdout.trim();
            await fs.appendFile(buildLogPath, `[Port wait] attempt ${attempt + 1}: container state = ${state}\n`);

            if (state === 'exited' || state === 'dead') {
                const crashLogs = await SandboxService.exec(project.id, 'docker', ['logs', '--tail', '50', containerName]);
                await fs.appendFile(buildLogPath, `--- Container Crash Logs ---\n${crashLogs.stdout}\n${crashLogs.stderr}\n`);
                throw new Error(
                    `Container exited immediately (state: ${state}). Check start command and container logs.\n${crashLogs.stderr || crashLogs.stdout}`
                );
            }

            if (state === 'running') {
                const portResult = await SandboxService.exec(project.id, 'docker', ['port', containerName, String(internalPort)]);
                await fs.appendFile(buildLogPath, `--- Docker Port Inspect ---\nSTDOUT:\n${portResult.stdout}\nSTDERR:\n${portResult.stderr}\nEXIT CODE: ${portResult.exitCode}\n`);
                const match = portResult.stdout.match(/:(\d+)/);
                if (match) {
                    actualHostPort = parseInt(match[1], 10);
                    break;
                }
            }
        }

        if (!actualHostPort) {
            const stateResult = await SandboxService.exec(project.id, 'docker', [
                'inspect', '--format', '{{.State.Status}}', containerName,
            ]);
            throw new Error(
                `Could not determine dynamic host port for Docker container after 10s. Container state: ${stateResult.stdout.trim()}`
            );
        }
        return actualHostPort;
    }

    // ── Blue-green generation sweeps ─────────────────────────────────────────

    /**
     * Read the port the on-disk proxy config currently routes to. Used by the
     * sweep's adoption rule. Returns null when unknown.
     */
    private static async configuredProxyPort(project: Project): Promise<number | null> {
        if (!project.configPath) return null;
        try {
            const content = await fs.readFile(project.configPath, 'utf-8');
            const m = content.match(/localhost:(\d+)/);
            return m ? parseInt(m[1], 10) : null;
        } catch {
            return null;
        }
    }

    /**
     * Remove orphaned blue/green generation containers — crashed deploys
     * leave them behind with --restart unless-stopped, so they even survive
     * host reboots. With `adopt`, a live orphan that the on-disk proxy config
     * points at is ADOPTED instead of removed (it is the survivor of a crash
     * between proxy switch and DB persist; removing it would take the serving
     * container down). Returns the adopted name, if any.
     */
    private static async sweepContainerGenerations(
        project: Project,
        keep: string[],
        adopt: boolean,
    ): Promise<string | null> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        const proxyPort = adopt ? await ProcessService.configuredProxyPort(project) : null;
        let adopted: string | null = null;

        for (const name of containerGenerations(base)) {
            if (keep.includes(name)) continue;
            // Anchored filter: docker's `name=` is an unanchored regex and the
            // base name would otherwise match its own -blue/-green suffixes
            const ps = await SandboxService.exec(project.id, 'docker',
                ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}']);
            if (!ps.stdout.trim()) continue;

            if (adopt && proxyPort && ps.stdout.trim() === 'running') {
                const internalPort = project.internalPort || 8080;
                const portRes = await SandboxService.exec(project.id, 'docker', ['port', name, String(internalPort)]);
                const m = portRes.stdout.match(/:(\d+)/);
                if (m && parseInt(m[1], 10) === proxyPort) {
                    adopted = name;
                    continue;
                }
            }
            await SandboxService.exec(project.id, 'docker', ['rm', '-f', name]).catch(() => { });
        }
        return adopted;
    }

    /**
     * Tear down one compose generation. Prefers a full `down` (removes
     * networks and locally built images via --rmi local); falls back to
     * label-based container removal when the compose file is gone or no
     * longer parses — `down -f <file>` would silently orphan everything.
     */
    private static async removeComposeGeneration(project: Project, genName: string): Promise<void> {
        const composeFile = project.composeFile || 'docker-compose.yml';
        const envFilePath = path.join(project.directoryPath, '.runnable.env');
        const envFileArgs: string[] = [];
        try {
            await fs.access(envFilePath);
            envFileArgs.push('--env-file', envFilePath);
        } catch { /* env file not yet written */ }

        const down = await SandboxService.exec(
            project.id, 'docker',
            ['compose', '-p', genName, ...envFileArgs, '-f', composeFile,
                'down', '--remove-orphans', '--rmi', 'local'],
            project.directoryPath,
        ).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
        if (down.exitCode === 0) return;

        const ps = await SandboxService.exec(project.id, 'docker',
            ['ps', '-aq', '--filter', `label=com.docker.compose.project=${genName}`]);
        const ids = ps.stdout.trim().split('\n').filter(Boolean);
        if (ids.length) {
            await SandboxService.exec(project.id, 'docker', ['rm', '-f', ...ids]).catch(() => { });
        }
    }

    private static async sweepComposeGenerations(project: Project, keep: string[]): Promise<void> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        for (const name of composeGenerations(base)) {
            if (keep.includes(name)) continue;
            await ProcessService.removeComposeGeneration(project, name);
        }
    }

    // ── Zero-downtime deploy engine ──────────────────────────────────────────

    static emitDeployProgress(projectId: string, phase: DeployPhase, strategy: DeployStrategy, message?: string) {
        if (ProcessService.io) {
            ProcessService.io.to(`project:${projectId}`).emit('deploy:progress',
                { projectId, phase, strategy, message, ts: Date.now() });
        }
    }

    static emitDeployFinished(projectId: string, payload: {
        outcome: 'success' | 'failed-still-serving' | 'failed-down';
        strategy?: DeployStrategy;
        durationMs: number;
        healthGate?: HealthGateResult;
    }) {
        if (ProcessService.io) {
            ProcessService.io.to(`project:${projectId}`).emit('deploy:finished', { projectId, ...payload });
        }
    }

    /** Compose-aware "is the active container/stack actually up". */
    private static async isActiveLive(project: Project): Promise<boolean> {
        try {
            return await HealthMonitorService.isContainerRunning(project);
        } catch {
            return false;
        }
    }

    /**
     * Health gate: any HTTP response on the published port counts as ready.
     * 'degraded' when nothing answered within the timeout but the workload is
     * still alive — we cut over anyway ("never worse than today": the legacy
     * path never verified listening at all). Throws when the workload died.
     */
    private static async healthGate(
        project: Project,
        hostPort: number,
        stillAlive: () => Promise<boolean>,
        buildLogPath: string,
        strategy: DeployStrategy,
    ): Promise<HealthGateResult> {
        ProcessService.emitDeployProgress(project.id, 'health-check', strategy);
        const deadline = Date.now() + HEALTH_GATE_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (await probeHttp(hostPort)) {
                await fs.appendFile(buildLogPath, `[Health gate] HTTP response on :${hostPort} — ready\n`);
                return 'passed';
            }
            if (!(await stillAlive())) {
                throw new Error('New container exited before responding to HTTP');
            }
            await new Promise(r => setTimeout(r, HEALTH_PROBE_INTERVAL_MS));
        }
        await fs.appendFile(buildLogPath,
            `[Health gate] ⚠ No HTTP response after ${HEALTH_GATE_TIMEOUT_MS / 1000}s but the container is running — ` +
            `switching traffic anyway (degraded pass)\n`);
        return 'degraded';
    }

    /** Regenerate + write the proxy config for the given port. Returns the config path. */
    private static async writeProxyConfig(project: Project, port: number): Promise<string> {
        const content = await ServerConfigService.generateConfig({
            subdomain: project.subdomain,
            directoryPath: project.directoryPath,
            port,
            serverType: project.serverType,
            customDomains: (project.customDomains || []).map((cd: any) => ({
                domain: cd.domain,
                redirectTarget: cd.redirectTarget || null,
            })),
            baseDomain: project.baseDomain || undefined,
            onDemandTls: project.isPreview === true,
        });
        return ServerConfigService.writeConfig(project.subdomain, content, project.serverType);
    }

    /**
     * Cutover: config file → strict reload. On reload failure the file is
     * rolled back to the old port and best-effort reloaded — the on-disk
     * config must never disagree with what Caddy serves, because any other
     * project's lifecycle op reloads globally and would silently activate it.
     * Returns the written config path.
     */
    private static async switchProxy(project: Project, newPort: number, oldPort: number): Promise<string> {
        const configPath = await ProcessService.writeProxyConfig(project, newPort);
        try {
            await ServerConfigService.reloadCaddy({ strict: true });
        } catch (err) {
            await ProcessService.writeProxyConfig(project, oldPort).catch(() => { });
            await ServerConfigService.reloadCaddy();
            throw err;
        }
        return configPath;
    }

    /**
     * Zero-downtime deploy: the active container/stack keeps serving while
     * the new version builds. Throws DeployError on failure; never records
     * Deployment rows or sends notifications (callers own those).
     */
    static async doDeploy(projectId: string): Promise<DeployOutcome> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({
            where: { id: projectId },
            relations: ['customDomains'],
        });
        if (!project) throw new Error('Project not found');

        HealthMonitorService.reset(projectId);
        ProcessService.emitStatus(projectId, ServiceStatus.DEPLOYING);

        const buildLogPath = ProcessService.buildLogPathFor(project);
        await fs.mkdir(path.dirname(buildLogPath), { recursive: true });
        await fs.writeFile(buildLogPath, `Deploying project ${project.name} (${projectId}) — zero-downtime\n`);

        const detection = await DetectService.detect(project.directoryPath);
        const userEnv = typeof project.envVars === 'string'
            ? JSON.parse(project.envVars)
            : (project.envVars || {});
        const useCompose = project.useCompose || detection.useCompose;
        const composeFile = project.composeFile || detection.composeFile || 'docker-compose.yml';

        let strategy: DeployStrategy = 'blue-green';
        let strategyReason: string | undefined;
        try {
            if (!useCompose) {
                const effectiveBuildCommand = project.buildCommand || detection.buildCommand;
                const healthGate = await ProcessService.deploySingleBlueGreen(
                    project, projectRepo, effectiveBuildCommand, userEnv, buildLogPath);
                return await ProcessService.finishDeploy(project, projectRepo, { strategy, healthGate });
            }

            const composeName = project.containerId!;
            const doc = await ProcessService.validateComposeAndWriteEnv(
                project, userEnv, buildLogPath, composeName, composeFile);
            const safety = assessParallelSafety(doc, { composeProjectName: composeName });

            if (safety.safeToParallel) {
                await fs.appendFile(buildLogPath, `Zero-downtime: blue-green (stack is safe to run twice)\n`);
                // Parallel stack: needs a fresh port distinct from the still-running old one.
                const injectPort = await resolveComposePort(userEnv, project.port, { reuse: false });
                const healthGate = await ProcessService.deployComposeBlueGreen(
                    project, projectRepo, buildLogPath, composeFile, injectPort);
                return await ProcessService.finishDeploy(project, projectRepo, { strategy, healthGate });
            }

            strategy = 'compose-inplace';
            strategyReason = safety.reasons.join('; ');
            await fs.appendFile(buildLogPath, `Zero-downtime: in-place update (${strategyReason})\n`);
            // In-place keeps the same project name and port — reuse it so the proxy stays put.
            const injectPort = await resolveComposePort(userEnv, project.port, { reuse: true });
            await ProcessService.deployComposeInPlace(project, projectRepo, buildLogPath, composeFile, injectPort);
            return await ProcessService.finishDeploy(project, projectRepo,
                { strategy, healthGate: 'passed', strategyReason });
        } catch (err: any) {
            if (err instanceof DeployError) throw err;
            // Verify, never assume: the old workload may have died on its own
            // during a long build.
            const stillServing = await ProcessService.isActiveLive(project);
            if (stillServing) {
                await projectRepo.update(projectId, { status: ServiceStatus.RUNNING });
            }
            await fs.appendFile(buildLogPath, `\n❌ Deploy failed: ${err?.message}\n` +
                (stillServing ? '✓ Previous version kept serving — visitors saw nothing.\n' : ''));
            throw new DeployError(err?.message || 'Deploy failed', stillServing, strategy);
        }
    }

    private static async finishDeploy(
        project: Project,
        projectRepo: ReturnType<typeof AppDataSource.getRepository<Project>>,
        outcome: DeployOutcome,
    ): Promise<DeployOutcome> {
        project.status = ServiceStatus.RUNNING;
        await projectRepo.save(project);
        ProcessService.emitDeployProgress(project.id, 'done', outcome.strategy);
        ProcessService.emitStatus(project.id, ServiceStatus.RUNNING);
        // Opportunistic build-cache GC — same fire-and-forget as doStart
        void BuildCacheService.enforceCap();
        return outcome;
    }

    /** Tier 1: single-container blue-green. */
    private static async deploySingleBlueGreen(
        project: Project,
        projectRepo: ReturnType<typeof AppDataSource.getRepository<Project>>,
        effectiveBuildCommand: string | undefined,
        userEnv: Record<string, string>,
        buildLogPath: string,
    ): Promise<HealthGateResult> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        const imageName = `runnable-img-${project.id.substring(0, 8)}`;

        // Sweep orphans of crashed deploys; adopt the survivor of a crash
        // between proxy switch and DB persist.
        const adopted = await ProcessService.sweepContainerGenerations(project, [project.containerId!], true);
        if (adopted) {
            await fs.appendFile(buildLogPath, `Adopted live generation ${adopted} left by an interrupted deploy\n`);
            project.containerId = adopted;
            await projectRepo.save(project);
        }
        const active = project.containerId!;
        const oldPort = project.port!;
        const incoming = nextContainerGeneration(base, active);

        const oldImageId = (await SandboxService.exec(project.id, 'docker',
            ['inspect', '--format', '{{.Image}}', active])).stdout.trim();

        ProcessService.emitDeployProgress(project.id, 'building', 'blue-green');
        await ProcessService.buildAppImage(project, effectiveBuildCommand, userEnv, buildLogPath);

        let healthGate: HealthGateResult;
        try {
            ProcessService.emitDeployProgress(project.id, 'starting', 'blue-green');
            const hostPort = await ProcessService.runAppContainerAndWaitForPort(
                project, incoming, userEnv, buildLogPath);

            healthGate = await ProcessService.healthGate(
                project, hostPort,
                async () => {
                    const s = await SandboxService.exec(project.id, 'docker',
                        ['inspect', '--format', '{{.State.Status}}', incoming]);
                    return s.stdout.trim() === 'running';
                },
                buildLogPath, 'blue-green');

            ProcessService.emitDeployProgress(project.id, 'switching', 'blue-green');
            const configPath = await ProcessService.switchProxy(project, hostPort, oldPort);

            // Persist AFTER the successful reload: on reload failure the DB
            // must still name the old, healthy container.
            project.containerId = incoming;
            project.port = hostPort;
            project.configPath = configPath;
            await projectRepo.save(project);
        } catch (err) {
            // Single cleanup funnel for every post-build failure path — a
            // missed path would leak a --restart unless-stopped orphan.
            await SandboxService.exec(project.id, 'docker', ['rm', '-f', incoming]).catch(() => { });
            const builtId = (await SandboxService.exec(project.id, 'docker',
                ['inspect', '--format', '{{.Id}}', imageName]).catch(() => ({ stdout: '' } as any))).stdout.trim();
            if (builtId && builtId !== oldImageId) {
                // The failed build's image would dangle untracked at the next
                // re-tag; nothing else ever collects it.
                await SandboxService.exec(project.id, 'docker', ['rmi', '-f', builtId]).catch(() => { });
            }
            throw err;
        }

        // Retire the old generation. The DB already points at the new
        // container, so a crash from here on only leaves an idempotent
        // retirement for the next sweep.
        ProcessService.emitDeployProgress(project.id, 'retiring', 'blue-green');
        await new Promise(r => setTimeout(r, RETIRE_GRACE_MS));
        await SandboxService.exec(project.id, 'docker', ['stop', active]).catch(() => { });
        await SandboxService.exec(project.id, 'docker', ['rm', '-f', active]).catch(() => { });
        if (oldImageId) {
            const currentId = (await SandboxService.exec(project.id, 'docker',
                ['inspect', '--format', '{{.Id}}', imageName]).catch(() => ({ stdout: '' } as any))).stdout.trim();
            // Skip when the rebuild was byte-identical (e.g. rollback to the
            // deployed commit) — old and new are the same image.
            if (currentId && currentId !== oldImageId) {
                await SandboxService.exec(project.id, 'docker', ['rmi', '-f', oldImageId]).catch(() => { });
            }
        }
        return healthGate;
    }

    /** Tier 2: compose blue-green — a parallel stack under a generation project name. */
    private static async deployComposeBlueGreen(
        project: Project,
        projectRepo: ReturnType<typeof AppDataSource.getRepository<Project>>,
        buildLogPath: string,
        composeFile: string,
        injectPort?: number,
    ): Promise<HealthGateResult> {
        const base = `runnable-${project.id.substring(0, 8)}`;
        const oldName = project.containerId!;
        const oldPort = project.port!;
        const incoming = nextComposeGeneration(base, oldName);

        await ProcessService.sweepComposeGenerations(project, [oldName]);

        let healthGate: HealthGateResult;
        try {
            ProcessService.emitDeployProgress(project.id, 'building', 'blue-green');
            const hostPort = await ProcessService.composeUpAndWaitForPort(
                project, incoming, buildLogPath, composeFile, [], injectPort);

            healthGate = await ProcessService.healthGate(
                project, hostPort,
                async () => {
                    const ps = await SandboxService.exec(project.id, 'docker',
                        ['ps', '-q', '--filter', `label=com.docker.compose.project=${incoming}`]);
                    return ps.stdout.trim().length > 0;
                },
                buildLogPath, 'blue-green');

            ProcessService.emitDeployProgress(project.id, 'switching', 'blue-green');
            const configPath = await ProcessService.switchProxy(project, hostPort, oldPort);

            project.containerId = incoming;
            project.port = hostPort;
            project.configPath = configPath;
            await projectRepo.save(project);
        } catch (err) {
            await ProcessService.removeComposeGeneration(project, incoming);
            throw err;
        }

        ProcessService.emitDeployProgress(project.id, 'retiring', 'blue-green');
        await new Promise(r => setTimeout(r, RETIRE_GRACE_MS));
        await ProcessService.removeComposeGeneration(project, oldName);
        return healthGate;
    }

    /**
     * Tier 3: stateful stack — same project name, no `down`. Compose diffs
     * and recreates only changed services, so an unchanged database is not
     * touched at all; the build happens before any recreation, so downtime is
     * limited to the changed services' restart.
     */
    private static async deployComposeInPlace(
        project: Project,
        projectRepo: ReturnType<typeof AppDataSource.getRepository<Project>>,
        buildLogPath: string,
        composeFile: string,
        injectPort?: number,
    ): Promise<void> {
        const composeName = project.containerId!;
        const oldPort = project.port!;

        ProcessService.emitDeployProgress(project.id, 'updating-services', 'compose-inplace');
        const hostPort = await ProcessService.composeUpAndWaitForPort(
            project, composeName, buildLogPath, composeFile, ['--remove-orphans'], injectPort);

        if (hostPort !== oldPort) {
            ProcessService.emitDeployProgress(project.id, 'switching', 'compose-inplace');
            const configPath = await ProcessService.switchProxy(project, hostPort, oldPort);
            project.port = hostPort;
            project.configPath = configPath;
            await projectRepo.save(project);
        }
    }

    static stop(projectId: string): Promise<void> {
        return ProcessService.withProjectLock(projectId, () => ProcessService.doStop(projectId));
    }

    private static async doStop(projectId: string): Promise<void> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({ where: { id: projectId } });

        if (!project) throw new Error('Project not found');

        const managed = managedProcesses.get(projectId);
        if (managed) {
            managed.process.kill('SIGTERM');
            managedProcesses.delete(projectId);
        }

        // Stop Docker container (or compose stack) if it exists
        if (project.containerId) {
            if (project.useCompose) {
                // Tear down the entire compose stack
                const composeFile = project.composeFile || 'docker-compose.yml';
                const envFilePath = path.join(project.directoryPath, '.runnable.env');
                await SandboxService.exec(
                    projectId, 'docker',
                    ['compose', '-p', project.containerId, '--env-file', envFilePath, '-f', composeFile, 'down', '--remove-orphans'],
                    project.directoryPath,
                );
                // Remove the generated env file
                await fs.unlink(envFilePath).catch(() => {});
            } else {
                await SandboxService.exec(projectId, 'docker', ['stop', project.containerId]);
                await SandboxService.exec(projectId, 'docker', ['rm', '-f', project.containerId]);
            }
            project.containerId = undefined;
            // Revert the port from the dynamic host port to the container port
            // so a later config regeneration doesn't proxy to a stale port
            project.port = project.internalPort || 8080;
        }

        // Sweep ALL blue-green generations, not just containerId: a crashed
        // deploy's orphan (running with --restart unless-stopped) exists
        // precisely when containerId doesn't name it — without this, stop and
        // project deletion leak it forever and pin its image.
        if (project.serverType === ServerType.APP) {
            if (project.useCompose) {
                await ProcessService.sweepComposeGenerations(project, []).catch(() => { });
            } else {
                await ProcessService.sweepContainerGenerations(project, [], false).catch(() => { });
            }
        }

        // Remove config
        if (project.configPath) {
            await ServerConfigService.removeConfig(project.configPath);
            await ServerConfigService.reloadCaddy();
        }

        project.status = ServiceStatus.STOPPED;
        await projectRepo.save(project);

        ProcessService.emitStatus(projectId, ServiceStatus.STOPPED);
    }

    /**
     * Tear down all runtime resources for a project: stop the container/compose
     * stack and delete the built Docker image. Used on project deletion so we
     * don't leak images on disk. Best-effort — never throws.
     */
    static async destroy(projectId: string): Promise<void> {
        // Stop the container/compose stack regardless of recorded status —
        // a leftover container can exist even when status isn't RUNNING
        // (e.g. ERROR or BUILDING). stop() is a no-op when nothing is running.
        await ProcessService.stop(projectId).catch(() => {});

        // Remove the railpack-built image (`runnable-img-<id8>`). Built and run
        // as the sandbox user, so this must run before the sandbox is destroyed.
        const imageName = `runnable-img-${projectId.substring(0, 8)}`;
        await SandboxService.exec(projectId, 'docker', ['rmi', '-f', imageName]).catch(() => {});
    }

    static restart(projectId: string): Promise<void> {
        return ProcessService.withProjectLock(projectId, async () => {
            await ProcessService.doStop(projectId);
            await ProcessService.doStart(projectId);
        });
    }

    /**
     * Restart used by the health monitor. Re-checks the status once inside
     * the lock: if it's no longer ERROR (user stopped the project, or a
     * redeploy got there first), the restart is skipped. Returns whether a
     * restart actually ran.
     */
    static restartIfStillError(projectId: string): Promise<boolean> {
        return ProcessService.withProjectLock(projectId, async () => {
            const projectRepo = AppDataSource.getRepository(Project);
            const project = await projectRepo.findOne({ where: { id: projectId } });
            if (!project || project.status !== ServiceStatus.ERROR) return false;
            await ProcessService.doStop(projectId);
            await ProcessService.doStart(projectId);
            return true;
        });
    }

    /**
     * Zero-downtime when eligible — APP project, toggle on, and the active
     * workload actually alive (DB status is useless here: callers set
     * DEPLOYING before calling in). Everything else takes the legacy
     * stop→start path. Emits deploy:finished either way so the UI can render
     * the outcome; Deployment rows and notifications remain caller-owned.
     */
    private static async deployOrRecreate(projectId: string): Promise<Omit<RedeployResult, 'ran'>> {
        const startedAt = Date.now();
        try {
            const projectRepo = AppDataSource.getRepository(Project);
            const project = await projectRepo.findOne({ where: { id: projectId } });
            const eligible = !!project
                && project.serverType === ServerType.APP
                && project.zeroDowntime
                && !!project.containerId
                && await ProcessService.isActiveLive(project);

            let outcome: DeployOutcome;
            if (eligible) {
                outcome = await ProcessService.doDeploy(projectId);
            } else {
                await ProcessService.doStop(projectId);
                await ProcessService.doStart(projectId);
                outcome = { strategy: 'recreate', healthGate: 'passed' };
            }
            const durationMs = Date.now() - startedAt;
            ProcessService.emitDeployFinished(projectId, {
                outcome: 'success', strategy: outcome.strategy, durationMs, healthGate: outcome.healthGate,
            });
            return { ...outcome, durationMs };
        } catch (err: any) {
            const stillServing = err instanceof DeployError && err.stillServing;
            ProcessService.emitDeployFinished(projectId, {
                outcome: stillServing ? 'failed-still-serving' : 'failed-down',
                strategy: err instanceof DeployError ? err.strategy : 'recreate',
                durationMs: Date.now() - startedAt,
            });
            throw err;
        }
    }

    /**
     * Pull-and-redeploy as one serialized unit. `prepare` (e.g. git pull) runs
     * inside the project lock so it cannot mutate the working tree while an
     * in-flight build is copying it. Bursts coalesce: if a redeploy is already
     * queued behind a running one, new requests are dropped — the queued run
     * pulls the latest code anyway. Returns { ran: false } when the request
     * was dropped, so callers don't record a deployment that never ran.
     */
    static redeploy(projectId: string, prepare: () => Promise<void>): Promise<RedeployResult> {
        if (ProcessService.queuedRedeploys.has(projectId)) return Promise.resolve({ ran: false });
        ProcessService.queuedRedeploys.add(projectId);
        return ProcessService.withProjectLock(projectId, async () => {
            ProcessService.queuedRedeploys.delete(projectId);
            await prepare();
            const result = await ProcessService.deployOrRecreate(projectId);
            return { ran: true, ...result };
        });
    }

    /**
     * Like redeploy(), but never coalesced. Used for rollbacks, where dropping
     * the request would leave the project on the wrong commit.
     */
    static redeployExclusive(projectId: string, prepare: () => Promise<void>): Promise<RedeployResult> {
        return ProcessService.withProjectLock(projectId, async () => {
            await prepare();
            const result = await ProcessService.deployOrRecreate(projectId);
            return { ran: true, ...result };
        });
    }

    static async getStatus(projectId: string): Promise<ServiceStatus> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({ where: { id: projectId } });
        return project?.status || ServiceStatus.STOPPED;
    }

    static async getLogs(projectId: string, lines: number = 100): Promise<string[]> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({ where: { id: projectId } });
        if (!project) return [];

        if (project.serverType === ServerType.APP) {
            if (project.containerId) {
                try {
                    let logs: string;
                    if (project.useCompose) {
                        // For compose projects, containerId holds the compose project name
                        const composeFile = project.composeFile || 'docker-compose.yml';
                        const envFilePath = path.join(project.directoryPath, '.runnable.env');
                        // Pass --env-file when present so compose doesn't warn about
                        // unset ${VAR} interpolations while parsing the YAML.
                        const envFileArgs: string[] = [];
                        try {
                            await fs.access(envFilePath);
                            envFileArgs.push('--env-file', envFilePath);
                        } catch { /* env file not yet written, skip */ }
                        const args = ['compose', '-p', project.containerId, ...envFileArgs, '-f', composeFile,
                            'logs', '--tail', String(lines), '--no-color'];
                        // Optionally scope to the primary service only
                        if (project.composeService) args.push(project.composeService);
                        const { stdout, stderr } = await SandboxService.exec(
                            project.id, 'docker', args, project.directoryPath);
                        logs = stdout || stderr;
                    } else {
                        const { stdout, stderr } = await SandboxService.exec(
                            project.id, 'docker', ['logs', '--tail', String(lines), project.containerId]);
                        logs = stdout || stderr;
                    }
                    if (logs) return logs.split('\n').filter(Boolean);
                } catch {
                    // Fallback to build logs if docker logs fail
                }
            }

            // Try to read build logs as fallback
            const storageDir = path.resolve(config.hosting.servDir, '..');
            const buildLogPath = path.join(storageDir, 'logs', `${project.subdomain}-build.log`);
            try {
                const content = await fs.readFile(buildLogPath, 'utf-8');
                return content.split('\n').slice(-lines);
            } catch {
                return ['No logs available (check if project build started)'];
            }
        }

        const logPath = `/var/log/caddy/${project.subdomain}.log`;
        try {
            const content = await fs.readFile(logPath, 'utf-8');
            const allLines = content.split('\n');
            return allLines.slice(-lines);
        } catch {
            return ['No logs available'];
        }
    }

    /**
     * List the Docker containers belonging to a project.
     * For compose projects this returns every service container in the stack;
     * for single-container (Railpack/Dockerfile) projects it returns the one
     * container. Returns [] for non-APP projects or when nothing is running.
     */
    static async listContainers(projectId: string): Promise<Array<{
        id: string;
        name: string;
        service: string;
        state: string;
        status: string;
        ports: string;
    }>> {
        const projectRepo = AppDataSource.getRepository(Project);
        const project = await projectRepo.findOne({ where: { id: projectId } });
        if (!project || project.serverType !== ServerType.APP || !project.containerId) {
            return [];
        }

        const base = `runnable-${project.id.substring(0, 8)}`;
        try {
            if (project.useCompose) {
                const composeFile = project.composeFile || 'docker-compose.yml';
                const envFilePath = path.join(project.directoryPath, '.runnable.env');
                const envFileArgs: string[] = [];
                try {
                    await fs.access(envFilePath);
                    envFileArgs.push('--env-file', envFilePath);
                } catch { /* env file not yet written */ }

                // Query every generation project name so the incoming stack of
                // an in-flight blue-green deploy is visible (e.g. its startup
                // logs). Generations not present return no rows.
                const names = new Set(composeGenerations(base));
                names.add(project.containerId);
                const all: Array<any> = [];
                for (const name of names) {
                    const { stdout } = await SandboxService.exec(
                        project.id, 'docker',
                        ['compose', '-p', name, ...envFileArgs, '-f', composeFile,
                            'ps', '-a', '--format', 'json'],
                        project.directoryPath,
                    );
                    all.push(...ProcessService.parseComposePs(stdout));
                }
                return all;
            }

            // Match the active container and any blue/green generation
            const { stdout } = await SandboxService.exec(
                project.id, 'docker',
                ['ps', '-a', '--filter', `name=^${base}(-blue|-green)?$`, '--format', 'json'],
            );
            return ProcessService.parseDockerPs(stdout);
        } catch {
            return [];
        }
    }

    private static parseComposePs(stdout: string): Array<any> {
        const trimmed = stdout.trim();
        if (!trimmed) return [];
        // Newer docker compose emits one JSON object per line; older emits a JSON array.
        let rows: any[];
        try {
            const parsed = JSON.parse(trimmed);
            rows = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
            rows = trimmed.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        }
        return rows.map(r => ({
            id: r.ID || r.Id || '',
            name: r.Name || '',
            service: r.Service || '',
            state: r.State || '',
            status: r.Status || '',
            ports: Array.isArray(r.Publishers)
                ? r.Publishers
                    .filter((p: any) => p.PublishedPort)
                    .map((p: any) => `${p.PublishedPort}:${p.TargetPort}`)
                    .join(', ')
                : (r.Ports || ''),
        }));
    }

    private static parseDockerPs(stdout: string): Array<any> {
        const trimmed = stdout.trim();
        if (!trimmed) return [];
        return trimmed.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
            try {
                const r = JSON.parse(l);
                return {
                    id: r.ID || '',
                    name: r.Names || '',
                    service: r.Names || '',
                    state: r.State || '',
                    status: r.Status || '',
                    ports: r.Ports || '',
                };
            } catch { return null; }
        }).filter(Boolean) as any[];
    }

    /**
     * Logs for a single container within a project. The container name is
     * validated against the project's own container list so a caller cannot
     * read logs of containers that don't belong to this project.
     */
    static async getContainerLogs(
        projectId: string,
        containerName: string,
        lines: number = 200,
    ): Promise<string[]> {
        const containers = await ProcessService.listContainers(projectId);
        const match = containers.find(c => c.name === containerName);
        if (!match) {
            return [`Container "${containerName}" does not belong to this project`];
        }

        const { stdout, stderr } = await SandboxService.exec(
            projectId, 'docker',
            ['logs', '--tail', String(lines), '--timestamps', match.name],
        );
        const logs = stdout || stderr;
        return logs ? logs.split('\n').filter(Boolean) : ['No logs available'];
    }

    /**
     * Emit a status update to clients subscribed to this project's room.
     * Public so the health monitor can surface crash detections live.
     */
    static emitStatus(projectId: string, status: ServiceStatus) {
        if (ProcessService.io) {
            ProcessService.io.to(`project:${projectId}`).emit('service:status', { projectId, status });
        }
    }
}
