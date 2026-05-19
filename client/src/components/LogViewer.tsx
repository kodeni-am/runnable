import { useCallback } from 'react';
import { projectsApi } from '../api/projects';
import LogConsole from './LogConsole';

export default function LogViewer({ projectId }: { projectId: string }) {
    const fetchLogs = useCallback(async () => {
        const { data } = await projectsApi.logs(projectId, 2000);
        return data.logs as string[];
    }, [projectId]);

    return <LogConsole title="Service Logs" fetchLogs={fetchLogs} sourceKey={projectId} />;
}
