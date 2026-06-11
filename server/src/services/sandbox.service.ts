import { exec, execFile, spawn, ChildProcess } from 'child_process';
import fsSync from 'fs';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

const ALLOWED_COMMANDS = ['git', 'caddy', 'nginx', 'apache2', 'apachectl', 'systemctl', 'ls', 'mkdir', 'rm', 'cp', 'railpack', 'docker', 'sh', 'npm', 'npx'];

// Orchestration tools that talk to the Docker daemon. These run with the
// server's own (root) identity, never as the per-project sandbox user — giving
// the sandbox user docker access is root-equivalent and would let a project's
// build scripts or runtime escape the sandbox. The user's own code only runs
// inside the resulting container (or buildkit during build), never with this
// daemon access.
const ROOT_COMMANDS = ['docker', 'railpack'];

export class SandboxService {
    static async exec(projectId: string, command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
        // Validate command against allowlist
        const baseCommand = path.basename(command);
        if (!ALLOWED_COMMANDS.includes(baseCommand)) {
            throw new Error(`Command not allowed: ${baseCommand}`);
        }

        return new Promise((resolve) => {
            const processEnv = { ...process.env, ...env };
            let child: ChildProcess;

            // Docker/railpack run as the server (root); everything else drops
            // to the unprivileged per-project sandbox user.
            if (config.sandbox.enabled && !ROOT_COMMANDS.includes(baseCommand)) {
                const sandboxUser = `${config.sandbox.userPrefix}${projectId.substring(0, 8)}`;
                const envArgs = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);
                child = spawn('sudo', ['-n', '-u', sandboxUser,
                    'env', `PATH=${processEnv.PATH || '/usr/local/bin:/usr/bin:/bin'}`, ...envArgs,
                    command, ...args], { cwd, env: processEnv });
            } else {
                child = spawn(command, args, { cwd, env: processEnv });
            }

            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (exitCode) => {
                resolve({
                    stdout,
                    stderr,
                    exitCode: exitCode || 0
                });
            });

            child.on('error', (error: any) => {
                resolve({
                    stdout,
                    stderr: error.message,
                    exitCode: error.code || 1
                });
            });
        });
    }

    static async spawn(projectId: string, command: string, args: string[], logPath: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<number> {
        const baseCommand = path.basename(command);
        if (!ALLOWED_COMMANDS.includes(baseCommand)) {
            throw new Error(`Command not allowed: ${baseCommand}`);
        }

        const logStream = fsSync.createWriteStream(logPath, { flags: 'a' });

        return new Promise((resolve, reject) => {
            const processEnv = { ...process.env, ...env };
            const envArgs = Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);
            // Docker/railpack run as the server (root); everything else drops
            // to the unprivileged per-project sandbox user.
            const child = (config.sandbox.enabled && !ROOT_COMMANDS.includes(baseCommand))
                ? spawn('sudo', ['-n', '-u', `${config.sandbox.userPrefix}${projectId.substring(0, 8)}`,
                    'env', `PATH=${processEnv.PATH || '/usr/local/bin:/usr/bin:/bin'}`, ...envArgs,
                    command, ...args], { cwd, env: processEnv })
                : spawn(command, args, { cwd, env: processEnv });

            child.stdout?.on('data', (data) => logStream.write(data));
            child.stderr?.on('data', (data) => logStream.write(data));

            child.on('close', (code) => {
                logStream.end();
                resolve(code || 0);
            });

            child.on('error', (err) => {
                logStream.end();
                reject(err);
            });
        });
    }

    static async createSandbox(projectId: string, directoryPath: string): Promise<void> {
        if (!config.sandbox.enabled) {
            await fs.mkdir(directoryPath, { recursive: true });
            return;
        }

        const sandboxUser = `${config.sandbox.userPrefix}${projectId.substring(0, 8)}`;

        try {
            // Create dedicated user (using execFile — no shell, no injection).
            // Deliberately NOT in the docker group: docker-socket access is
            // root-equivalent. The server (root) issues all docker/railpack
            // commands on the project's behalf; the sandbox user never touches
            // the daemon directly.
            await execFileAsync('sudo', ['-n', 'useradd', '-r', '-M', '-d', directoryPath, '-s', '/usr/sbin/nologin', sandboxUser]);

            // Create directory with proper ownership
            await fs.mkdir(directoryPath, { recursive: true });
            await execFileAsync('sudo', ['-n', 'chown', `${sandboxUser}:${sandboxUser}`, directoryPath]);
            await execFileAsync('sudo', ['-n', 'chmod', '755', directoryPath]);

            // Set resource limits via cgroups (if available)
            try {
                const cgroupDir = `/sys/fs/cgroup/runnable/${sandboxUser}`;
                await execFileAsync('sudo', ['-n', 'mkdir', '-p', cgroupDir]);
                await execFileAsync('sudo', ['-n', 'sh', '-c', `echo 512M > ${cgroupDir}/memory.max`]);
                await execFileAsync('sudo', ['-n', 'sh', '-c', `echo "100000 100000" > ${cgroupDir}/cpu.max`]);
            } catch {
                console.warn(`Could not set cgroup limits for ${sandboxUser}`);
            }
        } catch (error: any) {
            console.error(`Failed to create sandbox for ${projectId}:`, error.message);
            // Fallback: just create the directory
            await fs.mkdir(directoryPath, { recursive: true });
        }
    }

    /**
     * One-time remediation: strip the `docker` group from any existing sandbox
     * users left over from before docker access was moved to the server. New
     * users are no longer added to the group; this catches already-provisioned
     * installs on restart. Best-effort — never throws.
     */
    static async reconcileDockerGroup(): Promise<void> {
        if (!config.sandbox.enabled) return;
        try {
            const { stdout } = await execFileAsync('getent', ['group', 'docker']);
            // Format: docker:x:999:member1,member2,...
            const members = (stdout.split(':')[3] || '').trim();
            if (!members) return;
            const sandboxMembers = members.split(',')
                .map(m => m.trim())
                .filter(m => m.startsWith(config.sandbox.userPrefix));
            for (const user of sandboxMembers) {
                await execFileAsync('sudo', ['-n', 'gpasswd', '-d', user, 'docker']).catch(() => { });
            }
            if (sandboxMembers.length > 0) {
                console.log(`🔒 Removed ${sandboxMembers.length} sandbox user(s) from the docker group`);
            }
        } catch {
            // getent/gpasswd unavailable or no docker group — nothing to do
        }
    }

    static async destroySandbox(projectId: string): Promise<void> {
        if (!config.sandbox.enabled) return;

        const sandboxUser = `${config.sandbox.userPrefix}${projectId.substring(0, 8)}`;

        try {
            // Kill any processes by this user (using execFile — no shell)
            await execFileAsync('sudo', ['-n', 'pkill', '-u', sandboxUser]).catch(() => { });
            // Remove user
            await execFileAsync('sudo', ['-n', 'userdel', sandboxUser]).catch(() => { });
            // Remove cgroup
            await execFileAsync('sudo', ['-n', 'rmdir', `/sys/fs/cgroup/runnable/${sandboxUser}`]).catch(() => { });
        } catch (error: any) {
            console.error(`Failed to destroy sandbox for ${projectId}:`, error.message);
        }
    }
}

