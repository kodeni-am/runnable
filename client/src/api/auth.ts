import api from './client';

export interface LoginData { email: string; password: string; }
export interface RegisterData { email: string; username: string; password: string; }
export interface AuthResponse {
    user: { id: string; email: string; username: string; role: string };
}

export const authApi = {
    login: (data: LoginData) => api.post<AuthResponse>('/auth/login', data),
    register: (data: RegisterData) => api.post<AuthResponse>('/auth/register', data),
    refresh: () => api.post('/auth/refresh'),
    logout: () => api.post('/auth/logout'),
    me: () => api.get('/auth/me'),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
        api.post('/auth/change-password', data),
};
