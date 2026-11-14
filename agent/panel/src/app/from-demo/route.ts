import { panelLink, startDemoSignIn } from '@/lib/site-session';

/**
 * The Assistant panel beside a demo's editor on anypress.io/try lands here, with `?demo=` (the demo's sign-in, which
 * anypress.io got from the API and put in the demo), and goes on to the chat beside the editor.
 */
export async function GET(request: Request) {
  const demo = new URL(request.url).searchParams.get('demo') ?? '';
  if (!(await startDemoSignIn(demo))) return Response.redirect(await panelLink(`/editor?error=${encodeURIComponent('This demo has ended. Start it again to keep going.')}`), 303);
  return Response.redirect(await panelLink('/editor'), 303);
}
