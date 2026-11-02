import { address, signedIn } from '@/lib/site-session';
import { EditorAssistant, EditorSignIn } from './editor-assistant';

/**
 * The chat beside the page editor: WaaS Client's Assistant panel in the block editor and the Site
 * Editor frames this page. Signed out, it asks the editor for a sign-in (the website asks the API for
 * a handoff), which comes back here signed in.
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { error } = await searchParams;
  // Framed at the panel's own address only by WaaS Client before 2.12.
  const older = (await address()).own;
  if (!(await signedIn())) return <EditorSignIn error={error} older={older} />;
  return <EditorAssistant older={older} />;
}
