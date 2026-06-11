import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProjectStore } from '../store/projectStore';
import { Plus, Server, FolderGit2, Globe, Users } from 'lucide-react';
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

    useEffect(() => {
        fetchProjects();
    }, []);

    const handleCreate = async () => {
        if (creating) return;
        setCreateError('');
        setCreating(true);
        try {
            const project = await createProject(name, subdomain, serverType);
            setShowCreate(false);
            setName('');
            setSubdomain('');
            setServerType('static');
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
                <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
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
                        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
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
                    <div className="modal glass" onClick={(e) => e.stopPropagation()}>
                        <h2>Create New Project</h2>

                        {createError && <div className="alert alert-error">{createError}</div>}

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

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleCreate} disabled={!name || !subdomain || creating}>
                                {creating ? <span className="spinner" /> : 'Create'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
