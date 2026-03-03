import Layout from '../components/Layout';
import { useAuthStore } from '../store/authStore';
import { Shield, User, Key } from 'lucide-react';

export default function Settings() {
    const { user } = useAuthStore();

    return (
        <Layout>
            <div className="page-header">
                <h1>Settings</h1>
            </div>
            <div className="page-content">
                <div className="info-grid">
                    <div className="info-card glass">
                        <div className="info-card-label"><User size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />Username</div>
                        <div className="info-card-value">{user?.username || '—'}</div>
                    </div>
                    <div className="info-card glass">
                        <div className="info-card-label"><Shield size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />Email</div>
                        <div className="info-card-value">{user?.email || '—'}</div>
                    </div>
                    <div className="info-card glass">
                        <div className="info-card-label"><Key size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />Role</div>
                        <div className="info-card-value" style={{ textTransform: 'uppercase' }}>{user?.role || '—'}</div>
                    </div>
                </div>

                <div style={{ marginTop: 32 }}>
                    <h3 style={{ marginBottom: 16 }}>Connected Accounts</h3>
                    <div className="info-grid">
                        <div className="info-card glass">
                            <div className="info-card-label">GitHub</div>
                            <div className="info-card-value" style={{ fontSize: 14 }}>
                                {(user as any)?.githubId ? (
                                    <span style={{ color: 'var(--status-running)' }}>✓ Connected</span>
                                ) : (
                                    <a
                                        href={`/api/auth/github?token=${localStorage.getItem('accessToken')}`}
                                        className="btn btn-secondary"
                                        style={{ fontSize: 13, padding: '6px 14px' }}
                                    >
                                        Connect GitHub
                                    </a>
                                )}
                            </div>
                        </div>
                        <div className="info-card glass">
                            <div className="info-card-label">Google</div>
                            <div className="info-card-value" style={{ fontSize: 14 }}>
                                {(user as any)?.googleId ? (
                                    <span style={{ color: 'var(--status-running)' }}>✓ Connected</span>
                                ) : (
                                    <a
                                        href={`/api/auth/google?token=${localStorage.getItem('accessToken')}`}
                                        className="btn btn-secondary"
                                        style={{ fontSize: 13, padding: '6px 14px' }}
                                    >
                                        Connect Google
                                    </a>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Layout>
    );
}
