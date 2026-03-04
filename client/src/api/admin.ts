import api from './client';

export interface UserPermissions {
    maxProjects: number | null;
    canCreateProjects: boolean;
    canUseCustomDomains: boolean;
    allowedServerTypes: string[] | null;
}

export interface UserDTO {
    id: string;
    email: string;
    username: string;
    role: string;
    isApproved: boolean;
    createdAt: string;
    githubId?: string;
    googleId?: string;
    permissions?: UserPermissions;
}

export const adminApi = {
    getUsers: () => api.get<UserDTO[]>('/admin/users'),
    approveUser: (id: string) => api.put<{ message: string }>(`/admin/users/${id}/approve`),
    deleteUser: (id: string) => api.delete<{ message: string }>(`/admin/users/${id}`),
    updateUserPermissions: (id: string, permissions: UserPermissions) =>
        api.put<{ message: string; permissions: UserPermissions }>(`/admin/users/${id}/permissions`, { permissions }),
};
