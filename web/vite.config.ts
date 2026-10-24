import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** 读取构建时仓库的 HEAD；没有 git 或不在仓库中时返回 null，前端不显示版本。 */
function readVersion() {
  try {
    const output = execFileSync('git', ['log', '-1', '--format=%h%n%cI'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [commit, date] = output.trim().split('\n');
    return commit && date ? { commit, date } : null;
  } catch {
    return null;
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, 'VITE_');
  const apiTarget = process.env.VITE_API_PROXY_TARGET ?? env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000';
  // Keep the browser's Host so the backend can validate same-origin requests.
  const proxy = { '/api': { target: apiTarget, changeOrigin: false }, '/v1': apiTarget };

  return {
    envDir: projectRoot,
    plugins: [react()],
    define: { __OMA_VERSION__: JSON.stringify(readVersion()) },
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
