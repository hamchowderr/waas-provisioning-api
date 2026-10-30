import { panelLink, signOut } from '@/lib/site-session';

export async function POST() {
  await signOut();
  return Response.redirect(panelLink('/'), 303);
}
