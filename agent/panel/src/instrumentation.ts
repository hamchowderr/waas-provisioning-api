// The chat routes (app/api/agent-controller) send the owner's sign-in on to the assistant.
export async function register() {
  const { configureChatKitProxy } = await import('@/lib/mastra-proxy');
  const { authorization } = await import('@/lib/site-session');
  configureChatKitProxy({ getAuthorization: () => authorization() });
}
