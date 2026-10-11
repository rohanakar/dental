import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/** Normalize a base path to a leading + trailing slash ("dental" → "/dental/", "" → "/"). */
export function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/** Where the dev/preview proxy sends /api (override with DCAD_API_TARGET, e.g. a second API for tests). */
const API_TARGET = process.env.DCAD_API_TARGET ?? 'http://localhost:3000';

export default defineConfig(({ mode }) => {
  // VITE_BASE_PATH comes from the environment (Docker build arg) or a .env file.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const base = normalizeBase(process.env.VITE_BASE_PATH ?? env.VITE_BASE_PATH);
  const apiPrefix = `${base}api`;

  return {
    base,
    plugins: [react()],
    worker: {
      format: 'es',
    },
    server: {
      port: 5173,
      proxy: {
        // The API serves at /api/* internally; strip the sub-path prefix.
        [apiPrefix]: {
          target: API_TARGET,
          changeOrigin: false,
          rewrite: (path: string) => path.replace(new RegExp(`^${apiPrefix}`), '/api'),
        },
      },
    },
    preview: {
      port: 4173,
      proxy: {
        [apiPrefix]: {
          target: API_TARGET,
          changeOrigin: false,
          rewrite: (path: string) => path.replace(new RegExp(`^${apiPrefix}`), '/api'),
        },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      // three.js alone is ~700 kB minified; one vendor-heavy chunk is expected.
      chunkSizeWarningLimit: 1200,
    },
  };
});
