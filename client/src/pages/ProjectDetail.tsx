import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/projectStore';
import { projectsApi, type Project } from '../api/projects';
import Layout from '../components/Layout';
import StatusBadge from '../components/StatusBadge';
import FileBrowser from '../components/FileBrowser';
import LogViewer from '../components/LogViewer';
import { usePageTitle } from '../hooks/usePageTitle';
import {
    ArrowLeft, Play, Square, RotateCcw, Trash2, Globe,
    FolderGit2, Plus, CheckCircle2, XCircle, ExternalLink
} from 'lucide-react';

export default function ProjectDetail() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { currentProject, fetchProject, deleteProject } = useProjectStore();
    usePageTitle(currentProject ? currentProject.name : 'Project Details');
    const [tab, setTab] = useState<'overview' | 'files' | 'github' | 'domains' | 'logs' | 'settings'>('overview');
    const [actionLoading, setActionLoading] = useState('');

    // GitHub connect state
    const [showGithub, setShowGithub] = useState(false);
    const [repoUrl, setRepoUrl] = useState('');
    const [branch, setBranch] = useState('main');
    const [githubError, setGithubError] = useState('');

    // Domain state
    const [showAddDomain, setShowAddDomain] = useState(false);
    const [newDomain, setNewDomain] = useState('');
    const [domainError, setDomainError] = useState('');
    const [domains, setDomains] = useState<any[]>([]);

    // Delete state
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // Settings state
    const [buildCommand, setBuildCommand] = useState('');
    const [startCommand, setStartCommand] = useState('');
    const [envVars, setEnvVars] = useState<{ key: string, value: string }[]>([]);
    const [saveLoading, setSaveLoading] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    useEffect(() => {
        if (id) {
            fetchProject(id).then((res) => {
                const p = res as Project;
                if (p) {
                    setBuildCommand(p.buildCommand || '');
                    setStartCommand(p.startCommand || '');
                    const envs = Object.entries(p.envVars || {}).map(([key, value]) => ({ key, value: String(value) }));
                    setEnvVars(envs.length > 0 ? envs : [{ key: '', value: '' }]);
                }
            });
        }
    }, [id]);

    useEffect(() => {
        if (id && tab === 'domains') loadDomains();
    }, [id, tab]);

    const loadDomains = async () => {
        if (!id) return;
        try {
            const { data } = await projectsApi.listDomains(id);
            setDomains(data);
        } catch { }
    };

    const handleAction = async (action: 'start' | 'stop' | 'restart') => {
        if (!id) return;
        setActionLoading(action);
        try {
            await projectsApi[action](id);
            await fetchProject(id);
        } catch { }
        setActionLoading('');
    };

    const handleDelete = async () => {
        if (!id) return;
        try {
            await deleteProject(id);
            navigate('/');
        } catch { }
        setShowDeleteConfirm(false);
    };

    const handleGithubConnect = async () => {
        if (!id) return;
        setGithubError('');
        try {
            await projectsApi.connectGithub(id, repoUrl, branch);
            setShowGithub(false);
            setRepoUrl('');
            fetchProject(id);
        } catch (err: any) {
            setGithubError(err.response?.data?.error || 'Failed to connect');
        }
    };

    const handleGithubDisconnect = async () => {
        if (!id || !confirm('Disconnect GitHub repo?')) return;
        try {
            await projectsApi.disconnectGithub(id);
            fetchProject(id);
        } catch { }
    };

    const handleAddDomain = async () => {
        if (!id) return;
        setDomainError('');
        try {
            await projectsApi.addDomain(id, newDomain);
            setShowAddDomain(false);
            setNewDomain('');
            loadDomains();
        } catch (err: any) {
            setDomainError(err.response?.data?.error || 'Failed to add domain');
        }
    };

    const handleVerifyDomain = async (domainId: string) => {
        if (!id) return;
        try {
            const { data } = await projectsApi.verifyDomain(id, domainId);
            if (data.verified) {
                loadDomains();
            } else {
                alert('DNS not yet propagated. Please try again in a few minutes.');
            }
        } catch { }
    };

    const handleRemoveDomain = async (domainId: string) => {
        if (!id || !confirm('Remove this domain?')) return;
        try {
            await projectsApi.removeDomain(id, domainId);
            loadDomains();
        } catch { }
    };

    const handleSaveSettings = async () => {
        if (!id) return;
        setSaveLoading(true);
        setSaveSuccess(false);
        try {
            const envObj = envVars.reduce((acc, { key, value }) => {
                if (key.trim()) acc[key.trim()] = value;
                return acc;
            }, {} as Record<string, string>);

            await projectsApi.update(id, {
                buildCommand,
                startCommand,
                envVars: envObj
            });
            await fetchProject(id);
            setSaveSuccess(true);
            setTimeout(() => setSaveSuccess(false), 3000);
        } catch (err) {
            alert('Failed to save settings');
        }
        setSaveLoading(false);
    };

    const addEnvVar = () => setEnvVars([...envVars, { key: '', value: '' }]);
    const removeEnvVar = (index: number) => setEnvVars(envVars.filter((_, i) => i !== index));
    const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
        const newEnvs = [...envVars];
        newEnvs[index][field] = value;
        setEnvVars(newEnvs);
    };

    if (!currentProject) {
        return (
            <Layout>
                <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
                    <div className="spinner" style={{ width: 40, height: 40 }} />
                </div>
            </Layout>
        );
    }

    const p = currentProject;

    return (
        <Layout>
            <div className="page-header">
                <div className="detail-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <button className="btn-icon" onClick={() => navigate('/')}>
                            <ArrowLeft size={20} />
                        </button>
                        <div>
                            <h1>{p.name}</h1>
                            <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                                {p.subdomain}.{import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'}
                            </span>
                        </div>
                        <StatusBadge status={p.status} />
                    </div>
                    <div className="detail-actions">
                        <button className="btn btn-secondary" onClick={() => handleAction('start')} disabled={p.status === 'running' || !!actionLoading}>
                            {actionLoading === 'start' ? <span className="spinner" /> : <Play size={16} />} Start
                        </button>
                        <button className="btn btn-secondary" onClick={() => handleAction('stop')} disabled={p.status === 'stopped' || !!actionLoading}>
                            {actionLoading === 'stop' ? <span className="spinner" /> : <Square size={16} />} Stop
                        </button>
                        <button className="btn btn-secondary" onClick={() => handleAction('restart')} disabled={!!actionLoading}>
                            {actionLoading === 'restart' ? <span className="spinner" /> : <RotateCcw size={16} />} Restart
                        </button>
                        <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
                            <Trash2 size={16} />
                        </button>
                    </div>
                </div>
            </div>

            <div className="page-content">
                <div className="tabs">
                    {(['overview', 'files', 'github', 'domains', 'logs', 'settings'] as const).map((t) => (
                        <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                        </button>
                    ))}
                </div>

                {/* OVERVIEW TAB */}
                {tab === 'overview' && (
                    <div className="info-grid">
                        <div className="info-card glass">
                            <div className="info-card-label">Status</div>
                            <StatusBadge status={p.status} />
                        </div>
                        <div className="info-card glass">
                            <div className="info-card-label">Server Type</div>
                            <div className="info-card-value">{p.serverType.toUpperCase()}</div>
                        </div>
                        <div className="info-card glass">
                            <div className="info-card-label">URL</div>
                            <div className="info-card-value">
                                <a href={`http://${p.subdomain}.${import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'}`} target="_blank" rel="noopener" style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {p.subdomain}.{import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'} <ExternalLink size={14} />
                                </a>
                            </div>
                        </div>
                        <div className="info-card glass">
                            <div className="info-card-label">Port</div>
                            <div className="info-card-value">{p.port || 'N/A'}</div>
                        </div>
                        <div className="info-card glass">
                            <div className="info-card-label">Directory</div>
                            <div className="info-card-value" style={{ fontSize: 13 }}>{p.directoryPath}</div>
                        </div>
                        <div className="info-card glass">
                            <div className="info-card-label">Created</div>
                            <div className="info-card-value" style={{ fontSize: 14 }}>{new Date(p.createdAt).toLocaleDateString()}</div>
                        </div>
                    </div>
                )}

                {/* FILES TAB */}
                {tab === 'files' && <FileBrowser projectId={p.id} />}

                {/* GITHUB TAB */}
                {tab === 'github' && (
                    <div>
                        {p.githubRepo ? (
                            <div className="github-section glass">
                                <div className="github-info">
                                    <div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                            <FolderGit2 size={20} />
                                            <span style={{ fontWeight: 600, fontSize: 16 }}>Connected</span>
                                        </div>
                                        <div className="github-repo-url">{p.githubRepo.repoUrl}</div>
                                        <div className="github-branch">Branch: {p.githubRepo.branch}</div>
                                        {p.githubRepo.lastDeployAt && (
                                            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                                                Last deployed: {new Date(p.githubRepo.lastDeployAt).toLocaleString()}
                                            </div>
                                        )}
                                    </div>
                                    <button className="btn btn-danger" onClick={handleGithubDisconnect}>Disconnect</button>
                                </div>
                            </div>
                        ) : (
                            <div className="empty-state">
                                <div className="empty-state-icon">
                                    <FolderGit2 size={36} />
                                </div>
                                <h2>No GitHub repo connected</h2>
                                <p>Connect a repo to auto-deploy on push to main</p>
                                <button className="btn btn-primary" onClick={() => setShowGithub(true)}>
                                    <FolderGit2 size={18} /> Connect Repository
                                </button>
                            </div>
                        )}

                        {showGithub && (
                            <div className="modal-overlay" onClick={() => setShowGithub(false)}>
                                <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                                    <h2>Connect GitHub Repository</h2>
                                    {githubError && <div className="alert alert-error">{githubError}</div>}
                                    <div className="form-group">
                                        <label>Repository URL</label>
                                        <input className="form-input" placeholder="https://github.com/user/repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
                                    </div>
                                    <div className="form-group">
                                        <label>Branch</label>
                                        <input className="form-input" value={branch} onChange={(e) => setBranch(e.target.value)} />
                                    </div>
                                    <div className="alert alert-info">
                                        Ensure your GitHub account is connected via OAuth for private repos and webhook setup.
                                    </div>
                                    <div className="modal-actions">
                                        <button className="btn btn-secondary" onClick={() => setShowGithub(false)}>Cancel</button>
                                        <button className="btn btn-primary" onClick={handleGithubConnect} disabled={!repoUrl}>Connect</button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* DOMAINS TAB */}
                {tab === 'domains' && (
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
                            <h3>Custom Domains</h3>
                            <button className="btn btn-primary" onClick={() => setShowAddDomain(true)}>
                                <Plus size={16} /> Add Domain
                            </button>
                        </div>

                        {domains.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-state-icon"><Globe size={36} /></div>
                                <h2>No custom domains</h2>
                                <p>Add your own domain to serve this project</p>
                            </div>
                        ) : (
                            domains.map((d: any) => (
                                <div key={d.id} className="domain-item glass">
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{d.domain}</div>
                                        <div className="domain-status">
                                            {d.verified ? (
                                                <span style={{ color: 'var(--status-running)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <CheckCircle2 size={14} /> Verified
                                                </span>
                                            ) : (
                                                <span style={{ color: 'var(--status-deploying)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <XCircle size={14} /> Pending verification
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        {!d.verified && (
                                            <button className="btn btn-secondary" onClick={() => handleVerifyDomain(d.id)} style={{ fontSize: 13, padding: '6px 12px' }}>
                                                Verify
                                            </button>
                                        )}
                                        <button className="btn btn-danger" onClick={() => handleRemoveDomain(d.id)} style={{ fontSize: 13, padding: '6px 12px' }}>
                                            Remove
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}

                        {showAddDomain && (
                            <div className="modal-overlay" onClick={() => setShowAddDomain(false)}>
                                <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                                    <h2>Add Custom Domain</h2>
                                    {domainError && <div className="alert alert-error">{domainError}</div>}
                                    <div className="form-group">
                                        <label>Domain</label>
                                        <input className="form-input" placeholder="mysite.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} />
                                    </div>
                                    <div className="alert alert-info">
                                        After adding, you'll need to set up a CNAME record pointing to <strong>{p.subdomain}.{import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'}</strong>
                                    </div>
                                    <div className="modal-actions">
                                        <button className="btn btn-secondary" onClick={() => setShowAddDomain(false)}>Cancel</button>
                                        <button className="btn btn-primary" onClick={handleAddDomain} disabled={!newDomain}>Add Domain</button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* LOGS TAB */}
                {tab === 'logs' && <LogViewer projectId={p.id} />}

                {/* SETTINGS TAB */}
                {tab === 'settings' && (
                    <div className="settings-section glass">
                        <div style={{ maxWidth: 700 }}>
                            <h3 style={{ marginBottom: 20 }}>Project Configuration</h3>

                            <div className="form-group">
                                <label>Build Command</label>
                                <input
                                    className="form-input"
                                    placeholder="e.g. npm run build && npx tsc"
                                    value={buildCommand}
                                    onChange={(e) => setBuildCommand(e.target.value)}
                                />
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                    Executed in the project root before Railpack packaging.
                                </p>
                            </div>

                            <div className="form-group">
                                <label>Start Command Override</label>
                                <input
                                    className="form-input"
                                    placeholder="e.g. npx tsx server/index.ts"
                                    value={startCommand}
                                    onChange={(e) => setStartCommand(e.target.value)}
                                />
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                    Override the default container start behavior.
                                </p>
                            </div>

                            <div className="form-group">
                                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    Environment Variables
                                    <button className="btn btn-secondary" onClick={addEnvVar} style={{ padding: '4px 8px', fontSize: 12 }}>
                                        <Plus size={14} /> Add Variable
                                    </button>
                                </label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                                    {envVars.map((env, index) => (
                                        <div key={index} style={{ display: 'flex', gap: 8 }}>
                                            <input
                                                className="form-input"
                                                style={{ flex: 1 }}
                                                placeholder="KEY"
                                                value={env.key}
                                                onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                                            />
                                            <input
                                                className="form-input"
                                                style={{ flex: 1 }}
                                                placeholder="VALUE"
                                                value={env.value}
                                                onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                                            />
                                            <button className="btn btn-danger" onClick={() => removeEnvVar(index)} style={{ padding: 8 }}>
                                                <XCircle size={16} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', gap: 16 }}>
                                <button className="btn btn-primary" onClick={handleSaveSettings} disabled={saveLoading}>
                                    {saveLoading ? <span className="spinner" /> : 'Save Settings'}
                                </button>
                                {saveSuccess && (
                                    <span style={{ color: 'var(--status-running)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}>
                                        <CheckCircle2 size={16} /> Saved Successfully
                                    </span>
                                )}
                            </div>

                            <div style={{ marginTop: 40, paddingTop: 30, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                                <h3 style={{ marginBottom: 10 }}>Advanced Server Controls</h3>
                                <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
                                    If your project is not accessible via its subdomain, you can force the system to regenerate its proxy configuration.
                                </p>
                                <button
                                    className="btn btn-secondary"
                                    onClick={async () => {
                                        try {
                                            await projectsApi.reloadProxy(p.id);
                                            alert('Proxy configuration regenerated and Caddy reloaded successfully.');
                                        } catch (err: any) {
                                            alert(err.response?.data?.error || 'Failed to reload proxy configuration.');
                                        }
                                    }}
                                >
                                    <Globe size={16} /> Regenerate Proxy Config
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* DELETE CONFIRMATION MODAL */}
            {showDeleteConfirm && (
                <div className="modal-overlay" onClick={() => setShowDeleteConfirm(false)}>
                    <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                        <h2>Delete Project</h2>
                        <div className="alert alert-error" style={{ marginTop: '16px', marginBottom: '16px' }}>
                            Are you sure you want to delete <strong>{p.name}</strong>? This action cannot be undone and will permanently erase all files and configurations.
                        </div>
                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
                            <button className="btn btn-danger" onClick={handleDelete}>Yes, Delete Project</button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
