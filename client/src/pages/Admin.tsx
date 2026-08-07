import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { adminApi } from '../api/admin';
import type { UserDTO, UserPermissions } from '../api/admin';
import { systemApi } from '../api/system';
import type { BuildCacheInfo, UpdatePhase, UpdateStatus } from '../api/system';
import { ShieldAlert, Trash2, CheckCircle, ShieldCheck, Settings, HardDrive, UserPlus, RefreshCw, Download } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { usePageTitle } from '../hooks/usePageTitle';

const DEFAULT_PERMISSIONS: UserPermissions = {
    maxProjects: null,
    canCreateProjects: true,
    canUseCustomDomains: true,
    allowedServerTypes: null,
};

// Whether each phase counts as "an update is actively running" — used to
// keep polling and to disable "Update now". A Record over the UpdatePhase
// union (see api/system.ts) requires every key to be present, so adding a
// phase to that union without deciding its entry here is a compile error,
// not just a typo-checker: a plain `UpdatePhase[]` literal would compile
// fine even with a phase missing from it, which is the exact bug this
// list exists to prevent (see item 4 of the self-update follow-up task).
const IS_RUNNING_PHASE: Record<UpdatePhase, boolean> = {
    idle: false,
    pulling: true,
    installing: true,
    building: true,
    syncing: true,
    restarting: true,
    verifying: true,
    done: false,
    rolling_back: true,
    failed: false,
    failed_rollback: false,
};

const RUNNING_PHASES: UpdatePhase[] =
    (Object.keys(IS_RUNNING_PHASE) as UpdatePhase[]).filter(phase => IS_RUNNING_PHASE[phase]);

export default function Admin() {
    usePageTitle('Admin');
    const { user: currentUser } = useAuthStore();
    const [users, setUsers] = useState<UserDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Permissions modal state
    const [permUser, setPermUser] = useState<UserDTO | null>(null);
    const [permForm, setPermForm] = useState<UserPermissions>(DEFAULT_PERMISSIONS);
    const [permSaving, setPermSaving] = useState(false);
    const [allowedTypesStr, setAllowedTypesStr] = useState('');

    // Build-cache (System) section
    const [cache, setCache] = useState<BuildCacheInfo | null>(null);
    const [cacheError, setCacheError] = useState('');
    const [capInput, setCapInput] = useState('');
    const [capSaving, setCapSaving] = useState(false);
    const [pruning, setPruning] = useState(false);
    const [cacheMessage, setCacheMessage] = useState('');

    // Self-service registration gate
    const [allowSignup, setAllowSignup] = useState<boolean | null>(null);
    const [signupSaving, setSignupSaving] = useState(false);
    const [signupError, setSignupError] = useState('');

    // Self-update
    const [update, setUpdate] = useState<UpdateStatus | null>(null);
    const [updateLog, setUpdateLog] = useState('');
    const [checking, setChecking] = useState(false);
    const [starting, setStarting] = useState(false);
    const [updateError, setUpdateError] = useState('');

    const gb = (bytes: number) => (bytes / 1e9).toFixed(2);

    const fetchRegistration = async () => {
        try {
            const { data } = await systemApi.getRegistration();
            setAllowSignup(data.allowPublicRegistration);
        } catch (err: any) {
            setSignupError(err.response?.data?.error || 'Failed to load registration setting');
        }
    };

    const fetchUpdate = async () => {
        try {
            const { data } = await systemApi.getUpdate();
            setUpdate(data);
        } catch (err: any) {
            setUpdateError(err.response?.data?.error || 'Failed to load update status');
        }
    };

    const handleCheckUpdate = async () => {
        try {
            setChecking(true);
            setUpdateError('');
            const { data } = await systemApi.checkUpdate();
            setUpdate(data);
        } catch (err: any) {
            setUpdateError(err.response?.data?.error || 'Check failed');
        } finally {
            setChecking(false);
        }
    };

    const handleStartUpdate = async () => {
        try {
            setStarting(true);
            setUpdateError('');
            const { data } = await systemApi.startUpdate();
            setUpdate(data);
        } catch (err: any) {
            setUpdateError(err.response?.data?.error || 'Could not start the update');
            setStarting(false);
        }
    };

    const handleToggleSignup = async (next: boolean) => {
        const previous = allowSignup;
        setAllowSignup(next); // optimistic — reverted below if the save fails
        try {
            setSignupSaving(true);
            setSignupError('');
            const { data } = await systemApi.updateRegistration(next);
            setAllowSignup(data.allowPublicRegistration);
        } catch (err: any) {
            setAllowSignup(previous);
            setSignupError(err.response?.data?.error || 'Failed to save registration setting');
        } finally {
            setSignupSaving(false);
        }
    };

    // The cap setting loads instantly; the usage measurement can take 30s+
    // on a large cache (docker system df enumerates every entry), so the two
    // are fetched separately — the cap field must never wait on docker.
    const fetchCapSetting = async () => {
        try {
            const { data } = await systemApi.getBuildCacheSettings();
            setCapInput(String(data.keepGB));
        } catch (err: any) {
            setCacheError(err.response?.data?.error || 'Failed to load build-cache settings');
        }
    };

    const fetchUsage = async () => {
        try {
            setCacheError('');
            const { data } = await systemApi.getBuildCache();
            setCache(data);
        } catch (err: any) {
            setCacheError(err.response?.data?.error || 'Failed to load build-cache info');
        }
    };

    useEffect(() => {
        fetchUsers();
        fetchRegistration();
        fetchCapSetting();
        fetchUsage();
        fetchUpdate();
    }, []);

    // While an update runs the API restarts, so requests will fail for a
    // stretch. That is expected — keep polling rather than surfacing it as an
    // error, and stop only once the phase is terminal.
    useEffect(() => {
        const phase = update?.state.phase;
        if (!phase || !RUNNING_PHASES.includes(phase)) {
            setStarting(false);
            return;
        }
        const timer = setInterval(() => {
            systemApi.getUpdate().then(({ data }) => setUpdate(data)).catch(() => { });
            systemApi.getUpdateLog().then(({ data }) => setUpdateLog(data.log)).catch(() => { });
        }, 2000);
        return () => clearInterval(timer);
    }, [update?.state.phase]);

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

    const handleSaveCap = async () => {
        const keepGB = Number(capInput);
        if (!Number.isInteger(keepGB) || keepGB < 0 || keepGB > 500) {
            setCacheError('Cap must be a whole number between 0 and 500');
            return;
        }
        try {
            setCapSaving(true);
            setCacheError('');
            setCacheMessage('');
            const { data } = await systemApi.updateBuildCache(keepGB);
            setCapInput(String(data.keepGB));
            setCacheMessage(keepGB === 0 ? 'Automatic pruning disabled' : `Cap saved: ${keepGB} GB`);
            // Refresh usage in the background — the save itself is done, and
            // the measurement must not hold the button on "Saving…".
            void fetchUsage();
        } catch (err: any) {
            setCacheError(err.response?.data?.error || 'Failed to save cap');
        } finally {
            setCapSaving(false);
        }
    };

    const handlePrune = async () => {
        try {
            setPruning(true);
            setCacheError('');
            setCacheMessage('');
            const { data } = await systemApi.pruneBuildCache();
            setCacheMessage(`Freed ${gb(data.freedBytes)} GB`);
            void fetchUsage();
        } catch (err: any) {
            setCacheError(err.response?.data?.error || 'Prune failed');
        } finally {
            setPruning(false);
        }
    };

    const handleApprove = async (id: string) => {
        try {
            await adminApi.approveUser(id);
            setUsers(prev => prev.map(u => u.id === id ? { ...u, isApproved: true } : u));
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
            setUsers(prev => prev.filter(u => u.id !== id));
        } catch (err: any) {
            alert(err.response?.data?.error || 'Failed to delete user');
        }
    };

    const handleOpenPerms = (user: UserDTO) => {
        const perms = user.permissions ?? DEFAULT_PERMISSIONS;
        setPermUser(user);
        setPermForm({ ...perms });
        setAllowedTypesStr(perms.allowedServerTypes ? perms.allowedServerTypes.join(', ') : '');
    };

    const handleSavePerms = async () => {
        if (!permUser) return;
        setPermSaving(true);
        try {
            const permsToSave: UserPermissions = {
                ...permForm,
                allowedServerTypes: allowedTypesStr.trim()
                    ? allowedTypesStr.split(',').map(s => s.trim()).filter(Boolean)
                    : null,
            };
            await adminApi.updateUserPermissions(permUser.id, permsToSave);
            setUsers(prev => prev.map(u => u.id === permUser.id ? { ...u, permissions: permsToSave } : u));
            setPermUser(null);
        } catch (err: any) {
            alert(err.response?.data?.error || 'Failed to update permissions');
        }
        setPermSaving(false);
    };

    return (
        <Layout>
            <div className="page-header">
                <h1>Admin Panel</h1>
            </div>
            <div className="page-content">
                {error && <div className="alert alert-error">{error}</div>}

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
                                                    {user.role !== 'admin' && (
                                                        <button
                                                            onClick={() => handleOpenPerms(user)}
                                                            className="btn btn-secondary"
                                                            style={{ padding: '6px 14px', fontSize: 13, gap: 6 }}
                                                        >
                                                            <Settings size={14} /> Permissions
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

                <div className="glass" style={{ padding: 24, borderRadius: 12, marginTop: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                        <Download size={20} className="text-primary" />
                        <h2 style={{ margin: 0 }}>System — Updates</h2>
                        {update && update.behind > 0 && (
                            <span className="badge" style={{ background: 'var(--accent)', color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: 12 }}>
                                {update.behind} available
                            </span>
                        )}
                    </div>

                    {updateError && <div className="alert alert-error">{updateError}</div>}
                    {update?.error && <div className="alert alert-error">Last check failed: {update.error}</div>}

                    {update ? (
                        <>
                            <p style={{ marginBottom: 12 }}>
                                Running <strong>{update.current || 'unknown'}</strong>
                                {update.checkedAt && (
                                    <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
                                        {' '}· checked {new Date(update.checkedAt).toLocaleString()}
                                    </span>
                                )}
                            </p>

                            {update.behind > 0 && (
                                <ul style={{ marginBottom: 16, paddingLeft: 20, color: 'var(--text-secondary)', fontSize: 14 }}>
                                    {update.commits.map(c => (
                                        <li key={c.sha}><code>{c.sha}</code> {c.subject}</li>
                                    ))}
                                </ul>
                            )}

                            {RUNNING_PHASES.includes(update.state.phase) && (
                                <div className="alert alert-info">
                                    Updating — phase: <strong>{update.state.phase}</strong>. The portal will be
                                    briefly unavailable while the service restarts.
                                </div>
                            )}
                            {update.state.phase === 'failed' && (
                                <div className="alert alert-error">
                                    Update failed: {update.state.error}
                                </div>
                            )}
                            {update.state.phase === 'failed_rollback' && (
                                <div className="alert alert-error">
                                    Update failed AND rollback failed: {update.state.error}. This instance needs
                                    attention on the server.
                                </div>
                            )}
                        </>
                    ) : !updateError && (
                        <p style={{ color: 'var(--text-secondary)' }}>Loading update status…</p>
                    )}

                    {/* Always rendered, even when the first fetch failed or is still
                        pending — "Check now" is the only way to recover in place
                        without a manual page reload. "Update now" stays disabled
                        with nothing to act on until `update` is known. */}
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary" onClick={handleCheckUpdate} disabled={checking}>
                            <RefreshCw size={16} /> {checking ? 'Checking…' : 'Check now'}
                        </button>
                        <button
                            className="btn btn-primary"
                            onClick={handleStartUpdate}
                            disabled={!update || starting || update.behind === 0 || RUNNING_PHASES.includes(update.state.phase)}
                        >
                            {starting ? 'Starting…' : 'Update now'}
                        </button>
                    </div>

                    {update && updateLog && (
                        <pre style={{ marginTop: 16, maxHeight: 260, overflow: 'auto', fontSize: 12, background: 'rgba(0,0,0,0.3)', padding: 12, borderRadius: 8 }}>
                            {updateLog}
                        </pre>
                    )}
                </div>

                <div className="glass" style={{ padding: 24, borderRadius: 12, marginTop: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                        <UserPlus size={20} className="text-primary" />
                        <h2 style={{ margin: 0 }}>System — Registration</h2>
                    </div>

                    {signupError && <div className="alert alert-error">{signupError}</div>}

                    <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <input
                            type="checkbox"
                            checked={allowSignup === true}
                            disabled={allowSignup === null || signupSaving}
                            onChange={(e) => handleToggleSignup(e.target.checked)}
                        />
                        <span>Allow anyone to create an account</span>
                    </label>
                    <p style={{ marginTop: 10, marginBottom: 0, color: 'var(--text-secondary)', fontSize: 14 }}>
                        {allowSignup
                            ? 'Signup is open — anyone on the internet can register. New accounts still need your approval above before they can do anything.'
                            : 'Signup is closed. The register page and OAuth sign-in will both refuse to create new accounts.'}
                    </p>
                </div>

                <div className="glass" style={{ padding: 24, borderRadius: 12, marginTop: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                        <HardDrive size={20} className="text-primary" />
                        <h2 style={{ margin: 0 }}>System — Build Cache</h2>
                    </div>

                    {cacheError && <div className="alert alert-error">{cacheError}</div>}
                    {cacheMessage && <div className="alert alert-success">{cacheMessage}</div>}

                    {cache ? (
                        <p style={{ marginBottom: 16 }}>
                            Current usage: <strong>{gb(cache.usageBytes)} GB</strong>
                            {' '}(daemon {gb(cache.daemonBytes)} GB, buildkit {gb(cache.buildkitBytes)} GB)
                        </p>
                    ) : !cacheError && (
                        <p style={{ marginBottom: 16, color: 'var(--text-secondary)' }}>
                            Measuring cache usage… (can take a minute on a large cache)
                        </p>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <label htmlFor="cache-cap">Cap (GB, 0 = disabled):</label>
                        <input
                            id="cache-cap"
                            className="form-input"
                            type="number"
                            min={0}
                            max={500}
                            value={capInput}
                            onChange={(e) => setCapInput(e.target.value)}
                            style={{ width: 110 }}
                        />
                        <button className="btn btn-primary" onClick={handleSaveCap} disabled={capSaving}>
                            {capSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button className="btn btn-secondary" onClick={handlePrune} disabled={pruning}>
                            {pruning ? 'Pruning…' : 'Prune now'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Permissions Modal */}
            {permUser && (
                <div className="modal-overlay" onClick={() => setPermUser(null)}>
                    <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                        <h2>Permissions for {permUser.username}</h2>

                        <div className="form-group" style={{ marginTop: 16 }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input
                                    type="checkbox"
                                    checked={permForm.canCreateProjects}
                                    onChange={(e) => setPermForm({ ...permForm, canCreateProjects: e.target.checked })}
                                />
                                Can Create Projects
                            </label>
                        </div>

                        <div className="form-group">
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input
                                    type="checkbox"
                                    checked={permForm.canUseCustomDomains}
                                    onChange={(e) => setPermForm({ ...permForm, canUseCustomDomains: e.target.checked })}
                                />
                                Can Use Custom Domains
                            </label>
                        </div>

                        <div className="form-group">
                            <label>Max Projects (leave empty for unlimited)</label>
                            <input
                                className="form-input"
                                type="number"
                                min="0"
                                placeholder="Unlimited"
                                value={permForm.maxProjects ?? ''}
                                onChange={(e) => setPermForm({
                                    ...permForm,
                                    maxProjects: e.target.value === '' ? null : parseInt(e.target.value),
                                })}
                            />
                        </div>

                        <div className="form-group">
                            <label>Allowed Server Types (comma-separated, empty for all)</label>
                            <input
                                className="form-input"
                                placeholder="e.g. static, app, caddy"
                                value={allowedTypesStr}
                                onChange={(e) => setAllowedTypesStr(e.target.value)}
                            />
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                Available: static, app, caddy, nginx, apache
                            </p>
                        </div>

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setPermUser(null)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleSavePerms} disabled={permSaving}>
                                {permSaving ? <span className="spinner" /> : 'Save Permissions'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
