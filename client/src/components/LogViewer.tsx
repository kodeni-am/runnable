import { useState, useEffect, useRef } from 'react';
import { projectsApi } from '../api/projects';
import { RefreshCw } from 'lucide-react';

export default function LogViewer({ projectId }: { projectId: string }) {
    const [logs, setLogs] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const logEndRef = useRef<HTMLDivElement>(null);

    const fetchLogs = async () => {
        setLoading(true);
        try {
            const { data } = await projectsApi.logs(projectId, 200);
            setLogs(data.logs);
        } catch {
            setLogs(['Failed to fetch logs']);
        }
        setLoading(false);
    };

    useEffect(() => {
        fetchLogs();
    }, [projectId]);

    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <h3>Service Logs</h3>
                <button className="btn btn-secondary" onClick={fetchLogs} disabled={loading} style={{ fontSize: 13, padding: '6px 14px' }}>
                    <RefreshCw size={14} className={loading ? 'spinning' : ''} /> Refresh
                </button>
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
