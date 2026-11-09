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
  {
    // Services with an official SDK are called through it, never by hand: Stripe (stripe), toSend
    // (tosend), S3 and R2 (aws4fetch), HighLevel (@gohighlevel/api-client), Name.com (@namecom/core-api),
    // Vercel (@vercel/sdk), Google Places (@googlemaps/places). A literal naming one of
    // their API hosts, endpoints or the AWS signing scheme means someone is writing the call by hand.
    files: ['src/**/*.ts', 'mcp/**/*.ts', 'sdk/typescript/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          ['Literal', 'value'],
          ['TemplateElement', 'value.raw'],
        ].map(([node, field]) => ({
          selector: `${node}[${field}=/api\\.stripe\\.com|api\\.tosend\\.com|\\/v2\\/(emails|domains|api-keys)|AWS4-HMAC-SHA256|leadconnectorhq\\.com\\/oauth|api\\.(dev\\.)?name\\.com|api\\.vercel\\.com|places\\.googleapis\\.com/]`,
          message: 'Call this service through its official SDK (stripe, tosend, aws4fetch, @gohighlevel/api-client, @namecom/core-api, @vercel/sdk, @googlemaps/places), not by hand.',
        })),
      ],
    },
  },
);
