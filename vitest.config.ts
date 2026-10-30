import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // mcp/ imports the SDK by its package name; in this repo that is sdk/typescript.
    alias: { 'waas-provisioning-sdk': fileURLToPath(new URL('./sdk/typescript/src/index.ts', import.meta.url)) },
  },
  test: {
    // agent/ is its own package with its own dependencies and tests (agent/README.md).
    exclude: [...configDefaults.exclude, 'agent/**'],
    // The suites share one test database.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
