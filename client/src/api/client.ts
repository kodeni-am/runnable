import axios from 'axios';

const api = axios.create({
    baseURL: '/api',
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true, // Send cookies with every request
});

// Endpoints that should NOT trigger token refresh or redirect on 401
const AUTH_ENDPOINTS = ['/auth/me', '/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

// Auto-refresh on 401
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;
        const requestPath = originalRequest?.url || '';

        // Don't retry auth endpoints — just let them fail naturally
        if (AUTH_ENDPOINTS.some(ep => requestPath.includes(ep))) {
            return Promise.reject(error);
        }

        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;
            try {
                // Server reads refreshToken from cookie and sets new cookies
                await axios.post('/api/auth/refresh', {}, { withCredentials: true });
                // Retry the original request (cookies are now refreshed)
                return api(originalRequest);
            } catch {
                // Refresh failed — redirect to login (only if not already there)
                if (window.location.pathname !== '/login') {
                    window.location.href = '/login';
                }
            }
        }
        return Promise.reject(error);
    }
);

export default api;
