import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 120_000,
    pool: 'forks',
    // Keep files parallel so a long claims file does not starve the RPC heartbeat for the whole run.
    fileParallelism: true,
  },
});
