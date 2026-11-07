// Lint for the API, the SDK and the MCP server. The agent/, voice/ and integrations/ packages lint on their own.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '.claude/**', 'agent/**', 'voice/**', 'integrations/**', 'install/**', 'templates/**', 'sdk/typescript/src/generated/**', '**/dist/**', 'sdk/php/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // JSON from Coolify, WordPress and other APIs is read as `any` on purpose, then checked.
      '@typescript-eslint/no-explicit-any': 'off',
      // TypeScript already checks names; typescript-eslint advises turning this off.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
