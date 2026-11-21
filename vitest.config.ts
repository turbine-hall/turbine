import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 120_000,
    // One fork avoids a worker RPC timeout while the large claims suite reports progress.
    pool: 'forks',
    fileParallelism: false,
  },
});
