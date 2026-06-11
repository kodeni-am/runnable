import { create } from 'zustand';
import { projectsApi } from '../api/projects';
import type { Project } from '../api/projects';

interface ProjectState {
    projects: Project[];
    currentProject: Project | null;
    isLoading: boolean;
    error: string | null;
    fetchProjects: () => Promise<void>;
    fetchProject: (id: string) => Promise<Project | void>;
    createProject: (name: string, subdomain: string, serverType: string) => Promise<Project>;
    deleteProject: (id: string) => Promise<void>;
    updateProjectStatus: (id: string, status: Project['status']) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
    projects: [],
    currentProject: null,
    isLoading: false,
    error: null,

    fetchProjects: async () => {
        set({ isLoading: true, error: null });
        try {
            const { data } = await projectsApi.list();
            set({ projects: data, isLoading: false });
        } catch (error: any) {
            set({ error: error.response?.data?.error || 'Failed to fetch projects', isLoading: false });
        }
    },

    fetchProject: async (id) => {
        // Drop a previously-viewed project so the page never renders stale
        // data (or acts on the wrong project) while the new one loads.
        set((state) => ({
            isLoading: true,
            error: null,
            currentProject: state.currentProject?.id === id ? state.currentProject : null,
        }));
        try {
            const { data } = await projectsApi.get(id);
            set({ currentProject: data, isLoading: false });
            return data;
        } catch (error: any) {
            set({ error: error.response?.data?.error || 'Failed to fetch project', isLoading: false });
        }
    },

    createProject: async (name, subdomain, serverType) => {
        const { data } = await projectsApi.create({ name, subdomain, serverType });
        set((state) => ({ projects: [data, ...state.projects] }));
        return data;
    },

    deleteProject: async (id) => {
        await projectsApi.delete(id);
        set((state) => ({
            projects: state.projects.filter((p) => p.id !== id),
            currentProject: state.currentProject?.id === id ? null : state.currentProject,
        }));
    },

    updateProjectStatus: (id, status) => {
        set((state) => ({
            projects: state.projects.map((p) => (p.id === id ? { ...p, status } : p)),
            currentProject: state.currentProject?.id === id
                ? { ...state.currentProject, status }
                : state.currentProject,
        }));
    },
}));
