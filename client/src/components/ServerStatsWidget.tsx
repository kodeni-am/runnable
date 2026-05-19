import { useEffect, useRef, useState } from 'react';
import { Cpu, MemoryStick, HardDrive, Activity, AlertCircle, ChevronRight, ArrowDown, ArrowUp } from 'lucide-react';
import { systemApi, type SystemStats } from '../api/system';

function formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatRate(bytesPerSec: number): string {
    return `${formatBytes(bytesPerSec)}/s`;
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

const LOAD_WINDOWS = ['1m', '5m', '15m'];

function CpuGauge({ cpu }: { cpu: SystemStats['cpu'] }) {
    const [open, setOpen] = useState(false);
    const perCore = cpu.perCore ?? [];
    return (
        <div className="server-stat">
            <div className="server-stat-head">
                <span className="server-stat-label"><Cpu size={14} />CPU</span>
                <span className="server-stat-percent" style={{ color: barColor(cpu.usedPercent) }}>
                    {cpu.usedPercent.toFixed(0)}%
                </span>
            </div>
            <div className="server-stat-track">
                <div
                    className="server-stat-fill"
                    style={{ width: `${Math.min(100, cpu.usedPercent)}%`, background: barColor(cpu.usedPercent) }}
                />
            </div>
            <div className="server-stat-detail">
                {cpu.cores} cores · load{' '}
                {cpu.loadAvg
                    .map((l, i) => {
                        const pct = cpu.cores > 0 ? (l / cpu.cores) * 100 : 0;
                        return `${pct.toFixed(0)}% ${LOAD_WINDOWS[i] ?? ''}`.trim();
                    })
                    .join(' · ')}
            </div>
            {perCore.length > 1 && (
                <>
                    <button
                        type="button"
                        className="server-stat-toggle"
                        aria-expanded={open}
                        onClick={() => setOpen((o) => !o)}
                    >
                        <ChevronRight
                            size={12}
                            style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}
                        />
                        {open ? 'Hide' : 'Show'} per-core usage
                    </button>
                    {open && (
                        <div className="server-cores">
                            {perCore.map((p, i) => (
                                <div className="server-core" key={i}>
                                    <span className="server-core-label">#{i}</span>
                                    <div className="server-core-track">
                                        <div
                                            className="server-core-fill"
                                            style={{ width: `${Math.min(100, p)}%`, background: barColor(p) }}
                                        />
                                    </div>
                                    <span className="server-core-pct">{p.toFixed(0)}%</span>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
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
                    <CpuGauge cpu={stats.cpu} />
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
                    <div className="server-net">
                        <span className="server-net-item">
                            <ArrowDown size={14} style={{ color: 'var(--status-running)' }} />
                            <span className="server-net-label">Inbound</span>
                            <span className="server-net-value">{formatRate(stats.network.rxBytesPerSec)}</span>
                        </span>
                        <span className="server-net-item">
                            <ArrowUp size={14} style={{ color: '#3b82f6' }} />
                            <span className="server-net-label">Outbound</span>
                            <span className="server-net-value">{formatRate(stats.network.txBytesPerSec)}</span>
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
