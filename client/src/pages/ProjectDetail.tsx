import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/projectStore';
import { projectsApi, type Project, type Collaborator, type ProjectPermissions } from '../api/projects';
import { useAuthStore } from '../store/authStore';
import Layout from '../components/Layout';
import StatusBadge from '../components/StatusBadge';
import FileBrowser from '../components/FileBrowser';
import LogViewer from '../components/LogViewer';
import { usePageTitle } from '../hooks/usePageTitle';
import {
    ArrowLeft, Play, Square, RotateCcw, Trash2, Globe,
    FolderGit2, Plus, CheckCircle2, XCircle, ExternalLink, Link, Edit, Users, UserPlus
} from 'lucide-react';

const DEFAULT_COLLAB_PERMS: ProjectPermissions = {
    canStart: false,
    canEditConfig: false,
    canEditDomains: false,
    canEditFiles: false,
    canDelete: false,
    canViewLogs: true,
    canViewFiles: true,
    canViewDomains: true,
    canViewGithub: true,
    canViewSettings: true,
};

export default function ProjectDetail() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { currentProject, fetchProject, deleteProject } = useProjectStore();
    const { user: currentUser } = useAuthStore();
    usePageTitle(currentProject ? currentProject.name : 'Project Details');
    const [tab, setTab] = useState<'overview' | 'files' | 'github' | 'domains' | 'logs' | 'settings' | 'collaborators'>('overview');
    const [actionLoading, setActionLoading] = useState('');

    // GitHub connect state
    const [showGithub, setShowGithub] = useState(false);
    const [repoUrl, setRepoUrl] = useState('');
    const [branch, setBranch] = useState('main');
    const [githubError, setGithubError] = useState('');

    // Domain state
    const [showAddDomain, setShowAddDomain] = useState(false);
    const [newDomain, setNewDomain] = useState('');
    const [newRedirectTarget, setNewRedirectTarget] = useState('');
    const [domainError, setDomainError] = useState('');
    const [domains, setDomains] = useState<any[]>([]);

    // Edit Redirect state
    const [showEditRedirect, setShowEditRedirect] = useState(false);
    const [editingDomain, setEditingDomain] = useState<any>(null);
    const [editRedirectTarget, setEditRedirectTarget] = useState('');

    // Delete state
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    // Settings state
    const [buildCommand, setBuildCommand] = useState('');
    const [startCommand, setStartCommand] = useState('');
    const [envVars, setEnvVars] = useState<{ key: string, value: string }[]>([]);
    const [envVarsTextMode, setEnvVarsTextMode] = useState(false);
    const [envVarsText, setEnvVarsText] = useState('');
    const [saveLoading, setSaveLoading] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);
    // Compose settings state
    const [useCompose, setUseCompose] = useState(false);
    const [composeFile, setComposeFile] = useState('docker-compose.yml');
    const [composeService, setComposeService] = useState('');
    const [internalPort, setInternalPort] = useState<string>('');

    // Collaborator state
    const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
    const [collabLoading, setCollabLoading] = useState(false);
    const [showAddCollab, setShowAddCollab] = useState(false);
    const [collabEmail, setCollabEmail] = useState('');
    const [collabPerms, setCollabPerms] = useState<ProjectPermissions>({ ...DEFAULT_COLLAB_PERMS });
    const [collabError, setCollabError] = useState('');
    const [editingCollab, setEditingCollab] = useState<Collaborator | null>(null);
    const [editCollabPerms, setEditCollabPerms] = useState<ProjectPermissions>({ ...DEFAULT_COLLAB_PERMS });

    // Compute permissions for current user on this project
    const isOwner = currentProject?.userId === currentUser?.id;
    const isAdmin = currentUser?.role === 'admin';
    const isCollaborator = !!(currentProject as any)?._isCollaborator;
    const collabPermissions: ProjectPermissions = (currentProject as any)?._permissions ?? DEFAULT_COLLAB_PERMS;

    const canStart = isOwner || isAdmin || collabPermissions.canStart;
    const canEditConfig = isOwner || isAdmin || collabPermissions.canEditConfig;
    const canEditDomains = isOwner || isAdmin || collabPermissions.canEditDomains;
    const canEditFiles = isOwner || isAdmin || collabPermissions.canEditFiles;
    const canDelete = isOwner || isAdmin || collabPermissions.canDelete;
    const canViewLogs = isOwner || isAdmin || collabPermissions.canViewLogs;
    const canViewFiles = isOwner || isAdmin || collabPermissions.canViewFiles;
    const canViewDomains = isOwner || isAdmin || collabPermissions.canViewDomains;
    const canViewGithub = isOwner || isAdmin || collabPermissions.canViewGithub;
    const canViewSettings = isOwner || isAdmin || collabPermissions.canViewSettings;
    const canManageCollaborators = isOwner || isAdmin;

    useEffect(() => {
        if (id) {
            fetchProject(id).then((res) => {
                const p = res as Project;
                if (p) {
                    setBuildCommand(p.buildCommand || '');
                    setStartCommand(p.startCommand || '');
                    const envs = Object.entries(p.envVars || {}).map(([key, value]) => ({ key, value: String(value) }));
                    setEnvVars(envs.length > 0 ? envs : [{ key: '', value: '' }]);
                    setUseCompose(p.useCompose || false);
                    setComposeFile(p.composeFile || 'docker-compose.yml');
                    setComposeService(p.composeService || '');
                    setInternalPort(p.internalPort != null ? String(p.internalPort) : '');
                }
            });
        }
    }, [id]);

    useEffect(() => {
        if (id && tab === 'domains') loadDomains();
        if (id && tab === 'collaborators') loadCollaborators();
    }, [id, tab]);

    const loadDomains = async () => {
        if (!id) return;
        try {
            const { data } = await projectsApi.listDomains(id);
            setDomains(data);
        } catch { }
    };

    const loadCollaborators = async () => {
        if (!id) return;
        setCollabLoading(true);
        try {
            const { data } = await projectsApi.listCollaborators(id);
            setCollaborators(data);
        } catch { }
        setCollabLoading(false);
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
            await projectsApi.addDomain(id, newDomain, newRedirectTarget || undefined);
            setShowAddDomain(false);
            setNewDomain('');
            setNewRedirectTarget('');
            loadDomains();
        } catch (err: any) {
            setDomainError(err.response?.data?.error || 'Failed to add domain');
        }
    };

    const handleEditRedirect = async () => {
        if (!id || !editingDomain) return;
        setDomainError('');
        try {
            await projectsApi.updateDomainRedirect(id, editingDomain.id, editRedirectTarget || null);
            setShowEditRedirect(false);
            setEditingDomain(null);
            setEditRedirectTarget('');
            loadDomains();
        } catch (err: any) {
            setDomainError(err.response?.data?.error || 'Failed to update redirect');
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
            const envSource = envVarsTextMode ? envTextToArray(envVarsText) : envVars;
            if (envVarsTextMode) setEnvVars(envSource);
            const envObj = envSource.reduce((acc, { key, value }) => {
                if (key.trim()) acc[key.trim()] = value;
                return acc;
            }, {} as Record<string, string>);

            const trimmedPort = internalPort.trim();
            const parsedPort = trimmedPort === '' ? undefined : Number(trimmedPort);
            if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
                alert('Internal Port must be an integer between 1 and 65535');
                setSaveLoading(false);
                return;
            }

            await projectsApi.update(id, {
                buildCommand,
                startCommand,
                envVars: envObj,
                useCompose,
                composeFile: composeFile || 'docker-compose.yml',
                composeService,
                ...(parsedPort !== undefined ? { internalPort: parsedPort } : {}),
            });
            await fetchProject(id);
            setSaveSuccess(true);
            setTimeout(() => setSaveSuccess(false), 3000);
        } catch (err) {
            alert('Failed to save settings');
        }
        setSaveLoading(false);
    };

    const handleAddCollaborator = async () => {
        if (!id) return;
        setCollabError('');
        try {
            await projectsApi.addCollaborator(id, collabEmail, collabPerms);
            setShowAddCollab(false);
            setCollabEmail('');
            setCollabPerms({ ...DEFAULT_COLLAB_PERMS });
            loadCollaborators();
        } catch (err: any) {
            setCollabError(err.response?.data?.error || 'Failed to add collaborator');
        }
    };

    const handleUpdateCollaborator = async () => {
        if (!id || !editingCollab) return;
        setCollabError('');
        try {
            await projectsApi.updateCollaborator(id, editingCollab.userId, editCollabPerms);
            setEditingCollab(null);
            loadCollaborators();
        } catch (err: any) {
            setCollabError(err.response?.data?.error || 'Failed to update collaborator');
        }
    };

    const handleRemoveCollaborator = async (userId: string) => {
        if (!id || !confirm('Remove this collaborator?')) return;
        try {
            await projectsApi.removeCollaborator(id, userId);
            loadCollaborators();
        } catch { }
    };

    const addEnvVar = () => setEnvVars([...envVars, { key: '', value: '' }]);
    const removeEnvVar = (index: number) => setEnvVars(envVars.filter((_, i) => i !== index));
    const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
        const newEnvs = [...envVars];
        newEnvs[index][field] = value;
        setEnvVars(newEnvs);
    };

    const envArrayToText = (arr: { key: string, value: string }[]) =>
        arr.filter(e => e.key.trim()).map(e => `${e.key.trim()}=${e.value}`).join('\n');

    const envTextToArray = (text: string): { key: string, value: string }[] => {
        const result: { key: string, value: string }[] = [];
        for (const rawLine of text.split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) {
                result.push({ key: line, value: '' });
                continue;
            }
            let value = line.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            result.push({ key: line.slice(0, eq).trim(), value });
        }
        return result;
    };

    const toggleEnvVarsTextMode = () => {
        if (envVarsTextMode) {
            setEnvVars(envTextToArray(envVarsText));
            setEnvVarsTextMode(false);
        } else {
            setEnvVarsText(envArrayToText(envVars));
            setEnvVarsTextMode(true);
        }
    };

    const PermCheckbox = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            {label}
        </label>
    );

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

    // Build tabs list based on permissions
    const availableTabs: typeof tab[] = ['overview'];
    if (canViewFiles || canEditFiles) availableTabs.push('files');
    if (canViewGithub) availableTabs.push('github');
    if (canViewDomains || canEditDomains) availableTabs.push('domains');
    if (canViewLogs) availableTabs.push('logs');
    if (canViewSettings || canEditConfig) availableTabs.push('settings');
    if (canManageCollaborators) availableTabs.push('collaborators');

    return (
        <Layout>
            <div className="page-header">
                <div className="detail-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <button className="btn-icon" onClick={() => navigate('/')}>
                            <ArrowLeft size={20} />
                        </button>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <h1>{p.name}</h1>
                                {isCollaborator && (
                                    <span style={{
                                        padding: '2px 8px',
                                        borderRadius: 12,
                                        fontSize: 11,
                                        background: 'rgba(100, 180, 255, 0.15)',
                                        color: '#64b4ff',
                                    }}>
                                        Shared
                                    </span>
                                )}
                            </div>
                            <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>
                                {p.subdomain}.{import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'}
                            </span>
                        </div>
                        <StatusBadge status={p.status} />
                    </div>
                    <div className="detail-actions">
                        {canStart && (
                            <>
                                <button className="btn btn-secondary" onClick={() => handleAction('start')} disabled={p.status === 'running' || !!actionLoading}>
                                    {actionLoading === 'start' ? <span className="spinner" /> : <Play size={16} />} Start
                                </button>
                                <button className="btn btn-secondary" onClick={() => handleAction('stop')} disabled={p.status === 'stopped' || !!actionLoading}>
                                    {actionLoading === 'stop' ? <span className="spinner" /> : <Square size={16} />} Stop
                                </button>
                                <button className="btn btn-secondary" onClick={() => handleAction('restart')} disabled={!!actionLoading}>
                                    {actionLoading === 'restart' ? <span className="spinner" /> : <RotateCcw size={16} />} Restart
                                </button>
                            </>
                        )}
                        {canDelete && (
                            <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
                                <Trash2 size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="page-content">
                <div className="tabs">
                    {availableTabs.map((t) => (
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
                {tab === 'files' && <FileBrowser projectId={p.id} readOnly={!canEditFiles} />}

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
                                    {canEditConfig && <button className="btn btn-danger" onClick={handleGithubDisconnect}>Disconnect</button>}
                                </div>
                            </div>
                        ) : (
                            <div className="empty-state">
                                <div className="empty-state-icon">
                                    <FolderGit2 size={36} />
                                </div>
                                <h2>No GitHub repo connected</h2>
                                <p>Connect a repo to auto-deploy on push to main</p>
                                {canEditConfig && (
                                    <button className="btn btn-primary" onClick={() => setShowGithub(true)}>
                                        <FolderGit2 size={18} /> Connect Repository
                                    </button>
                                )}
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
                            {canEditDomains && (
                                <button className="btn btn-primary" onClick={() => setShowAddDomain(true)}>
                                    <Plus size={16} /> Add Domain
                                </button>
                            )}
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
                                        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                                            {d.domain}
                                            {d.redirectTarget && (
                                                <span className="badge badge-info" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                                                    <Link size={12} /> Redirects to {d.redirectTarget}
                                                </span>
                                            )}
                                        </div>
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
                                    {canEditDomains && (
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button
                                                className="btn btn-secondary"
                                                onClick={() => {
                                                    setEditingDomain(d);
                                                    setEditRedirectTarget(d.redirectTarget || '');
                                                    setShowEditRedirect(true);
                                                    setDomainError('');
                                                }}
                                                style={{ fontSize: 13, padding: '6px 12px' }}
                                            >
                                                <Edit size={14} style={{ marginRight: 4 }} /> Redirect
                                            </button>
                                            {!d.verified && (
                                                <button className="btn btn-secondary" onClick={() => handleVerifyDomain(d.id)} style={{ fontSize: 13, padding: '6px 12px' }}>
                                                    Verify
                                                </button>
                                            )}
                                            <button className="btn btn-danger" onClick={() => handleRemoveDomain(d.id)} style={{ fontSize: 13, padding: '6px 12px' }}>
                                                Remove
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}

                        {showEditRedirect && editingDomain && (
                            <div className="modal-overlay" onClick={() => setShowEditRedirect(false)}>
                                <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                                    <h2>Redirect Target for {editingDomain.domain}</h2>
                                    {domainError && <div className="alert alert-error">{domainError}</div>}
                                    <div className="form-group">
                                        <label>Target Domain (Optional)</label>
                                        <input
                                            className="form-input"
                                            placeholder="e.g. example.com"
                                            value={editRedirectTarget}
                                            onChange={(e) => setEditRedirectTarget(e.target.value)}
                                        />
                                        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                            Leave empty to disable redirection and serve the project normally. Do not include http:// or https://
                                        </p>
                                    </div>
                                    <div className="modal-actions">
                                        <button className="btn btn-secondary" onClick={() => setShowEditRedirect(false)}>Cancel</button>
                                        <button className="btn btn-primary" onClick={handleEditRedirect}>Save Redirect</button>
                                    </div>
                                </div>
                            </div>
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
                                    <div className="form-group">
                                        <label>Redirect Target (Optional)</label>
                                        <input className="form-input" placeholder="e.g. anothersite.com" value={newRedirectTarget} onChange={(e) => setNewRedirectTarget(e.target.value)} />
                                        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>If set, traffic to this domain will redirect to the target domain.</p>
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
                {tab === 'settings' && (canEditConfig || canViewSettings) && (
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
                                    disabled={!canEditConfig}
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
                                    disabled={!canEditConfig}
                                />
                                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                    Override the default container start behavior.
                                </p>
                            </div>

                            {/* ── COMPOSE SETTINGS (APP projects only) ─────────────── */}
                            {p.serverType === 'app' && (
                                <div style={{ marginTop: 24, padding: '16px 20px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                                        <label style={{ fontWeight: 600, fontSize: 14, margin: 0 }}>Docker Compose Mode</label>
                                        <input
                                            type="checkbox"
                                            checked={useCompose}
                                            onChange={(e) => setUseCompose(e.target.checked)}
                                            disabled={!canEditConfig}
                                            style={{ width: 16, height: 16, cursor: canEditConfig ? 'pointer' : 'default' }}
                                        />
                                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                            Enable to deploy with <code>docker compose</code> instead of Railpack
                                        </span>
                                    </div>

                                    {useCompose && (
                                        <>
                                            <div className="form-group" style={{ marginBottom: 12 }}>
                                                <label style={{ fontSize: 13 }}>Compose File</label>
                                                <input
                                                    className="form-input"
                                                    placeholder="docker-compose.yml"
                                                    value={composeFile}
                                                    onChange={(e) => setComposeFile(e.target.value)}
                                                    disabled={!canEditConfig}
                                                />
                                                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                    Path to the compose file, relative to the project root.
                                                </p>
                                            </div>
                                            <div className="form-group" style={{ marginBottom: 12 }}>
                                                <label style={{ fontSize: 13 }}>
                                                    Primary Service <span style={{ color: 'var(--status-error)' }}>*</span>
                                                </label>
                                                <input
                                                    className="form-input"
                                                    placeholder="e.g. web, api, app"
                                                    value={composeService}
                                                    onChange={(e) => setComposeService(e.target.value)}
                                                    disabled={!canEditConfig}
                                                />
                                                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                    The service name whose published port Runnable will proxy (must match a service key in the compose file).
                                                </p>
                                            </div>
                                            <div className="form-group" style={{ marginBottom: 0 }}>
                                                <label style={{ fontSize: 13 }}>Internal Port</label>
                                                <input
                                                    className="form-input"
                                                    type="number"
                                                    min={1}
                                                    max={65535}
                                                    placeholder="e.g. 8080"
                                                    value={internalPort}
                                                    onChange={(e) => setInternalPort(e.target.value)}
                                                    disabled={!canEditConfig}
                                                />
                                                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                                    The container-side port your primary service listens on (the right side of <code>"host:container"</code> in <code>ports:</code>, or the value in <code>expose:</code>). Runnable uses this to discover the published host port.
                                                </p>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            <div className="form-group">
                                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    Environment Variables
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button
                                            type="button"
                                            className="btn btn-secondary"
                                            onClick={toggleEnvVarsTextMode}
                                            style={{ padding: '4px 8px', fontSize: 12 }}
                                        >
                                            {envVarsTextMode ? 'Edit as Form' : 'Edit as Text'}
                                        </button>
                                        {canEditConfig && !envVarsTextMode && (
                                            <button className="btn btn-secondary" onClick={addEnvVar} style={{ padding: '4px 8px', fontSize: 12 }}>
                                                <Plus size={14} /> Add Variable
                                            </button>
                                        )}
                                    </div>
                                </label>
                                {envVarsTextMode ? (
                                    <div style={{ marginTop: 10 }}>
                                        <textarea
                                            className="form-input"
                                            style={{ width: '100%', minHeight: 200, fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
                                            placeholder={'KEY=value\nANOTHER_KEY=another value\n# comments and blank lines are ignored'}
                                            value={envVarsText}
                                            onChange={(e) => setEnvVarsText(e.target.value)}
                                            disabled={!canEditConfig}
                                        />
                                        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                            One variable per line in <code>KEY=value</code> format. Lines starting with <code>#</code> are ignored.
                                        </p>
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                                        {envVars.map((env, index) => (
                                            <div key={index} style={{ display: 'flex', gap: 8 }}>
                                                <input
                                                    className="form-input"
                                                    style={{ flex: 1 }}
                                                    placeholder="KEY"
                                                    value={env.key}
                                                    onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                                                    disabled={!canEditConfig}
                                                />
                                                <input
                                                    className="form-input"
                                                    style={{ flex: 1 }}
                                                    placeholder="VALUE"
                                                    value={env.value}
                                                    onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                                                    disabled={!canEditConfig}
                                                />
                                                {canEditConfig && (
                                                    <button className="btn btn-danger" onClick={() => removeEnvVar(index)} style={{ padding: 8 }}>
                                                        <XCircle size={16} />
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {canEditConfig && (
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
                            )}

                            {canEditConfig && (
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
                            )}
                        </div>
                    </div>
                )}

                {/* COLLABORATORS TAB */}
                {tab === 'collaborators' && canManageCollaborators && (
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <Users size={20} /> Collaborators
                            </h3>
                            <button className="btn btn-primary" onClick={() => { setShowAddCollab(true); setCollabError(''); }}>
                                <UserPlus size={16} /> Invite
                            </button>
                        </div>

                        {collabLoading ? (
                            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                                <div className="spinner" style={{ width: 30, height: 30 }} />
                            </div>
                        ) : collaborators.length === 0 ? (
                            <div className="empty-state">
                                <div className="empty-state-icon"><Users size={36} /></div>
                                <h2>No collaborators</h2>
                                <p>Invite users to collaborate on this project</p>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                {collaborators.map(c => (
                                    <div key={c.id} className="glass" style={{ padding: 16, borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontWeight: 600 }}>{c.username}</div>
                                            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{c.email}</div>
                                            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                                                {Object.entries(c.permissions).filter(([, v]) => v).map(([key]) => (
                                                    <span key={key} style={{
                                                        padding: '2px 8px',
                                                        borderRadius: 12,
                                                        fontSize: 11,
                                                        background: 'rgba(164, 118, 255, 0.15)',
                                                        color: '#a476ff',
                                                    }}>
                                                        {key}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button
                                                className="btn btn-secondary"
                                                style={{ fontSize: 13, padding: '6px 12px' }}
                                                onClick={() => {
                                                    setEditingCollab(c);
                                                    setEditCollabPerms({ ...c.permissions });
                                                    setCollabError('');
                                                }}
                                            >
                                                <Edit size={14} /> Edit
                                            </button>
                                            <button
                                                className="btn btn-danger"
                                                style={{ fontSize: 13, padding: '6px 12px' }}
                                                onClick={() => handleRemoveCollaborator(c.userId)}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Add Collaborator Modal */}
                        {showAddCollab && (
                            <div className="modal-overlay" onClick={() => setShowAddCollab(false)}>
                                <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                                    <h2>Invite Collaborator</h2>
                                    {collabError && <div className="alert alert-error">{collabError}</div>}
                                    <div className="form-group">
                                        <label>Email or Username</label>
                                        <input
                                            className="form-input"
                                            placeholder="user@example.com or username"
                                            value={collabEmail}
                                            onChange={(e) => setCollabEmail(e.target.value)}
                                        />
                                    </div>
                                    <div className="form-group">
                                        <label>Permissions</label>
                                        <div style={{ marginTop: 8 }}>
                                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>View Access</p>
                                            <PermCheckbox label="Can View Files" checked={collabPerms.canViewFiles} onChange={(v) => setCollabPerms({ ...collabPerms, canViewFiles: v })} />
                                            <PermCheckbox label="Can View Domains" checked={collabPerms.canViewDomains} onChange={(v) => setCollabPerms({ ...collabPerms, canViewDomains: v })} />
                                            <PermCheckbox label="Can View GitHub" checked={collabPerms.canViewGithub} onChange={(v) => setCollabPerms({ ...collabPerms, canViewGithub: v })} />
                                            <PermCheckbox label="Can View Settings" checked={collabPerms.canViewSettings} onChange={(v) => setCollabPerms({ ...collabPerms, canViewSettings: v })} />
                                            <PermCheckbox label="Can View Logs" checked={collabPerms.canViewLogs} onChange={(v) => setCollabPerms({ ...collabPerms, canViewLogs: v })} />
                                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, marginTop: 12, fontWeight: 600 }}>Edit Access</p>
                                            <PermCheckbox label="Can Start/Stop/Restart" checked={collabPerms.canStart} onChange={(v) => setCollabPerms({ ...collabPerms, canStart: v })} />
                                            <PermCheckbox label="Can Edit Config" checked={collabPerms.canEditConfig} onChange={(v) => setCollabPerms({ ...collabPerms, canEditConfig: v })} />
                                            <PermCheckbox label="Can Edit Domains" checked={collabPerms.canEditDomains} onChange={(v) => setCollabPerms({ ...collabPerms, canEditDomains: v })} />
                                            <PermCheckbox label="Can Edit Files" checked={collabPerms.canEditFiles} onChange={(v) => setCollabPerms({ ...collabPerms, canEditFiles: v })} />
                                            <PermCheckbox label="Can Delete Project" checked={collabPerms.canDelete} onChange={(v) => setCollabPerms({ ...collabPerms, canDelete: v })} />
                                        </div>
                                    </div>
                                    <div className="modal-actions">
                                        <button className="btn btn-secondary" onClick={() => setShowAddCollab(false)}>Cancel</button>
                                        <button className="btn btn-primary" onClick={handleAddCollaborator} disabled={!collabEmail}>Invite</button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Edit Collaborator Modal */}
                        {editingCollab && (
                            <div className="modal-overlay" onClick={() => setEditingCollab(null)}>
                                <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                                    <h2>Edit Permissions for {editingCollab.username}</h2>
                                    {collabError && <div className="alert alert-error">{collabError}</div>}
                                    <div className="form-group">
                                        <div style={{ marginTop: 8 }}>
                                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>View Access</p>
                                            <PermCheckbox label="Can View Files" checked={editCollabPerms.canViewFiles} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canViewFiles: v })} />
                                            <PermCheckbox label="Can View Domains" checked={editCollabPerms.canViewDomains} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canViewDomains: v })} />
                                            <PermCheckbox label="Can View GitHub" checked={editCollabPerms.canViewGithub} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canViewGithub: v })} />
                                            <PermCheckbox label="Can View Settings" checked={editCollabPerms.canViewSettings} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canViewSettings: v })} />
                                            <PermCheckbox label="Can View Logs" checked={editCollabPerms.canViewLogs} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canViewLogs: v })} />
                                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, marginTop: 12, fontWeight: 600 }}>Edit Access</p>
                                            <PermCheckbox label="Can Start/Stop/Restart" checked={editCollabPerms.canStart} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canStart: v })} />
                                            <PermCheckbox label="Can Edit Config" checked={editCollabPerms.canEditConfig} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canEditConfig: v })} />
                                            <PermCheckbox label="Can Edit Domains" checked={editCollabPerms.canEditDomains} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canEditDomains: v })} />
                                            <PermCheckbox label="Can Edit Files" checked={editCollabPerms.canEditFiles} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canEditFiles: v })} />
                                            <PermCheckbox label="Can Delete Project" checked={editCollabPerms.canDelete} onChange={(v) => setEditCollabPerms({ ...editCollabPerms, canDelete: v })} />
                                        </div>
                                    </div>
                                    <div className="modal-actions">
                                        <button className="btn btn-secondary" onClick={() => setEditingCollab(null)}>Cancel</button>
                                        <button className="btn btn-primary" onClick={handleUpdateCollaborator}>Save</button>
                                    </div>
                                </div>
                            </div>
                        )}
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
