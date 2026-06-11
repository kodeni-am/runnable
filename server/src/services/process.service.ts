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
import { parse as parseYaml } from 'yaml';

interface ManagedProcess {
    process: ChildProcess;
    projectId: string;
    logFile: string;
}

const managedProcesses = new Map<string, ManagedProcess>();

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

                const imageName = `runnable-img-${projectId.substring(0, 8)}`;
                const containerName = `runnable-${projectId.substring(0, 8)}`;
                const storageDir = path.resolve(config.hosting.servDir, '..');
                const buildLogPath = path.join(storageDir, 'logs', `${project.subdomain}-build.log`);

                // Ensure logs directory exists
                await fs.mkdir(path.dirname(buildLogPath), { recursive: true });

                const logAndCheck = async (result: any, step: string) => {
                    const logContent = `\n--- ${step} ---\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\nEXIT CODE: ${result.exitCode}\n\n`;
                    await fs.appendFile(buildLogPath, logContent);
                    if (result.exitCode !== 0) {
                        throw new Error(`${step} failed with exit code ${result.exitCode}. See logs for details.`);
                    }
                };

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
                const effectiveStartCommand = project.startCommand || detection.startCommand;

                // Parse project env vars — needed by both compose and Railpack paths
                const userEnv = typeof project.envVars === 'string'
                    ? JSON.parse(project.envVars)
                    : (project.envVars || {});

                // Determine whether to use docker compose or the Railpack single-container path
                const useCompose = project.useCompose || detection.useCompose;
                const composeFile = project.composeFile || detection.composeFile || 'docker-compose.yml';
                const composeService = project.composeService;

                if (useCompose) {
                    // ── DOCKER COMPOSE DEPLOYMENT PATH ──────────────────────────────────
                    if (!composeService) {
                        throw new Error(
                            'Compose deployment requires a "Primary Service" name. ' +
                            'Go to the project Settings tab and set the "Primary Service" field ' +
                            'to the name of the compose service that exposes the HTTP port.'
                        );
                    }

                    const composeName = `runnable-${projectId.substring(0, 8)}`;
                    await fs.appendFile(buildLogPath, `\nUsing docker compose (file: ${composeFile}, service: ${composeService}, project: ${composeName})\n`);

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

                    // Base compose args — reused across all commands
                    const composeBase = ['compose', '-p', composeName, '--env-file', envFilePath, '-f', composeFile];

                    // Screen the stack for host-escape directives BEFORE running
                    // it. Validate the output of `docker compose config` rather
                    // than the raw file: config applies ${VAR} interpolation
                    // (from the user-controlled env file), resolves YAML merge
                    // keys/anchors and `extends`, and normalizes volumes to long
                    // form — so the validated structure matches exactly what
                    // `up` will run. Enforced here (not at config-save) because
                    // the file is user-editable in the file browser until deploy.
                    const configResult = await SandboxService.exec(
                        projectId, 'docker',
                        [...composeBase, 'config'],
                        project.directoryPath,
                    );
                    if (configResult.exitCode !== 0) {
                        await fs.appendFile(buildLogPath, `\n❌ Invalid compose file:\n${configResult.stderr}\n`);
                        throw new Error(`Invalid compose file: ${configResult.stderr.trim() || 'docker compose config failed'}`);
                    }
                    try {
                        ComposePolicyService.validate(parseYaml(configResult.stdout));
                    } catch (err: any) {
                        await fs.appendFile(buildLogPath, `\n❌ Compose rejected by security policy: ${err.message}\n`);
                        throw new Error(`Compose file rejected: ${err.message}`);
                    }

                    // Bring down any previous compose stack for this project
                    await SandboxService.exec(
                        projectId, 'docker',
                        [...composeBase, 'down', '--remove-orphans'],
                        project.directoryPath,
                    );

                    // Compose up with build
                    await fs.appendFile(buildLogPath, '\n--- Docker Compose Up (streaming) ---\n');
                    const composeExitCode = await SandboxService.spawn(
                        projectId, 'docker',
                        [...composeBase, 'up', '--build', '-d'],
                        buildLogPath,
                        project.directoryPath,
                    );

                    if (composeExitCode !== 0) {
                        throw new Error(`docker compose up failed with exit code ${composeExitCode}. See build logs for details.`);
                    }

                    // Discover the host port published by the primary service
                    const internalPort = project.internalPort || 8080;
                    let actualHostPort: number | null = null;

                    for (let attempt = 0; attempt < 15; attempt++) {
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        const portResult = await SandboxService.exec(
                            projectId, 'docker',
                            [...composeBase, 'port', composeService, String(internalPort)],
                            project.directoryPath,
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
                            projectId, 'docker',
                            [...composeBase, 'ps'],
                            project.directoryPath,
                        );
                        await fs.appendFile(buildLogPath, `--- Compose PS ---\n${psResult.stdout}\n`);
                        throw new Error(
                            `Could not determine host port for compose service "${composeService}" ` +
                            `(internal: ${internalPort}) after 15s. ` +
                            `Make sure the service exposes port ${internalPort} in the compose file.`
                        );
                    }

                    actualPort = actualHostPort;
                    // Store the compose project name in containerId so stop/logs can reference it
                    // Also persist the env file path so stop() can clean it up
                    project.containerId = composeName;
                    project.port = actualPort;

                } else {
                    // ── RAILPACK / DOCKERFILE DEPLOYMENT PATH ───────────────────────────

                    // Ensure BuildKit is running (required for railpack)
                    const buildkitCheck = await SandboxService.exec(projectId, 'docker', ['ps', '-a', '--filter', 'name=runnable-buildkit', '--format', '{{.Status}}']);
                    if (!buildkitCheck.stdout.includes('Up')) {
                        await fs.appendFile(buildLogPath, "Starting BuildKit daemon...\n");
                        // Remove if exists but not running
                        await SandboxService.exec(projectId, 'docker', ['rm', '-f', 'runnable-buildkit']);
                        const bkResult = await SandboxService.exec(projectId, 'docker', [
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

                    // 0. Run build command (user-provided or auto-detected)
                    if (effectiveBuildCommand) {
                        await fs.appendFile(buildLogPath, `\n--- Build Command: ${effectiveBuildCommand} ---\n`);
                        const buildEnv = { ...buildkitEnv, ...userEnv };
                        const buildResult = await SandboxService.exec(projectId, 'sh', ['-c', effectiveBuildCommand], project.directoryPath, buildEnv);
                        await logAndCheck(buildResult, 'Build');
                    }

                    // 1. Build image using railpack (Streaming)
                    await fs.appendFile(buildLogPath, "\n--- Railpack Build (Streaming) ---\n");
                    const buildExitCode = await SandboxService.spawn(projectId, 'railpack', ['build', '.', '--name', imageName], buildLogPath, project.directoryPath, buildkitEnv);

                    if (buildExitCode !== 0) {
                        throw new Error(`Railpack build failed with exit code ${buildExitCode}. See logs for details.`);
                    }

                    // 2. Kill existing container if any
                    await SandboxService.exec(projectId, 'docker', ['rm', '-f', containerName]);

                    // 3. Run container and map internal port to random host port
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

                    const runResult = await SandboxService.exec(projectId, 'docker', runArgs);
                    await logAndCheck(runResult, 'Docker Run');

                    // 4. Wait for the container to be running, then inspect the dynamic host port.
                    let actualHostPort: number | null = null;
                    for (let attempt = 0; attempt < 10; attempt++) {
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        const stateResult = await SandboxService.exec(projectId, 'docker', [
                            'inspect', '--format', '{{.State.Status}}', containerName,
                        ]);
                        const state = stateResult.stdout.trim();
                        await fs.appendFile(buildLogPath, `[Port wait] attempt ${attempt + 1}: container state = ${state}\n`);

                        if (state === 'exited' || state === 'dead') {
                            const crashLogs = await SandboxService.exec(projectId, 'docker', ['logs', '--tail', '50', containerName]);
                            await fs.appendFile(buildLogPath, `--- Container Crash Logs ---\n${crashLogs.stdout}\n${crashLogs.stderr}\n`);
                            throw new Error(
                                `Container exited immediately (state: ${state}). Check start command and container logs.\n${crashLogs.stderr || crashLogs.stdout}`
                            );
                        }

                        if (state === 'running') {
                            const portResult = await SandboxService.exec(projectId, 'docker', ['port', containerName, String(internalPort)]);
                            await fs.appendFile(buildLogPath, `--- Docker Port Inspect ---\nSTDOUT:\n${portResult.stdout}\nSTDERR:\n${portResult.stderr}\nEXIT CODE: ${portResult.exitCode}\n`);
                            const match = portResult.stdout.match(/:(\d+)/);
                            if (match) {
                                actualHostPort = parseInt(match[1], 10);
                                break;
                            }
                        }
                    }

                    if (!actualHostPort) {
                        const stateResult = await SandboxService.exec(projectId, 'docker', [
                            'inspect', '--format', '{{.State.Status}}', containerName,
                        ]);
                        throw new Error(
                            `Could not determine dynamic host port for Docker container after 10s. Container state: ${stateResult.stdout.trim()}`
                        );
                    }

                    actualPort = actualHostPort;

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
     * Pull-and-restart as one serialized unit. `prepare` (e.g. git pull) runs
     * inside the project lock so it cannot mutate the working tree while an
     * in-flight build is copying it. Bursts coalesce: if a redeploy is already
     * queued behind a running one, new requests are dropped — the queued run
     * pulls the latest code anyway. Returns false when the request was
     * dropped, so callers don't record a deployment that never ran.
     */
    static redeploy(projectId: string, prepare: () => Promise<void>): Promise<boolean> {
        if (ProcessService.queuedRedeploys.has(projectId)) return Promise.resolve(false);
        ProcessService.queuedRedeploys.add(projectId);
        return ProcessService.withProjectLock(projectId, async () => {
            ProcessService.queuedRedeploys.delete(projectId);
            await prepare();
            await ProcessService.doStop(projectId);
            await ProcessService.doStart(projectId);
            return true;
        });
    }

    /**
     * Like redeploy(), but never coalesced. Used for rollbacks, where dropping
     * the request would leave the project on the wrong commit.
     */
    static redeployExclusive(projectId: string, prepare: () => Promise<void>): Promise<void> {
        return ProcessService.withProjectLock(projectId, async () => {
            await prepare();
            await ProcessService.doStop(projectId);
            await ProcessService.doStart(projectId);
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

        try {
            if (project.useCompose) {
                const composeFile = project.composeFile || 'docker-compose.yml';
                const envFilePath = path.join(project.directoryPath, '.runnable.env');
                const envFileArgs: string[] = [];
                try {
                    await fs.access(envFilePath);
                    envFileArgs.push('--env-file', envFilePath);
                } catch { /* env file not yet written */ }

                const { stdout } = await SandboxService.exec(
                    project.id, 'docker',
                    ['compose', '-p', project.containerId, ...envFileArgs, '-f', composeFile,
                        'ps', '-a', '--format', 'json'],
                    project.directoryPath,
                );
                return ProcessService.parseComposePs(stdout);
            }

            const { stdout } = await SandboxService.exec(
                project.id, 'docker',
                ['ps', '-a', '--filter', `name=^${project.containerId}$`, '--format', 'json'],
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
