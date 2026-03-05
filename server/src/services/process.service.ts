import { ChildProcess, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { AppDataSource } from '../config/data-source';
import { Project, ServiceStatus, ServerType } from '../entities';
import { SandboxService } from './sandbox.service';
import { ServerConfigService } from './serverConfig.service';
import { DetectService } from './detect.service';

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

    static async start(projectId: string): Promise<void> {
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

                    // Bring down any previous compose stack for this project
                    await SandboxService.exec(
                        projectId, 'docker',
                        ['compose', '-p', composeName, '-f', composeFile, 'down', '--remove-orphans'],
                        project.directoryPath,
                    );

                    // Compose up with build
                    await fs.appendFile(buildLogPath, '\n--- Docker Compose Up (streaming) ---\n');
                    const composeExitCode = await SandboxService.spawn(
                        projectId, 'docker',
                        ['compose', '-p', composeName, '-f', composeFile, 'up', '--build', '-d'],
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
                            ['compose', '-p', composeName, '-f', composeFile, 'port', composeService, String(internalPort)],
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
                            ['compose', '-p', composeName, '-f', composeFile, 'ps'],
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
                    project.containerId = composeName;
                    project.internalPort = internalPort;
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
                    const userEnv = typeof project.envVars === 'string' ? JSON.parse(project.envVars) : (project.envVars || {});
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

                    // Save container information to database
                    project.containerId = containerName;
                    project.internalPort = internalPort;
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

    static async stop(projectId: string): Promise<void> {
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
                await SandboxService.exec(
                    projectId, 'docker',
                    ['compose', '-p', project.containerId, '-f', composeFile, 'down', '--remove-orphans'],
                    project.directoryPath,
                );
            } else {
                await SandboxService.exec(projectId, 'docker', ['stop', project.containerId]);
                await SandboxService.exec(projectId, 'docker', ['rm', '-f', project.containerId]);
            }
            project.containerId = undefined;
            // Revert the port to internalPort
            if (project.internalPort) {
                project.port = project.internalPort;
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

    static async restart(projectId: string): Promise<void> {
        await ProcessService.stop(projectId);
        await ProcessService.start(projectId);
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
                        const args = ['compose', '-p', project.containerId, '-f', composeFile,
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

    private static emitStatus(projectId: string, status: ServiceStatus) {
        if (ProcessService.io) {
            ProcessService.io.emit('service:status', { projectId, status });
        }
    }
}
