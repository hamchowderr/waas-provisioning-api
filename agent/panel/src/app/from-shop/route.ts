import { panelLink, startShopSignIn } from '@/lib/site-session';

/** The shop's "Ask the website assistant" button lands here, with `?handoff=` from the API. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const started = await startShopSignIn(url.searchParams.get('handoff') ?? '');
  if ('error' in started) return Response.redirect(panelLink(`/?error=${encodeURIComponent(started.error)}`), 303);
  return Response.redirect(started.next, 303);
}
