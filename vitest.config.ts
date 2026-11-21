import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    // The claims suite plants many git repositories; individual cases may run for tens of seconds.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Avoid a worker RPC timeout while a long file is still reporting progress.
    teardownTimeout: 60_000,
    pool: 'forks',
    fileParallelism: true,
  },
});
