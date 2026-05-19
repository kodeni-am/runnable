import { Router, NextFunction } from 'express';
import os from 'os';
import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { promisify } from 'util';
import { authenticate, requireRole } from '../middleware/auth';
import { Role } from '../entities';
import { config } from '../config';

const execAsync = promisify(exec);

const router = Router();

// Server stats are sensitive — admin only
router.use(authenticate, requireRole(Role.ADMIN));

function perCoreSnapshot() {
    return os.cpus().map((cpu) => {
        let total = 0;
        for (const t of Object.values(cpu.times)) total += t;
        return { idle: cpu.times.idle, total };
    });
}

function busyPercent(idleDelta: number, totalDelta: number): number {
    if (totalDelta <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

// Sample CPU times over a window to derive utilisation %.
// A wider window gives a steadier reading when the client polls frequently.
// The aggregate and per-core readings come from the same window so they agree.
async function getCpuUsage(): Promise<{ usedPercent: number; perCore: number[] }> {
    const start = perCoreSnapshot();
    await new Promise((r) => setTimeout(r, 500));
    const end = perCoreSnapshot();

    let idleSum = 0;
    let totalSum = 0;
    const perCore = start.map((s, i) => {
        const e = end[i];
        const idleDelta = e.idle - s.idle;
        const totalDelta = e.total - s.total;
        idleSum += idleDelta;
        totalSum += totalDelta;
        return busyPercent(idleDelta, totalDelta);
    });

    return { usedPercent: busyPercent(idleSum, totalSum), perCore };
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

// Cumulative rx/tx byte counters across all real interfaces (loopback excluded).
// Node's `os` exposes no network I/O, so we read the OS counters directly.
async function readNetCounters(): Promise<{ rx: number; tx: number }> {
    let rx = 0;
    let tx = 0;
    try {
        if (process.platform === 'linux') {
            const data = await readFile('/proc/net/dev', 'utf8');
            for (const line of data.split('\n').slice(2)) {
                const [nameRaw, rest] = line.split(':');
                if (!rest) continue;
                if (nameRaw.trim() === 'lo') continue;
                const f = rest.trim().split(/\s+/);
                rx += parseInt(f[0], 10) || 0; // received bytes
                tx += parseInt(f[8], 10) || 0; // transmitted bytes
            }
        } else if (process.platform === 'darwin') {
            // `netstat -ibn` repeats a row per address; the first row per
            // interface carries the cumulative byte totals. Columns from the
            // end are stable: ... Ibytes Opkts Oerrs Obytes Coll
            const { stdout } = await execAsync('netstat -ibn');
            const seen = new Set<string>();
            for (const line of stdout.trim().split('\n').slice(1)) {
                const c = line.trim().split(/\s+/);
                const name = c[0];
                if (!name || name.startsWith('lo') || seen.has(name)) continue;
                seen.add(name);
                rx += parseInt(c[c.length - 5], 10) || 0;
                tx += parseInt(c[c.length - 2], 10) || 0;
            }
        }
    } catch {
        return { rx: 0, tx: 0 };
    }
    return { rx, tx };
}

// Sample counters over a short window to derive throughput in bytes/sec.
async function getNetwork(): Promise<{ rxBytesPerSec: number; txBytesPerSec: number }> {
    const start = await readNetCounters();
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 500));
    const end = await readNetCounters();
    const dt = (Date.now() - t0) / 1000;
    if (dt <= 0) return { rxBytesPerSec: 0, txBytesPerSec: 0 };
    return {
        rxBytesPerSec: Math.max(0, (end.rx - start.rx) / dt),
        txBytesPerSec: Math.max(0, (end.tx - start.tx) / dt),
    };
}

router.get('/stats', async (_req, res, next: NextFunction) => {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        const [cpu, disk, network] = await Promise.all([
            getCpuUsage(),
            getDisk(config.hosting.servDir),
            getNetwork(),
        ]);

        res.json({
            hostname: os.hostname(),
            platform: `${os.type()} ${os.release()}`,
            uptimeSeconds: os.uptime(),
            cpu: {
                usedPercent: cpu.usedPercent,
                cores: os.cpus().length,
                model: os.cpus()[0]?.model?.trim() || 'unknown',
                loadAvg: os.loadavg(),
                perCore: cpu.perCore,
            },
            memory: {
                total: totalMem,
                used: usedMem,
                free: freeMem,
                usedPercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0,
            },
            disk,
            network,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        next(error);
    }
});

export default router;
