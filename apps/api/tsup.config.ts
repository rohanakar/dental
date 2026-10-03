import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', migrate: 'src/adapters/db/migrate-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // @dcad/shared is TypeScript source in the workspace: bundle it.
  // Everything else stays external and is resolved from node_modules at runtime.
  noExternal: ['@dcad/shared'],
});
