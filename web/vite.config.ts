import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, 'VITE_');
  const apiTarget = process.env.VITE_API_PROXY_TARGET ?? env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000';

  return {
    envDir: projectRoot,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': apiTarget, '/v1': apiTarget },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      strictPort: true,
      proxy: { '/api': apiTarget, '/v1': apiTarget },
    },
  };
});
