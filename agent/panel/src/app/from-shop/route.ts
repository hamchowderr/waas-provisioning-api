import { startShopSignIn } from '@/lib/site-session';

/** The shop's "Website assistant" button lands here: `?shop=` is the shop's sign-in address for this owner. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = await startShopSignIn(url.searchParams.get('shop') ?? '');
  if (!next) return Response.redirect(new URL(`/?error=${encodeURIComponent('That shop can’t sign you in here. Type your website’s address instead.')}`, url), 303);
  return Response.redirect(next, 303);
}
