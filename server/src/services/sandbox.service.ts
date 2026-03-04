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

            if (config.sandbox.enabled) {
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
            const child = config.sandbox.enabled
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
            // Create dedicated user (using execFile — no shell, no injection)
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

