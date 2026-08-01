import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev pod puts web and api in one network namespace, so the API is on
// localhost. Under compose they are separate hosts, hence the env override.
const apiTarget = process.env['VITE_API_URL'] ?? 'http://localhost:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Bind-mounted source over a container boundary does not deliver inotify
    // events reliably; polling is the cost of editing on the host.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
