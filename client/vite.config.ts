import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../', '');
  return {
    plugins: [react()],
    envDir: '../',
    define: {
      'import.meta.env.VITE_BASE_DOMAIN': JSON.stringify(env.BASE_DOMAIN || 'localhost'),
    },
    server: {
      port: 5175,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.warn('Proxy error (backend may be offline):', err.message);
            });
          },
        },
        '/socket.io': {
          target: 'http://localhost:3001',
          ws: true,
          configure: (proxy) => {
            proxy.on('error', () => { });
          },
        },
      },
    },
  };
});
