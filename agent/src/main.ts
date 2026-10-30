import { serve } from '@hono/node-server';
import { PostgresStore } from '@mastra/pg';
import { createAssistant } from './assistant.js';
import { createServer } from './server.js';

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const storage = new PostgresStore({ id: 'assistant', connectionString: need('DATABASE_URL'), schemaName: 'assistant' });
const model = need('ASSISTANT_MODEL');
const anthropicApiKey = need('ANTHROPIC_API_KEY');

const app = createServer({
  createAssistant: (callSite) => createAssistant({ model, anthropicApiKey, storage, callSite }),
  apiUrl: need('ANYPRESS_API_URL'),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
});

const port = Number(process.env.PORT ?? 3100);
serve({ fetch: app.fetch, port });
console.log(`website assistant on :${port}`);
