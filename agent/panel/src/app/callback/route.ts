import { finishSignIn } from '@/lib/site-session';

/** Where the API sends the owner back after their website said yes (or no). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = await finishSignIn(url.searchParams);
  const next = 'back' in result ? result.back : `/?error=${encodeURIComponent(result.error)}`;
  return Response.redirect(new URL(next, url), 303);
}
