import axios from 'axios';

const api = axios.create({
    baseURL: '/api',
    headers: { 'Content-Type': 'application/json' },
    withCredentials: true, // Send cookies with every request
});

// Auto-refresh on 401
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config;
        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true;
            try {
                // Server reads refreshToken from cookie and sets new cookies
                await axios.post('/api/auth/refresh', {}, { withCredentials: true });
                // Retry the original request (cookies are now refreshed)
                return api(originalRequest);
            } catch {
                // Refresh failed — redirect to login
                window.location.href = '/login';
            }
        }
        return Promise.reject(error);
    }
);

export default api;
