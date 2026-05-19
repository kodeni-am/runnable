import { Router, NextFunction } from 'express';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { authenticate, requireRole } from '../middleware/auth';
import { Role } from '../entities';
import { config } from '../config';

const execAsync = promisify(exec);

const router = Router();

// Server stats are sensitive — admin only
router.use(authenticate, requireRole(Role.ADMIN));

function cpuSnapshot() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
        for (const t of Object.values(cpu.times)) total += t;
        idle += cpu.times.idle;
    }
    return { idle, total };
}

// Sample CPU times over a window to derive utilisation %.
// A wider window gives a steadier reading when the client polls frequently.
async function getCpuUsage(): Promise<number> {
    const start = cpuSnapshot();
    await new Promise((r) => setTimeout(r, 500));
    const end = cpuSnapshot();
    const idleDelta = end.idle - start.idle;
    const totalDelta = end.total - start.total;
    if (totalDelta <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

type DiskInfo = { total: number; used: number; free: number; usedPercent: number; mount: string };

// Disk usage barely moves and `df` spawns a child process, so cache it.
// This decouples the cheap CPU/memory poll from the expensive disk poll
// regardless of how fast (or how many) clients hit the endpoint.
const DISK_TTL_MS = 20_000;
let diskCache: { value: DiskInfo; at: number } | null = null;

// Parse `df -kP <path>` -> bytes used/total for the filesystem holding the data dir
async function getDisk(path: string): Promise<DiskInfo> {
    if (diskCache && Date.now() - diskCache.at < DISK_TTL_MS) {
        return diskCache.value;
    }
    try {
        const { stdout } = await execAsync(`df -kP "${path}"`);
        const line = stdout.trim().split('\n')[1] || '';
        const cols = line.split(/\s+/);
        // Filesystem 1024-blocks Used Available Capacity Mounted-on
        const totalKb = parseInt(cols[1], 10) || 0;
        const usedKb = parseInt(cols[2], 10) || 0;
        const total = totalKb * 1024;
        const used = usedKb * 1024;
        const value: DiskInfo = {
            total,
            used,
            free: total - used,
            usedPercent: total > 0 ? (used / total) * 100 : 0,
            mount: cols[5] || path,
        };
        diskCache = { value, at: Date.now() };
        return value;
    } catch {
        // Serve a stale reading if we have one rather than zeros
        if (diskCache) return diskCache.value;
        return { total: 0, used: 0, free: 0, usedPercent: 0, mount: path };
    }
}

router.get('/stats', async (_req, res, next: NextFunction) => {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        const [cpuPercent, disk] = await Promise.all([
            getCpuUsage(),
            getDisk(config.hosting.servDir),
        ]);

        res.json({
            hostname: os.hostname(),
            platform: `${os.type()} ${os.release()}`,
            uptimeSeconds: os.uptime(),
            cpu: {
                usedPercent: cpuPercent,
                cores: os.cpus().length,
                model: os.cpus()[0]?.model?.trim() || 'unknown',
                loadAvg: os.loadavg(),
            },
            memory: {
                total: totalMem,
                used: usedMem,
                free: freeMem,
                usedPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
            },
            disk,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        next(error);
    }
});

export default router;
