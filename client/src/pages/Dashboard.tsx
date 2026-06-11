import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/projectStore';
import { projectsApi, type AppTemplateInfo } from '../api/projects';
import { Plus, Server, FolderGit2, Globe, Users, ArrowLeft, Database, AppWindow } from 'lucide-react';
import Layout from '../components/Layout';
import StatusBadge from '../components/StatusBadge';
import ServerStatsWidget from '../components/ServerStatsWidget';
import { usePageTitle } from '../hooks/usePageTitle';
import { useAuthStore } from '../store/authStore';

export default function Dashboard() {
    usePageTitle('Dashboard');
    const { projects, isLoading, fetchProjects } = useProjectStore();
    const { user } = useAuthStore();
    const navigate = useNavigate();
    const [showCreate, setShowCreate] = useState(false);
    const [name, setName] = useState('');
    const [subdomain, setSubdomain] = useState('');
    const [serverType, setServerType] = useState('static');
    const [createError, setCreateError] = useState('');
    const [creating, setCreating] = useState(false);
    const { createProject } = useProjectStore();

    // Template mode state
    const [createMode, setCreateMode] = useState<'blank' | 'template'>('blank');
    const [templates, setTemplates] = useState<AppTemplateInfo[]>([]);
    const [selectedTemplate, setSelectedTemplate] = useState<AppTemplateInfo | null>(null);
    const [templateEnv, setTemplateEnv] = useState<Record<string, string>>({});

    useEffect(() => {
        fetchProjects();
    }, []);

    const openCreate = () => {
        setShowCreate(true);
        setCreateMode('blank');
        setSelectedTemplate(null);
        setCreateError('');
        if (templates.length === 0) {
            projectsApi.listTemplates().then(({ data }) => setTemplates(data)).catch(() => { });
        }
    };

    const selectTemplate = (t: AppTemplateInfo) => {
        setSelectedTemplate(t);
        if (!name) setName(t.name);
        const env: Record<string, string> = {};
        for (const spec of t.env) {
            if (!spec.generate) env[spec.key] = spec.defaultValue || '';
        }
        setTemplateEnv(env);
    };

    const handleCreate = async () => {
        if (creating) return;
        setCreateError('');
        setCreating(true);
        try {
            let project;
            if (createMode === 'template' && selectedTemplate) {
                const { data } = await projectsApi.createFromTemplate({
                    templateKey: selectedTemplate.key,
                    name,
                    subdomain,
                    env: templateEnv,
                });
                project = data;
                fetchProjects();
            } else {
                project = await createProject(name, subdomain, serverType);
            }
            setShowCreate(false);
            setName('');
            setSubdomain('');
            setServerType('static');
            setSelectedTemplate(null);
            navigate(`/projects/${project.id}`);
        } catch (err: any) {
            setCreateError(err.response?.data?.error || 'Failed to create project');
        } finally {
            setCreating(false);
        }
    };

    const serverTypeIcon: Record<string, string> = {
        caddy: '⚡',
        nginx: '🟢',
        apache: '🔶',
        static: '📁',
        app: '🐳',
    };

    return (
        <Layout>
            <div className="page-header">
                <h1>Projects</h1>
                <button className="btn btn-primary" onClick={openCreate}>
                    <Plus size={18} /> New Project
                </button>
            </div>

            <div className="page-content">
                {user?.role === 'admin' && <ServerStatsWidget />}

                {isLoading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
                        <div className="spinner" style={{ width: 40, height: 40 }} />
                    </div>
                ) : projects.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">
                            <Server size={36} />
                        </div>
                        <h2>No projects yet</h2>
                        <p>Create your first project to get started</p>
                        <button className="btn btn-primary" onClick={openCreate}>
                            <Plus size={18} /> Create Project
                        </button>
                    </div>
                ) : (
                    <div className="projects-grid">
                        {projects.map((project) => (
                            <div
                                key={project.id}
                                className="project-card glass"
                                onClick={() => navigate(`/projects/${project.id}`)}
                            >
                                <div className="project-card-header">
                                    <div>
                                        <div className="project-name" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            {project.name}
                                            {(project as any)._isCollaborator && (
                                                <span style={{
                                                    padding: '2px 8px',
                                                    borderRadius: 12,
                                                    fontSize: 11,
                                                    background: 'rgba(100, 180, 255, 0.15)',
                                                    color: '#64b4ff',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 4,
                                                }}>
                                                    <Users size={10} /> Shared
                                                </span>
                                            )}
                                        </div>
                                        <div className="project-subdomain">
                                            <Globe size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                                            {project.subdomain}.{import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'}
                                        </div>
                                    </div>
                                    <StatusBadge status={project.status} />
                                </div>
                                <div className="project-card-footer">
                                    <span className="project-type-badge">
                                        {serverTypeIcon[project.serverType]} {project.serverType}
                                    </span>
                                    {project.githubRepo && (
                                        <span style={{ color: 'var(--text-muted)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <FolderGit2 size={14} /> Connected
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Create Project Modal */}
            {showCreate && (
                <div className="modal-overlay" onClick={() => setShowCreate(false)}>
                    <div className="modal glass" onClick={(e) => e.stopPropagation()} style={{ maxWidth: createMode === 'template' && !selectedTemplate ? 640 : undefined }}>
                        <h2>Create New Project</h2>

                        {/* Mode toggle */}
                        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                            <button
                                className={`btn ${createMode === 'blank' ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => { setCreateMode('blank'); setSelectedTemplate(null); }}
                            >
                                Blank Project
                            </button>
                            <button
                                className={`btn ${createMode === 'template' ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => setCreateMode('template')}
                            >
                                From Template
                            </button>
                        </div>

                        {createError && <div className="alert alert-error">{createError}</div>}

                        {/* Template picker */}
                        {createMode === 'template' && !selectedTemplate && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, maxHeight: 380, overflowY: 'auto' }}>
                                {templates.length === 0 && (
                                    <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 20 }}>
                                        <span className="spinner" />
                                    </div>
                                )}
                                {templates.map((t) => (
                                    <button
                                        key={t.key}
                                        onClick={() => selectTemplate(t)}
                                        className="glass"
                                        style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer', background: 'rgba(255,255,255,0.03)', color: 'inherit' }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                            {t.kind === 'database' ? <Database size={16} /> : <AppWindow size={16} />}
                                            <span style={{ fontWeight: 600 }}>{t.name}</span>
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.description}</div>
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Selected template header + env fields */}
                        {createMode === 'template' && selectedTemplate && (
                            <>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                                    <button className="btn-icon" onClick={() => setSelectedTemplate(null)} title="Choose another template">
                                        <ArrowLeft size={16} />
                                    </button>
                                    {selectedTemplate.kind === 'database' ? <Database size={18} /> : <AppWindow size={18} />}
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{selectedTemplate.name}</div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{selectedTemplate.description}</div>
                                    </div>
                                </div>
                                {selectedTemplate.kind === 'database' && (
                                    <div className="alert alert-info" style={{ fontSize: 13 }}>
                                        This is a TCP service — connect to it via the host port shown on the project page, not the subdomain URL.
                                    </div>
                                )}
                                {selectedTemplate.env.filter(e => !e.generate).map((spec) => (
                                    <div className="form-group" key={spec.key}>
                                        <label>{spec.label}</label>
                                        <input
                                            className="form-input"
                                            value={templateEnv[spec.key] ?? ''}
                                            onChange={(e) => setTemplateEnv({ ...templateEnv, [spec.key]: e.target.value })}
                                        />
                                    </div>
                                ))}
                                {selectedTemplate.env.some(e => e.generate) && (
                                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
                                        Secrets ({selectedTemplate.env.filter(e => e.generate).map(e => e.key).join(', ')}) are generated automatically — view them later in Settings → Environment Variables.
                                    </p>
                                )}
                            </>
                        )}

                        {(createMode === 'blank' || selectedTemplate) && (
                            <>
                                <div className="form-group">
                                    <label>Project Name</label>
                                    <input className="form-input" placeholder="My Website" value={name} onChange={(e) => setName(e.target.value)} />
                                </div>
                                <div className="form-group">
                                    <label>Subdomain</label>
                                    <input
                                        className="form-input"
                                        placeholder="my-website"
                                        value={subdomain}
                                        onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                    />
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                                        {subdomain || 'my-website'}.{import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'}
                                    </span>
                                </div>
                            </>
                        )}
                        {createMode === 'blank' && (
                            <div className="form-group">
                                <label>Server Type</label>
                                <select className="form-select" value={serverType} onChange={(e) => setServerType(e.target.value)}>
                                    <option value="static">📁 Static Files</option>
                                    <option value="app">🐳 Application (Node, Python, Go, etc)</option>
                                    <option value="caddy">⚡ Caddy</option>
                                    <option value="nginx">🟢 Nginx</option>
                                    <option value="apache">🔶 Apache</option>
                                </select>
                            </div>
                        )}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                            <button
                                className="btn btn-primary"
                                onClick={handleCreate}
                                disabled={!name || !subdomain || creating || (createMode === 'template' && !selectedTemplate)}
                            >
                                {creating ? <span className="spinner" /> : 'Create'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
