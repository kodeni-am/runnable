import { useEffect, useRef, useState } from 'react';
import { Cpu, MemoryStick, HardDrive, Activity, AlertCircle } from 'lucide-react';
import { systemApi, type SystemStats } from '../api/system';

function formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function barColor(percent: number): string {
    if (percent >= 90) return 'var(--status-error)';
    if (percent >= 70) return '#f59e0b';
    return 'var(--status-running)';
}

interface StatGaugeProps {
    icon: React.ReactNode;
    label: string;
    percent: number;
    detail: string;
}

function StatGauge({ icon, label, percent, detail }: StatGaugeProps) {
    return (
        <div className="server-stat">
            <div className="server-stat-head">
                <span className="server-stat-label">{icon}{label}</span>
                <span className="server-stat-percent" style={{ color: barColor(percent) }}>
                    {percent.toFixed(0)}%
                </span>
            </div>
            <div className="server-stat-track">
                <div
                    className="server-stat-fill"
                    style={{ width: `${Math.min(100, percent)}%`, background: barColor(percent) }}
                />
            </div>
            <div className="server-stat-detail">{detail}</div>
        </div>
    );
}

export default function ServerStatsWidget() {
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [error, setError] = useState('');
    const timer = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        let active = true;
        const load = async () => {
            try {
                const { data } = await systemApi.stats();
                if (active) {
                    setStats(data);
                    setError('');
                }
            } catch (err: any) {
                if (active) setError(err.response?.data?.error || 'Failed to load server stats');
            }
        };
        load();
        // CPU/memory are cheap; disk is cached server-side (~20s TTL),
        // so a fast client poll stays light.
        timer.current = setInterval(load, 2000);
        return () => {
            active = false;
            if (timer.current) clearInterval(timer.current);
        };
    }, []);

    return (
        <div className="glass server-stats" style={{ padding: 24, borderRadius: 12, marginBottom: 24 }}>
            <div className="server-stats-header">
                <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                    <Activity size={18} className="text-primary" />
                    Server State
                </h3>
                {stats && (
                    <span className="server-stats-meta">
                        {stats.hostname} · up {formatUptime(stats.uptimeSeconds)}
                    </span>
                )}
            </div>

            {error ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--status-error)', fontSize: 13, marginTop: 16 }}>
                    <AlertCircle size={16} /> {error}
                </div>
            ) : !stats ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                    <div className="spinner" style={{ width: 24, height: 24 }} />
                </div>
            ) : (
                <div className="server-stats-grid">
                    <StatGauge
                        icon={<Cpu size={14} />}
                        label="CPU"
                        percent={stats.cpu.usedPercent}
                        detail={`${stats.cpu.cores} cores · load ${stats.cpu.loadAvg.map((l) => l.toFixed(2)).join(' / ')}`}
                    />
                    <StatGauge
                        icon={<MemoryStick size={14} />}
                        label="Memory"
                        percent={stats.memory.usedPercent}
                        detail={`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`}
                    />
                    <StatGauge
                        icon={<HardDrive size={14} />}
                        label="Disk"
                        percent={stats.disk.usedPercent}
                        detail={`${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)} · ${stats.disk.mount}`}
                    />
                </div>
            )}
        </div>
    );
}
