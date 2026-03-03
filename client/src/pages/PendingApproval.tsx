import { useEffect } from 'react';
import { useAuthStore } from '../store/authStore';

export default function PendingApproval() {
    const { logout, loadUser } = useAuthStore();

    useEffect(() => {
        // Poll every 10 seconds to check if approved
        const interval = setInterval(() => {
            loadUser();
        }, 10000);
        return () => clearInterval(interval);
    }, [loadUser]);

    return (
        <div className="auth-page">
            <div className="auth-card glass" style={{ textAlign: 'center' }}>
                <div style={{ marginBottom: 24, display: 'inline-flex', padding: 16, borderRadius: '50%', background: 'rgba(255, 107, 0, 0.1)', color: 'var(--accent)' }}>
                    <svg width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </div>
                <h1 className="gradient-text" style={{ fontSize: 24, marginBottom: 16 }}>Pending Approval</h1>
                <p style={{ color: 'var(--text-secondary)', marginBottom: 32 }}>
                    Your account has been created successfully, but it needs to be approved by an administrator before you can access Runnable. Please check back later.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
                    <div className="spinner" style={{ width: 24, height: 24, borderTopColor: 'var(--accent)' }} />
                    <button onClick={logout} className="btn btn-secondary btn-full" style={{ marginTop: 16 }}>
                        Sign Out
                    </button>
                </div>
            </div>
        </div>
    );
}
