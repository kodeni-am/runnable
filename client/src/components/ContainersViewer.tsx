import { useState, useEffect, useRef, useCallback } from 'react';
import { projectsApi, type ContainerInfo } from '../api/projects';
import { RefreshCw, Radio, Box, ArrowLeft } from 'lucide-react';

export default function ContainersViewer({ projectId }: { projectId: string }) {
    const [containers, setContainers] = useState<ContainerInfo[]>([]);
    const [loadingList, setLoadingList] = useState(false);
    const [selected, setSelected] = useState<ContainerInfo | null>(null);

    const [logs, setLogs] = useState<string[]>([]);
    const [loadingLogs, setLoadingLogs] = useState(false);
    const [live, setLive] = useState(false);
    const logEndRef = useRef<HTMLDivElement>(null);

    const fetchContainers = useCallback(async () => {
        setLoadingList(true);
        try {
            const { data } = await projectsApi.listContainers(projectId);
            setContainers(data.containers);
        } catch {
            setContainers([]);
        }
        setLoadingList(false);
    }, [projectId]);

    useEffect(() => {
        fetchContainers();
    }, [fetchContainers]);

    const fetchLogs = useCallback(async (name: string) => {
        setLoadingLogs(true);
        try {
            const { data } = await projectsApi.containerLogs(projectId, name, 300);
            setLogs(data.logs);
        } catch {
            setLogs(['Failed to fetch container logs']);
        }
        setLoadingLogs(false);
    }, [projectId]);

    useEffect(() => {
        if (selected) fetchLogs(selected.name);
    }, [selected, fetchLogs]);

    useEffect(() => {
        if (!live || !selected) return;
        const interval = setInterval(() => fetchLogs(selected.name), 2000);
        return () => clearInterval(interval);
    }, [live, selected, fetchLogs]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    const stateColor = (state: string) =>
        state === 'running' ? 'var(--success, #16a34a)'
            : state === 'exited' || state === 'dead' ? 'var(--danger, #dc2626)'
                : 'var(--text-muted)';

    if (selected) {
        return (
            <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <button className="btn btn-secondary" onClick={() => { setSelected(null); setLive(false); }} style={{ fontSize: 13, padding: '6px 14px' }}>
                        <ArrowLeft size={14} /> Containers
                    </button>
                    <h3 style={{ margin: 0, fontSize: 15 }}>{selected.name}</h3>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            className={`btn ${live ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={() => setLive((v) => !v)}
                            style={{ fontSize: 13, padding: '6px 14px' }}
                        >
                            <Radio size={14} className={live ? 'spinning' : ''} /> {live ? 'Live' : 'Go Live'}
                        </button>
                        <button className="btn btn-secondary" onClick={() => fetchLogs(selected.name)} disabled={loadingLogs} style={{ fontSize: 13, padding: '6px 14px' }}>
                            <RefreshCw size={14} className={loadingLogs ? 'spinning' : ''} /> Refresh
                        </button>
                    </div>
                </div>
                <div className="log-viewer">
                    {logs.map((line, i) => (
                        <div key={i} className="log-line">{line}</div>
                    ))}
                    <div ref={logEndRef} />
                </div>
            </div>
        );
    }

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h3 style={{ margin: 0 }}>Containers</h3>
                <button className="btn btn-secondary" onClick={fetchContainers} disabled={loadingList} style={{ fontSize: 13, padding: '6px 14px' }}>
                    <RefreshCw size={14} className={loadingList ? 'spinning' : ''} /> Refresh
                </button>
            </div>

            {containers.length === 0 ? (
                <div className="glass" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                    {loadingList ? 'Loading containers…' : 'No containers running. Start the project to see its containers.'}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {containers.map((c) => (
                        <button
                            key={c.id || c.name}
                            className="glass"
                            onClick={() => setSelected(c)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 14, padding: 16,
                                textAlign: 'left', cursor: 'pointer', border: 'none', width: '100%',
                            }}
                        >
                            <Box size={20} style={{ color: stateColor(c.state), flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 15 }}>
                                    {c.service || c.name}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {c.name}{c.ports ? ` · ${c.ports}` : ''}
                                </div>
                            </div>
                            <div style={{ fontSize: 13, color: stateColor(c.state), flexShrink: 0 }}>
                                {c.status || c.state}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
