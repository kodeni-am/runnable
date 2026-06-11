import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, X, ChevronDown, ChevronUp } from 'lucide-react';
import type { DeployProgress, DeployFinished } from '../hooks/useProjectSocket';
import type { Project } from '../api/projects';
import { projectsApi } from '../api/projects';
import LogConsole from './LogConsole';

const PHASES_BLUE_GREEN = [
    { key: 'building', label: 'Build' },
    { key: 'starting', label: 'Start new' },
    { key: 'health-check', label: 'Health check' },
    { key: 'switching', label: 'Switch traffic' },
    { key: 'done', label: 'Done' },
];
const PHASES_INPLACE = [
    { key: 'building', label: 'Build' },
    { key: 'updating-services', label: 'Update services' },
    { key: 'switching', label: 'Reconnect' },
    { key: 'done', label: 'Done' },
];

function useElapsed(since: number | null): string {
    const [, tick] = useState(0);
    useEffect(() => {
        if (!since) return;
        const t = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [since]);
    if (!since) return '';
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function fmtDuration(ms?: number): string {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

interface Props {
    project: Project;
    progress: DeployProgress | null;
    finished: DeployFinished | null;
    deployStartedAt: number | null;
    onDismiss: () => void;
}

/**
 * Transient card shown while a deploy runs and (sticky, for failures) after
 * it finishes. The load-bearing message is the green "site is up" chip: a
 * zero-downtime deploy keeps the previous version serving, and a failed one
 * is otherwise indistinguishable from "nothing happened".
 */
export default function DeployActivityCard({ project, progress, finished, deployStartedAt, onDismiss }: Props) {
    const [showLog, setShowLog] = useState(false);
    const elapsed = useElapsed(deployStartedAt);
    const deploying = project.status === 'deploying' || (project.status as string) === 'building';

    const fetchBuildLog = useCallback(
        async () => (await projectsApi.buildLog(project.id)).data.logs,
        [project.id],
    );

    // Success auto-dismisses; failures stick until the user closes them
    useEffect(() => {
        if (finished?.outcome === 'success' && !deploying) {
            const t = setTimeout(onDismiss, 5000);
            return () => clearTimeout(t);
        }
    }, [finished, deploying, onDismiss]);

    if (!deploying && !finished) return null;

    // The reassurance chip is only true when an old version exists — the
    // legacy recreate path takes the site down during the swap.
    const strategy = progress?.strategy ?? finished?.strategy;
    const showStillUpChip = strategy !== 'recreate';

    const logToggle = (
        <button className="deploy-card-logbtn" onClick={() => setShowLog((s) => !s)}>
            View build log {showLog ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
    );
    const logViewer = showLog && (
        <div className="deploy-card-log">
            <LogConsole title="Build log" fetchLogs={fetchBuildLog} />
        </div>
    );

    if (finished && !deploying) {
        const stillUp = finished.outcome === 'failed-still-serving';
        const down = finished.outcome === 'failed-down';
        return (
            <div className={`deploy-card glass ${down ? 'deploy-card-error' : stillUp ? 'deploy-card-warn' : 'deploy-card-ok'}`}>
                <div className="deploy-card-row">
                    {finished.outcome === 'success'
                        ? <CheckCircle2 size={16} className="deploy-icon-ok" />
                        : <XCircle size={16} className={down ? 'deploy-icon-err' : 'deploy-icon-warn'} />}
                    <span className="deploy-card-title">
                        {finished.outcome === 'success' && 'Deployed successfully'}
                        {stillUp && 'Deploy failed'}
                        {down && 'Deploy failed — service is down'}
                    </span>
                    <span className="deploy-card-meta">
                        {finished.strategy}{finished.durationMs ? ` · ${fmtDuration(finished.durationMs)}` : ''}
                    </span>
                    <button className="deploy-card-dismiss" onClick={onDismiss} title="Dismiss"><X size={14} /></button>
                </div>
                {stillUp && (
                    <div className="deploy-card-chip deploy-chip-ok">
                        ✓ Site is up — the previous version kept serving; visitors saw nothing
                    </div>
                )}
                {finished.healthGate === 'degraded' && (
                    <div className="deploy-card-chip deploy-chip-warn">
                        <AlertTriangle size={13} /> Health check timed out — traffic was switched anyway
                    </div>
                )}
                <div className="deploy-card-row deploy-card-footer">{logToggle}</div>
                {logViewer}
            </div>
        );
    }

    const phases = progress?.strategy === 'compose-inplace' ? PHASES_INPLACE : PHASES_BLUE_GREEN;
    const activeIdx = progress ? phases.findIndex((p) => p.key === progress.phase) : 0;

    return (
        <div className="deploy-card glass">
            <div className="deploy-card-row">
                <span className="deploy-card-title">Deploying…</span>
                {elapsed && <span className="deploy-card-meta">⏱ {elapsed}</span>}
            </div>
            <div className="deploy-stepper">
                {phases.map((p, i) => (
                    <div key={p.key}
                        className={`deploy-step ${i < activeIdx ? 'done' : i === activeIdx ? 'active' : ''}`}>
                        <span className="deploy-step-dot" />
                        <span className="deploy-step-label">{p.label}</span>
                    </div>
                ))}
            </div>
            {showStillUpChip && (
                <div className="deploy-card-chip deploy-chip-ok">
                    ✓ Site is up — the previous version is serving traffic
                </div>
            )}
            <div className="deploy-card-row deploy-card-footer">
                {progress && <span className="deploy-card-meta">Strategy: {progress.strategy}</span>}
                {logToggle}
            </div>
            {logViewer}
        </div>
    );
}
