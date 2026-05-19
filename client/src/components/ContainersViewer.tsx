import { useState, useEffect, useCallback } from 'react';
import { projectsApi, type ContainerInfo } from '../api/projects';
import { RefreshCw, Box, ArrowLeft } from 'lucide-react';
import LogConsole from './LogConsole';

function StateBadge({ state }: { state: string }) {
    const cls =
        state === 'running' ? 'status-running'
            : state === 'exited' || state === 'dead' ? 'status-error'
                : 'status-stopped';
    return (
        <span className={`status-badge ${cls}`}>
            <span className="status-dot" />
            {state || 'unknown'}
        </span>
    );
}

export default function ContainersViewer({ projectId }: { projectId: string }) {
    const [containers, setContainers] = useState<ContainerInfo[]>([]);
    const [loadingList, setLoadingList] = useState(false);
    const [selected, setSelected] = useState<ContainerInfo | null>(null);

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

    const fetchContainerLogs = useCallback(async () => {
        if (!selected) return [];
        const { data } = await projectsApi.containerLogs(projectId, selected.name, 2000);
        return data.logs as string[];
    }, [projectId, selected]);

    if (selected) {
        return (
            <LogConsole
                title={selected.name}
                fetchLogs={fetchContainerLogs}
                sourceKey={selected.name}
                leftAccessory={
                    <button className="btn btn-secondary" onClick={() => setSelected(null)} style={{ fontSize: 13, padding: '6px 14px' }}>
                        <ArrowLeft size={14} /> Containers
                    </button>
                }
            />
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
                <div className="container-empty">
                    {loadingList ? 'Loading containers…' : 'No containers running. Start the project to see its containers.'}
                </div>
            ) : (
                <div className="container-list">
                    {containers.map((c) => (
                        <button
                            key={c.id || c.name}
                            className="container-row"
                            onClick={() => setSelected(c)}
                        >
                            <span className="container-row__icon">
                                <Box size={20} />
                            </span>
                            <span className="container-row__main">
                                <span className="container-row__name">{c.service || c.name}</span>
                                <span className="container-row__meta">
                                    {c.name}{c.ports ? ` · ${c.ports}` : ''}
                                </span>
                            </span>
                            <StateBadge state={c.state} />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
