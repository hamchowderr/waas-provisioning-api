import { withBase } from '@/lib/base-path';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const MESSAGES: Record<string, string> = { address: 'Type your website’s address.' };

/** Signed out: the owner types their website's address and says yes in its wp-admin. */
export function SignIn({ site, error }: { site?: string; error?: string }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form method="post" action={withBase('/signin')} className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Website assistant</h1>
          <p className="text-sm text-muted-foreground">
            Change your pages and design in plain words. Opening it from your account on the shop signs you in by itself. Here, type your website’s address, then log in to its WordPress to let the assistant in.
          </p>
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Your website’s address
          <Input name="site" defaultValue={site} placeholder="mybakery.com" autoComplete="url" required />
        </label>
        {error ? <p className="text-sm text-destructive">{MESSAGES[error] ?? error}</p> : null}
        <Button type="submit">Continue with WordPress</Button>
      </form>
    </main>
  );
}
