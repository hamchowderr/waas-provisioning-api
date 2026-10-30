import { panelLink, startSignIn } from '@/lib/site-session';

const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** "Sign in with your website": hands the website's address to the API, which asks that website's wp-admin. */
export async function POST(request: Request) {
  const form = await request.formData();
  const site = String(form.get('site') ?? '').trim();
  const back = String(form.get('back') ?? '/');
  if (!site) return Response.redirect(panelLink('/?error=address'), 303);
  const { action, fields } = await startSignIn(site, back.startsWith('/') ? back : '/');
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join('');
  // A form, not a redirect: the API's sign-in takes the website's address as a POST.
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Signing in…</title><body><form method="post" action="${escape(action)}">${inputs}<noscript><button>Continue</button></noscript></form><script>document.forms[0].submit()</script></body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
