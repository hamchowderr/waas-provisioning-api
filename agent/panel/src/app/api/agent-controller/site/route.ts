import { forward } from '@/lib/mastra-proxy';

// GET /api/agent-controller/site → the signed-in website's address ({ url }).
export async function GET(req: Request) {
  return forward(req, '/agent-controller/site');
}
