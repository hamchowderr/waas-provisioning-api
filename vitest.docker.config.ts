import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.ts';

/** The suites on real containers (test/docker): npm run test:docker. Not part of npm test, which stays quick. */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['test/docker/**/*.docker-test.ts'],
      testTimeout: 300_000,
      hookTimeout: 900_000,
    },
  }),
);
