import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useProjectStore } from '../store/projectStore';
import type { Project } from '../api/projects';

export interface DeployProgress {
    projectId: string;
    phase: 'building' | 'starting' | 'health-check' | 'switching'
        | 'updating-services' | 'retiring' | 'done';
    strategy: 'blue-green' | 'compose-inplace' | 'recreate';
    message?: string;
    ts: number;
}

export interface DeployFinished {
    projectId: string;
    outcome: 'success' | 'failed-still-serving' | 'failed-down';
    strategy?: 'blue-green' | 'compose-inplace' | 'recreate';
    durationMs?: number;
    healthGate?: 'passed' | 'degraded';
}

/**
 * Live project status + deploy events over the server's socket.io rooms.
 * Auth rides on the same JWT cookie the REST API uses; the server's
 * `subscribe` handler checks project access before joining the room.
 */
export function useProjectSocket(projectId: string | undefined) {
    const updateProjectStatus = useProjectStore((s) => s.updateProjectStatus);
    const [progress, setProgress] = useState<DeployProgress | null>(null);
    const [finished, setFinished] = useState<DeployFinished | null>(null);
    const [deployStartedAt, setDeployStartedAt] = useState<number | null>(null);
    const startedRef = useRef(false);

    useEffect(() => {
        if (!projectId) return;
        setProgress(null);
        setFinished(null);
        setDeployStartedAt(null);
        startedRef.current = false;

        // Same origin in prod (Caddy) and dev (vite proxies /socket.io)
        const socket: Socket = io({ withCredentials: true });
        socket.on('connect', () => socket.emit('subscribe', projectId));
        socket.on('service:status', (p: { projectId: string; status: Project['status'] }) => {
            if (p.projectId !== projectId) return;
            updateProjectStatus(projectId, p.status);
            if (p.status === 'deploying' || p.status === ('building' as Project['status'])) {
                setFinished(null);
                if (!startedRef.current) {
                    startedRef.current = true;
                    setDeployStartedAt(Date.now());
                }
            }
        });
        socket.on('deploy:progress', (p: DeployProgress) => {
            if (p.projectId !== projectId) return;
            if (!startedRef.current) {
                startedRef.current = true;
                setDeployStartedAt(Date.now());
            }
            setProgress(p);
        });
        socket.on('deploy:finished', (p: DeployFinished) => {
            if (p.projectId !== projectId) return;
            setFinished(p);
            setProgress(null);
            setDeployStartedAt(null);
            startedRef.current = false;
        });
        return () => { socket.disconnect(); };
    }, [projectId, updateProjectStatus]);

    return {
        progress,
        finished,
        deployStartedAt,
        dismissFinished: () => setFinished(null),
    };
}
