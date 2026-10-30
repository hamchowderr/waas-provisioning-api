import { signedIn } from '@/lib/site-session';
import { Assistant } from './assistant';
import { SignIn } from './sign-in';

/**
 * The website assistant's chat panel. Every place an owner opens it (the shop's My website tab,
 * wp-admin, the Site Editor) shows this page; `?site=` fills in their website's address.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { site, error } = await searchParams;
  if (!(await signedIn())) return <SignIn site={site} error={error} />;
  return <Assistant />;
}
