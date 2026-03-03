import { exec, spawn, ChildProcess } from 'child_process';
import fsSync from 'fs';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config';

const execAsync = promisify(exec);

interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

const ALLOWED_COMMANDS = ['git', 'caddy', 'nginx', 'apache2', 'apachectl', 'systemctl', 'ls', 'mkdir', 'rm', 'cp', 'railpack', 'docker'];

export class SandboxService {
    static async exec(projectId: string, command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<ExecResult> {
        // Validate command against allowlist
        const baseCommand = path.basename(command);
        if (!ALLOWED_COMMANDS.includes(baseCommand)) {
            throw new Error(`Command not allowed: ${baseCommand}`);
        }

        // Sanitize args - no shell injection
        const sanitizedArgs = args.map(arg => arg.replace(/[;&|`$]/g, ''));

        try {
            if (config.sandbox.enabled) {
                // Run as sandboxed user
                const sandboxUser = `${config.sandbox.userPrefix}${projectId.substring(0, 8)}`;
                const { stdout, stderr } = await execAsync(
                    `sudo -n -u ${sandboxUser} ${command} ${sanitizedArgs.join(' ')}`,
                    { cwd, timeout: 600000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, ...env } }
                );
                return { stdout, stderr, exitCode: 0 };
            } else {
                const { stdout, stderr } = await execAsync(
                    `${command} ${sanitizedArgs.join(' ')}`,
                    { cwd, timeout: 600000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, ...env } }
                );
                return { stdout, stderr, exitCode: 0 };
            }
        } catch (error: any) {
            return {
                stdout: error.stdout || '',
                stderr: error.stderr || error.message,
                exitCode: error.code || 1,
            };
        }
    }

    static async spawn(projectId: string, command: string, args: string[], logPath: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<number> {
        const baseCommand = path.basename(command);
        if (!ALLOWED_COMMANDS.includes(baseCommand)) {
            throw new Error(`Command not allowed: ${baseCommand}`);
        }

        const sanitizedArgs = args.map(arg => arg.replace(/[;&|`$]/g, ''));
        const logStream = fsSync.createWriteStream(logPath, { flags: 'a' });

        return new Promise((resolve, reject) => {
            const child = config.sandbox.enabled
                ? spawn('sudo', ['-n', '-u', `${config.sandbox.userPrefix}${projectId.substring(0, 8)}`, command, ...sanitizedArgs], { cwd, env: { ...process.env, ...env } })
                : spawn(command, sanitizedArgs, { cwd, env: { ...process.env, ...env } });

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
            // Create dedicated user
            await execAsync(`sudo -n useradd -r -M -d ${directoryPath} -s /usr/sbin/nologin ${sandboxUser}`);

            // Create directory with proper ownership
            await fs.mkdir(directoryPath, { recursive: true });
            await execAsync(`sudo -n chown ${sandboxUser}:${sandboxUser} ${directoryPath}`);
            await execAsync(`sudo -n chmod 750 ${directoryPath}`);

            // Set resource limits via cgroups (if available)
            try {
                const cgroupDir = `/sys/fs/cgroup/runnable/${sandboxUser}`;
                await execAsync(`sudo -n mkdir -p ${cgroupDir}`);
                await execAsync(`echo '512M' | sudo -n tee ${cgroupDir}/memory.max`);
                await execAsync(`echo '100000 100000' | sudo -n tee ${cgroupDir}/cpu.max`);
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
            // Kill any processes by this user
            await execAsync(`sudo -n pkill -u ${sandboxUser}`).catch(() => { });
            // Remove user
            await execAsync(`sudo -n userdel ${sandboxUser}`).catch(() => { });
            // Remove cgroup
            await execAsync(`sudo -n rmdir /sys/fs/cgroup/runnable/${sandboxUser}`).catch(() => { });
        } catch (error: any) {
            console.error(`Failed to destroy sandbox for ${projectId}:`, error.message);
        }
    }
}
