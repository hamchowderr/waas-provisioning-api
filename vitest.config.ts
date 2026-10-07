import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suites share one test database.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
