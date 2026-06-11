import api from './client';

export interface ProjectPermissions {
    canStart: boolean;
    canEditConfig: boolean;
    canEditDomains: boolean;
    canEditFiles: boolean;
    canDelete: boolean;
    canViewLogs: boolean;
    canViewFiles: boolean;
    canViewDomains: boolean;
    canViewGithub: boolean;
    canViewSettings: boolean;
}

export interface Collaborator {
    id: string;
    userId: string;
    username: string;
    email: string;
    permissions: ProjectPermissions;
    createdAt: string;
}

export interface ContainerInfo {
    id: string;
    name: string;
    service: string;
    state: string;
    status: string;
    ports: string;
}

export interface Project {
    id: string;
    name: string;
    subdomain: string;
    directoryPath: string;
    serverType: 'caddy' | 'apache' | 'nginx' | 'static' | 'app';
    status: 'running' | 'stopped' | 'error' | 'deploying';
    port?: number;
    configPath?: string;
    containerId?: string;
    internalPort?: number | null;
    buildCommand?: string;
    startCommand?: string;
    envVars?: Record<string, string>;
    useCompose?: boolean;
    composeFile?: string;
    composeService?: string;
    notificationWebhookUrl?: string | null;
    autoRestart?: boolean;
    userId: string;
    githubRepo?: {
        id: string;
        repoUrl: string;
        branch: string;
        isPrivate: boolean;
        lastDeployAt?: string;
    };
    customDomains?: {
        id: string;
        domain: string;
        verified: boolean;
        sslProvisioned: boolean;
        redirectTarget?: string;
    }[];
    createdAt: string;
    updatedAt: string;
    _isCollaborator?: boolean;
    _permissions?: ProjectPermissions;
}

export interface CreateProjectData {
    name: string;
    subdomain: string;
    serverType: string;
}

export interface Deployment {
    id: string;
    projectId: string;
    commitSha?: string | null;
    commitMessage?: string | null;
    branch: string;
    status: 'success' | 'failed';
    trigger: 'webhook' | 'rollback';
    error?: string | null;
    createdAt: string;
}

export const projectsApi = {
    list: () => api.get<Project[]>('/projects'),
    get: (id: string) => api.get<Project>(`/projects/${id}`),
    create: (data: CreateProjectData) => api.post<Project>('/projects', data),
    update: (id: string, data: Partial<Project>) => api.put<Project>(`/projects/${id}`, data),
    delete: (id: string) => api.delete(`/projects/${id}`),

    // Service controls
    start: (id: string) => api.post(`/projects/${id}/start`),
    stop: (id: string) => api.post(`/projects/${id}/stop`),
    restart: (id: string) => api.post(`/projects/${id}/restart`),
    reloadProxy: (id: string) => api.post(`/projects/${id}/reload-proxy`),
    status: (id: string) => api.get(`/projects/${id}/status`),
    logs: (id: string, lines?: number) => api.get(`/projects/${id}/logs`, { params: { lines } }),
    listContainers: (id: string) =>
        api.get<{ containers: ContainerInfo[] }>(`/projects/${id}/containers`),
    containerLogs: (id: string, container: string, lines?: number) =>
        api.get<{ logs: string[] }>(
            `/projects/${id}/containers/${encodeURIComponent(container)}/logs`,
            { params: { lines } },
        ),

    // GitHub
    connectGithub: (id: string, repoUrl: string, branch?: string) =>
        api.post(`/projects/${id}/github/connect`, { repoUrl, branch }),
    disconnectGithub: (id: string) => api.delete(`/projects/${id}/github/disconnect`),

    // Deployments
    listDeployments: (id: string) => api.get<Deployment[]>(`/projects/${id}/deployments`),
    rollbackDeployment: (id: string, deploymentId: string) =>
        api.post<Deployment>(`/projects/${id}/deployments/${deploymentId}/rollback`),

    // Custom domains
    listDomains: (id: string) => api.get(`/projects/${id}/domains`),
    addDomain: (id: string, domain: string, redirectTarget?: string) =>
        api.post(`/projects/${id}/domains`, { domain, redirectTarget }),
    updateDomainRedirect: (id: string, domainId: string, redirectTarget: string | null) =>
        api.put(`/projects/${id}/domains/${domainId}/redirect`, { redirectTarget }),
    verifyDomain: (id: string, domainId: string) => api.post(`/projects/${id}/domains/${domainId}/verify`),
    removeDomain: (id: string, domainId: string) => api.delete(`/projects/${id}/domains/${domainId}`),

    // Files
    listFiles: (id: string, path?: string) => api.get(`/projects/${id}/files`, { params: { path } }),
    downloadFile: (id: string, path: string) =>
        api.get(`/projects/${id}/files/download`, { params: { path }, responseType: 'blob' }),
    uploadFiles: (id: string, formData: FormData) =>
        api.post(`/projects/${id}/files/upload`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
        }),
    deleteFile: (id: string, path: string) => api.delete(`/projects/${id}/files`, { params: { path } }),
    createDir: (id: string, path: string) => api.post(`/projects/${id}/files/mkdir`, { path }),
    readFile: (id: string, path: string) => api.get<{ content: string; size: number }>(`/projects/${id}/files/read`, { params: { path } }),
    writeFile: (id: string, path: string, content: string) => api.put(`/projects/${id}/files/write`, { path, content }),
    createFile: (id: string, path: string, content?: string) => api.post(`/projects/${id}/files/create`, { path, content }),

    // Collaborators
    listCollaborators: (id: string) => api.get<Collaborator[]>(`/projects/${id}/collaborators`),
    addCollaborator: (id: string, emailOrUsername: string, permissions?: Partial<ProjectPermissions>) =>
        api.post<Collaborator>(`/projects/${id}/collaborators`, { emailOrUsername, permissions }),
    updateCollaborator: (id: string, userId: string, permissions: ProjectPermissions) =>
        api.put<Collaborator>(`/projects/${id}/collaborators/${userId}`, { permissions }),
    removeCollaborator: (id: string, userId: string) =>
        api.delete(`/projects/${id}/collaborators/${userId}`),
};
