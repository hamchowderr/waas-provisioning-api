import { panelLink, startShopSignIn } from '@/lib/site-session';

/** Where a handoff may return to: the chat, or the chat beside the page editor. */
const BACK = new Set(['/', '/editor']);

/**
 * The shop's "Ask the website assistant" button lands here, with `?handoff=` from the API, and so does
 * the page editor's Assistant panel (with `back=/editor`), whose handoff the website itself asked for.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = BACK.has(url.searchParams.get('back') ?? '') ? url.searchParams.get('back')! : '/';
  const started = await startShopSignIn(url.searchParams.get('handoff') ?? '', back);
  if ('error' in started) return Response.redirect(await panelLink(`${back}?error=${encodeURIComponent(started.error)}`), 303);
  return Response.redirect(started.next, 303);
}
