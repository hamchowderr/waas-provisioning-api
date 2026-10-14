import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // mcp/ imports the SDK by its package name; in this repo that is sdk/typescript.
    alias: { 'waas-provisioning-sdk': fileURLToPath(new URL('./sdk/typescript/src/index.ts', import.meta.url)) },
  },
  test: {
    // The suites share one test database.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
