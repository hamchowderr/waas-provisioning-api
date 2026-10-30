import { signOut } from '@/lib/site-session';

export async function POST(request: Request) {
  await signOut();
  return Response.redirect(new URL('/', request.url), 303);
}
