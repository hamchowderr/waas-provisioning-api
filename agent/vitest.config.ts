import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The tests run the API (../src) in-process; its MCP server imports the SDK by package name.
    alias: { 'waas-provisioning-sdk': fileURLToPath(new URL('../sdk/typescript/src/index.ts', import.meta.url)) },
  },
  test: {
    // They share the API's test database.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
