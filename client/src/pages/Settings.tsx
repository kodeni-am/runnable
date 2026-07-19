import { useEffect, useState, type FormEvent } from 'react';
import { Shield, User, Key, KeyRound, Trash2 } from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import Layout from '../components/Layout';
import { useAuthStore } from '../store/authStore';
import { usePageTitle } from '../hooks/usePageTitle';
import { authApi } from '../api/auth';
import { passkeysApi, type PasskeySummary } from '../api/passkeys';

export default function Settings() {
    usePageTitle('Settings');
    const { user, updateUser } = useAuthStore();

    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [pwError, setPwError] = useState('');
    const [pwSuccess, setPwSuccess] = useState('');
    const [pwLoading, setPwLoading] = useState(false);

    const [emailPassword, setEmailPassword] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [emailError, setEmailError] = useState('');
    const [emailSuccess, setEmailSuccess] = useState('');
    const [emailLoading, setEmailLoading] = useState(false);

    const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
    const [pkName, setPkName] = useState('');
    const [pkError, setPkError] = useState('');
    const [pkSuccess, setPkSuccess] = useState('');
    const [pkLoading, setPkLoading] = useState(false);
    const webauthnSupported = !!window.PublicKeyCredential;

    useEffect(() => {
        passkeysApi.list()
            .then(({ data }) => setPasskeys(data))
            .catch(() => { /* non-fatal — section just shows empty */ });
    }, []);

    const handleAddPasskey = async (e: FormEvent) => {
        e.preventDefault();
        setPkError('');
        setPkSuccess('');
        setPkLoading(true);
        try {
            const { data: options } = await passkeysApi.registerOptions();
            const response = await startRegistration({ optionsJSON: options });
            const { data: created } = await passkeysApi.registerVerify({ response, name: pkName });
            setPasskeys((prev) => [...prev, created]);
            setPkName('');
            setPkSuccess('Passkey added');
        } catch (err: any) {
            // User dismissed the browser prompt — quiet no-op
            if (err?.name !== 'NotAllowedError' && err?.code !== 'ERROR_CEREMONY_ABORTED') {
                setPkError(err.response?.data?.error || 'Failed to add passkey');
            }
        } finally {
            setPkLoading(false);
        }
    };

    const handleDeletePasskey = async (id: string) => {
        if (!confirm('Remove this passkey? You will no longer be able to sign in with it.')) return;
        setPkError('');
        try {
            await passkeysApi.remove(id);
            setPasskeys((prev) => prev.filter((p) => p.id !== id));
        } catch (err: any) {
            setPkError(err.response?.data?.error || 'Failed to remove passkey');
        }
    };

    const handleChangeEmail = async (e: FormEvent) => {
        e.preventDefault();
        setEmailError('');
        setEmailSuccess('');
        setEmailLoading(true);
        try {
            const { data } = await authApi.changeEmail({ currentPassword: emailPassword, newEmail });
            updateUser({ email: data.email });
            setEmailSuccess('Email updated successfully');
            setEmailPassword('');
            setNewEmail('');
        } catch (err: any) {
            setEmailError(err.response?.data?.error || 'Failed to update email');
        } finally {
            setEmailLoading(false);
        }
    };

    const handleConnect = async (url: string) => {
        // The server identifies the linking user from the accessToken cookie,
        // which expires after 15 min — refresh it first so a stale cookie
        // doesn't silently link/log into the wrong account.
        try {
            await authApi.refresh();
        } catch {
            // ignore — proceed with the redirect regardless
        }
        window.location.href = url;
    };

    const handleChangePassword = async (e: FormEvent) => {
        e.preventDefault();
        setPwError('');
        setPwSuccess('');
        if (newPassword !== confirmPassword) {
            setPwError('New passwords do not match');
            return;
        }
        setPwLoading(true);
        try {
            await authApi.changePassword({ currentPassword, newPassword });
            setPwSuccess('Password updated successfully');
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (err: any) {
            setPwError(err.response?.data?.error || 'Failed to update password');
        } finally {
            setPwLoading(false);
        }
    };

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
                    <h3 style={{ marginBottom: 16 }}>Change Email</h3>
                    <div className="info-card glass" style={{ maxWidth: 420 }}>
                        {emailError && <div className="alert alert-error">{emailError}</div>}
                        {emailSuccess && <div className="alert alert-success">{emailSuccess}</div>}
                        <form onSubmit={handleChangeEmail}>
                            <div className="form-group">
                                <label>New Email</label>
                                <input
                                    type="email"
                                    className="form-input"
                                    placeholder="you@example.com"
                                    value={newEmail}
                                    onChange={(e) => setNewEmail(e.target.value)}
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label>Current Password</label>
                                <input
                                    type="password"
                                    className="form-input"
                                    placeholder="••••••••"
                                    value={emailPassword}
                                    onChange={(e) => setEmailPassword(e.target.value)}
                                />
                            </div>
                            <button type="submit" className="btn btn-primary" disabled={emailLoading}>
                                {emailLoading ? <span className="spinner" /> : 'Update Email'}
                            </button>
                        </form>
                    </div>
                </div>

                <div style={{ marginTop: 32 }}>
                    <h3 style={{ marginBottom: 16 }}>Change Password</h3>
                    <div className="info-card glass" style={{ maxWidth: 420 }}>
                        {pwError && <div className="alert alert-error">{pwError}</div>}
                        {pwSuccess && <div className="alert alert-success">{pwSuccess}</div>}
                        <form onSubmit={handleChangePassword}>
                            <div className="form-group">
                                <label>Current Password</label>
                                <input
                                    type="password"
                                    className="form-input"
                                    placeholder="••••••••"
                                    value={currentPassword}
                                    onChange={(e) => setCurrentPassword(e.target.value)}
                                />
                            </div>
                            <div className="form-group">
                                <label>New Password</label>
                                <input
                                    type="password"
                                    className="form-input"
                                    placeholder="••••••••"
                                    value={newPassword}
                                    onChange={(e) => setNewPassword(e.target.value)}
                                    required
                                    minLength={8}
                                />
                            </div>
                            <div className="form-group">
                                <label>Confirm New Password</label>
                                <input
                                    type="password"
                                    className="form-input"
                                    placeholder="••••••••"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    required
                                    minLength={8}
                                />
                            </div>
                            <button type="submit" className="btn btn-primary" disabled={pwLoading}>
                                {pwLoading ? <span className="spinner" /> : 'Update Password'}
                            </button>
                        </form>
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
                                    <button
                                        onClick={() => handleConnect('/api/auth/github?redirect=/settings')}
                                        className="btn btn-secondary"
                                        style={{ fontSize: 13, padding: '6px 14px' }}
                                    >
                                        Connect GitHub
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="info-card glass">
                            <div className="info-card-label">Google</div>
                            <div className="info-card-value" style={{ fontSize: 14 }}>
                                {(user as any)?.googleId ? (
                                    <span style={{ color: 'var(--status-running)' }}>✓ Connected</span>
                                ) : (
                                    <button
                                        onClick={() => handleConnect('/api/auth/google?redirect=/settings')}
                                        className="btn btn-secondary"
                                        style={{ fontSize: 13, padding: '6px 14px' }}
                                    >
                                        Connect Google
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                <div style={{ marginTop: 32 }}>
                    <h3 style={{ marginBottom: 16 }}>Passkeys</h3>
                    <div className="info-card glass" style={{ maxWidth: 520 }}>
                        {pkError && <div className="alert alert-error">{pkError}</div>}
                        {pkSuccess && <div className="alert alert-success">{pkSuccess}</div>}

                        {passkeys.length > 0 && (
                            <div style={{ marginBottom: 16 }}>
                                {passkeys.map((pk) => (
                                    <div
                                        key={pk.id}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}
                                    >
                                        <div>
                                            <div style={{ fontSize: 14, fontWeight: 500 }}>
                                                <KeyRound size={14} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                                                {pk.name}
                                            </div>
                                            <div style={{ fontSize: 12, opacity: 0.7 }}>
                                                Added {new Date(pk.createdAt).toLocaleDateString()}
                                                {pk.lastUsedAt && ` · Last used ${new Date(pk.lastUsedAt).toLocaleDateString()}`}
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => handleDeletePasskey(pk.id)}
                                            className="btn btn-secondary"
                                            style={{ fontSize: 13, padding: '6px 10px' }}
                                            title="Remove passkey"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {webauthnSupported ? (
                            <form onSubmit={handleAddPasskey}>
                                <div className="form-group">
                                    <label>Passkey Name</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        placeholder="e.g. MacBook Touch ID"
                                        value={pkName}
                                        onChange={(e) => setPkName(e.target.value)}
                                        maxLength={64}
                                    />
                                </div>
                                <button type="submit" className="btn btn-primary" disabled={pkLoading}>
                                    {pkLoading ? <span className="spinner" /> : 'Add Passkey'}
                                </button>
                            </form>
                        ) : (
                            <p style={{ fontSize: 14, opacity: 0.7 }}>Your browser doesn't support passkeys.</p>
                        )}
                    </div>
                </div>
            </div>
        </Layout>
    );
}
