import api from './client';

export interface PasskeySummary {
    id: string;
    name: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: string;
    lastUsedAt: string | null;
}

export const passkeysApi = {
    registerOptions: () => api.post('/auth/passkeys/register/options'),
    registerVerify: (data: { response: unknown; name: string }) =>
        api.post<PasskeySummary>('/auth/passkeys/register/verify', data),
    list: () => api.get<PasskeySummary[]>('/auth/passkeys'),
    remove: (id: string) => api.delete(`/auth/passkeys/${id}`),
    loginOptions: () => api.post('/auth/passkeys/login/options'),
    loginVerify: (data: { response: unknown }) =>
        api.post<{ user: unknown }>('/auth/passkeys/login/verify', data),
};
