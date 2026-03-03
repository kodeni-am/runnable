import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { adminApi } from '../api/admin';
import type { UserDTO } from '../api/admin';
import { ShieldAlert, Trash2, CheckCircle, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../store/authStore';

export default function Admin() {
    const { user: currentUser } = useAuthStore();
    const [users, setUsers] = useState<UserDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchUsers();
    }, []);

    const fetchUsers = async () => {
        try {
            setLoading(true);
            const { data } = await adminApi.getUsers();
            setUsers(data);
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to load users');
        } finally {
            setLoading(false);
        }
    };

    const handleApprove = async (id: string) => {
        try {
            await adminApi.approveUser(id);
            setUsers(users.map(u => u.id === id ? { ...u, isApproved: true } : u));
        } catch (err: any) {
            alert(err.response?.data?.error || 'Failed to approve user');
        }
    };

    const handleDelete = async (id: string) => {
        if (!window.confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
            return;
        }
        try {
            await adminApi.deleteUser(id);
            setUsers(users.filter(u => u.id !== id));
        } catch (err: any) {
            alert(err.response?.data?.error || 'Failed to delete user');
        }
    };

    return (
        <Layout>
            <div className="page-header">
                <h1>Admin Panel</h1>
            </div>
            <div className="page-content">
                {error && <div className="error-message">{error}</div>}

                <div className="glass" style={{ padding: 24, borderRadius: 12 }}>
                    <h3 style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <ShieldAlert size={20} className="text-primary" />
                        User Management
                    </h3>

                    {loading ? (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                            <div className="spinner" style={{ width: 30, height: 30 }} />
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                                        <th style={{ padding: '12px 16px', color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Username</th>
                                        <th style={{ padding: '12px 16px', color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Email</th>
                                        <th style={{ padding: '12px 16px', color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Role</th>
                                        <th style={{ padding: '12px 16px', color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Status</th>
                                        <th style={{ padding: '12px 16px', color: 'rgba(255,255,255,0.6)', fontWeight: 500, textAlign: 'right' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map(user => (
                                        <tr key={user.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                            <td style={{ padding: '16px' }}>
                                                {user.username}
                                                {(user.githubId || user.googleId) && (
                                                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                                                        {user.githubId && 'GitHub Linked'}
                                                        {user.githubId && user.googleId && ' • '}
                                                        {user.googleId && 'Google Linked'}
                                                    </div>
                                                )}
                                            </td>
                                            <td style={{ padding: '16px', color: 'rgba(255,255,255,0.7)' }}>{user.email}</td>
                                            <td style={{ padding: '16px' }}>
                                                <span style={{
                                                    padding: '4px 10px',
                                                    borderRadius: 12,
                                                    fontSize: 12,
                                                    background: user.role === 'admin' ? 'rgba(164, 118, 255, 0.15)' : 'rgba(255,255,255,0.05)',
                                                    color: user.role === 'admin' ? '#a476ff' : 'rgba(255,255,255,0.8)'
                                                }}>
                                                    {user.role}
                                                </span>
                                            </td>
                                            <td style={{ padding: '16px' }}>
                                                {user.isApproved || user.role === 'admin' ? (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--status-running)', fontSize: 13 }}>
                                                        <CheckCircle size={14} /> Approved
                                                    </span>
                                                ) : (
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--status-stopped)', fontSize: 13 }}>
                                                        <ShieldAlert size={14} /> Pending
                                                    </span>
                                                )}
                                            </td>
                                            <td style={{ padding: '16px', textAlign: 'right' }}>
                                                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                                    {!user.isApproved && user.role !== 'admin' && (
                                                        <button
                                                            onClick={() => handleApprove(user.id)}
                                                            className="btn btn-primary"
                                                            style={{ padding: '6px 14px', fontSize: 13, gap: 6 }}
                                                        >
                                                            <ShieldCheck size={14} /> Approve
                                                        </button>
                                                    )}
                                                    {user.id !== currentUser?.id && user.role !== 'admin' && (
                                                        <button
                                                            onClick={() => handleDelete(user.id)}
                                                            className="btn btn-secondary"
                                                            style={{ padding: '6px 14px', fontSize: 13, color: 'var(--status-error)', borderColor: 'rgba(255, 68, 68, 0.2)' }}
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                    {users.length === 0 && (
                                        <tr>
                                            <td colSpan={5} style={{ padding: 32, textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
                                                No users found
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </Layout>
    );
}
