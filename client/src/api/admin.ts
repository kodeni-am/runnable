import api from './client';

export interface UserDTO {
    id: string;
    email: string;
    username: string;
    role: string;
    isApproved: boolean;
    createdAt: string;
    githubId?: string;
    googleId?: string;
}

export const adminApi = {
    getUsers: () => api.get<UserDTO[]>('/admin/users'),
    approveUser: (id: string) => api.put<{ message: string }>(`/admin/users/${id}/approve`),
    deleteUser: (id: string) => api.delete<{ message: string }>(`/admin/users/${id}`),
};
