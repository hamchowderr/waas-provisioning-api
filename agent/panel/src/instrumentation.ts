// The chat routes (app/api/agent-controller) send the owner's sign-in on to the assistant. They run on
// Node.js only, so the Edge runtime skips this.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { configureChatKitProxy } = await import('@/lib/mastra-proxy');
  const { authorization } = await import('@/lib/site-session');
  configureChatKitProxy({ getAuthorization: () => authorization() });
}
