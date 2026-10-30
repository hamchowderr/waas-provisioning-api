import { serve } from '@hono/node-server';
import { PostgresStore } from '@mastra/pg';
import { createAssistant } from './assistant.js';
import { createServer } from './server.js';

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const { agent } = createAssistant({
  model: need('ASSISTANT_MODEL'),
  anthropicApiKey: need('ANTHROPIC_API_KEY'),
  storage: new PostgresStore({ id: 'assistant', connectionString: need('DATABASE_URL'), schemaName: 'assistant' }),
});

const port = Number(process.env.PORT ?? 3100);
serve({ fetch: createServer({ assistant: agent, apiUrl: need('ANYPRESS_API_URL') }).fetch, port });
console.log(`website assistant on :${port}`);
