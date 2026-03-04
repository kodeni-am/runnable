import { create } from 'zustand';
import { authApi } from '../api/auth';

export interface UserPermissions {
    maxProjects: number | null;
    canCreateProjects: boolean;
    canUseCustomDomains: boolean;
    allowedServerTypes: string[] | null;
}

interface User {
    id: string;
    email: string;
    username: string;
    role: string;
    isApproved: boolean;
    githubId?: string | null;
    googleId?: string | null;
    permissions?: UserPermissions;
}

interface AuthState {
    user: User | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (email: string, username: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
    loadUser: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,

    login: async (email, password) => {
        set({ isLoading: true });
        try {
            const { data } = await authApi.login({ email, password });
            // Tokens are set as HTTP-only cookies by the server
            set({ user: data.user as User, isAuthenticated: true, isLoading: false });
        } catch (error) {
            set({ isLoading: false });
            throw error;
        }
    },

    register: async (email, username, password) => {
        set({ isLoading: true });
        try {
            const { data } = await authApi.register({ email, username, password });
            // Tokens are set as HTTP-only cookies by the server
            set({ user: data.user as User, isAuthenticated: true, isLoading: false });
        } catch (error) {
            set({ isLoading: false });
            throw error;
        }
    },

    logout: async () => {
        try {
            await authApi.logout();
        } catch {
            // Clear state even if server call fails
        }
        set({ user: null, isAuthenticated: false });
    },

    loadUser: async () => {
        try {
            const { data } = await authApi.me();
            set({ user: data as User, isAuthenticated: true });
        } catch {
            set({ user: null, isAuthenticated: false });
        }
    },
}));
