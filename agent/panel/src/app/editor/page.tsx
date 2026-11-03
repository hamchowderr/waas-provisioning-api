import { signedIn } from '@/lib/site-session';
import { EditorAssistant, EditorSignIn } from './editor-assistant';

/**
 * The chat beside the page editor: WaaS Client's Assistant panel in the block editor and the Site
 * Editor frames this page. Signed out, it asks the editor for a sign-in (the website asks the API for
 * a handoff), which comes back here signed in.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { error } = await searchParams;
  if (!(await signedIn())) return <EditorSignIn error={error} />;
  return <EditorAssistant />;
}
