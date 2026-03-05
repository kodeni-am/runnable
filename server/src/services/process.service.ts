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
                // Always use internalPort (container-side). project.port gets overwritten
                // with the dynamic host port after each run and must NOT be used here.
                // internalPort is guaranteed to be set at project creation from now on;
                // fall back to 8080 for legacy projects where it is null.
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
                // Railpack auto-detects the start command (e.g. from package.json scripts.start)
                // and bakes it into the image — we should NOT override that with our
                // auto-detected default since Railpack runs inside the correct environment.
                if (project.startCommand) {
                    // Railpack sets entrypoint to ["/bin/bash", "-c"], so we must use
                    // --entrypoint to override it and pass the command as CMD args.
                    const imageIdx = runArgs.indexOf(imageName);
                    runArgs.splice(imageIdx, 0, '--entrypoint', 'sh');
                    runArgs.push('-c', project.startCommand);
                }

                const runResult = await SandboxService.exec(projectId, 'docker', runArgs);
                await logAndCheck(runResult, 'Docker Run');

                // 4. Inspect the dynamic host port
                const portResult = await SandboxService.exec(projectId, 'docker', ['port', containerName, String(internalPort)]);
                await logAndCheck(portResult, 'Docker Port Inspect');

                const match = portResult.stdout.match(/:(\d+)/);
                if (!match) {
                    throw new Error('Could not determine dynamic host port for Docker container');
                }

                actualPort = parseInt(match[1], 10);

                // Save container information to database
                project.containerId = containerName;
                project.internalPort = internalPort;
                project.port = actualPort; // update the proxied port for ServerConfigService
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

        // Stop Docker container if it exists
        if (project.containerId) {
            await SandboxService.exec(projectId, 'docker', ['stop', project.containerId]);
            await SandboxService.exec(projectId, 'docker', ['rm', '-f', project.containerId]);
            project.containerId = undefined;
            // Optionally revert the port to internalPort
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
                    const { stdout, stderr } = await SandboxService.exec(project.id, 'docker', ['logs', '--tail', String(lines), project.containerId]);
                    const logs = stdout || stderr;
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
