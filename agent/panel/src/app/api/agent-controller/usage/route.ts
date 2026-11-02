import { forward } from '@/lib/mastra-proxy';

// GET /api/agent-controller/usage → this month's messages for the signed-in website ({ used, limit, resetsAt }).
export async function GET(req: Request) {
  return forward(req, '/agent-controller/usage');
}
