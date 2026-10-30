import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const MESSAGES: Record<string, string> = { address: 'Type your website’s address.' };

/** Signed out: the owner types their website's address and says yes in its wp-admin. */
export function SignIn({ site, error }: { site?: string; error?: string }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form method="post" action="/signin" className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Website assistant</h1>
          <p className="text-sm text-muted-foreground">
            Change your pages and design in plain words. Sign in with your website first: we’ll ask you to say yes in its dashboard.
          </p>
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Your website’s address
          <Input name="site" defaultValue={site} placeholder="mybakery.com" autoComplete="url" required />
        </label>
        {error ? <p className="text-sm text-destructive">{MESSAGES[error] ?? error}</p> : null}
        <Button type="submit">Sign in with your website</Button>
      </form>
    </main>
  );
}
