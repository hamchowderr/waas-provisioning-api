import { forward } from '@/lib/mastra-proxy';

// GET /api/agent-controller/business → what the website and its owner say about the business.
export async function GET(req: Request) {
  return forward(req, '/agent-controller/business');
}

// PATCH /api/agent-controller/business { about } → saves the owner's corrections.
export async function PATCH(req: Request) {
  return forward(req, '/agent-controller/business', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: await req.text() });
}
