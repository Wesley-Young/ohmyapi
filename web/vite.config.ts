import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, 'VITE_');
  const apiTarget = process.env.VITE_API_PROXY_TARGET ?? env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000';
  // Keep the browser's Host so the backend can validate same-origin requests.
  const proxy = { '/api': { target: apiTarget, changeOrigin: false }, '/v1': apiTarget };

  return {
    envDir: projectRoot,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy,
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy,
    },
  };
});
