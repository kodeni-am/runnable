interface StatusBadgeProps {
    status: 'running' | 'stopped' | 'error' | 'deploying' | string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
    return (
        <span className={`status-badge status-${status}`}>
            <span className="status-dot" />
            {status}
        </span>
    );
}
