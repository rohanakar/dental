import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
    // Suites build their synthetic case once in beforeAll, which can take over the 10 s default when files run in parallel.
    hookTimeout: 60_000,
  },
});
