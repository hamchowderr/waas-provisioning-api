'use client';

import { CheckIcon, StoreIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { withBase } from '@/lib/base-path';

/** The owner's own facts, in the order and words the form shows them. */
const FIELDS = [
  { key: 'what', label: 'What your business does', hint: 'For example: a family bakery making sourdough and cakes to order' },
  { key: 'who', label: 'Who it’s for', hint: 'For example: families and offices in north Austin' },
  { key: 'area', label: 'Where you work', hint: 'Your town, or the area you cover' },
  { key: 'hours', label: 'Opening hours', hint: 'For example: Tue to Sat, 7am to 3pm' },
  { key: 'contact', label: 'How customers reach you', hint: 'Phone, email, or “book online”' },
  { key: 'voice', label: 'How your website should sound', hint: 'For example: warm and plain, no jargon' },
  { key: 'notes', label: 'Anything else the assistant should know', hint: 'Awards, what makes you different, words to avoid' },
] as const;
type Field = (typeof FIELDS)[number]['key'];

type Profile = {
  site?: {
    name?: string;
    owner?: { name?: string; phone?: string; city?: string; state?: string; country?: string };
    language?: string;
    timezone?: string;
    currency?: string;
    products?: { name?: string; price?: string }[];
    bookings?: { name?: string; minutes?: number }[];
    forms?: string[];
  };
  about?: Partial<Record<Field, string>>;
};

/** What the website already says, as label and value rows; empty ones left out. */
function siteRows(site: NonNullable<Profile['site']>): [string, string][] {
  const owner = site.owner ?? {};
  const rows: [string, string | undefined][] = [
    ['Website', site.name],
    ['Owner', owner.name],
    ['Where', [owner.city, owner.state, owner.country].filter(Boolean).join(', ')],
    ['Phone', owner.phone],
    ['Language', site.language?.replace('_', '-')],
    ['Time zone', site.timezone],
    ['Products', site.products?.map((p) => (p.price ? `${p.name} (${p.price}${site.currency ? ` ${site.currency}` : ''})` : p.name)).join(', ')],
    ['Booking types', site.bookings?.map((b) => b.name).join(', ')],
    ['Forms', site.forms?.join(', ')],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

/**
 * "About your business": what the assistant knows before the owner types a word. What the website says (from the
 * purchase, its settings, shop, bookings and forms) is shown to check; what the owner has told it can be corrected
 * here and saved straight to the website.
 */
export function BusinessProfileButton() {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const answer = useCallback(async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as Profile & { error?: string };
    if (!response.ok) {
      setError(body.error ?? 'Your website couldn’t answer just now. Try again in a minute.');
      setState('error');
      return;
    }
    setProfile(body);
    setDraft(body.about ?? {});
    setError(null);
    setState('ready');
  }, []);

  useEffect(() => {
    if (!open) return;
    setState('loading');
    fetch(withBase('/api/agent-controller/business'))
      .then(answer)
      .catch(() => {
        setError('Your website couldn’t answer just now. Try again in a minute.');
        setState('error');
      });
  }, [open, answer]);

  const changed = FIELDS.some(({ key }) => (draft[key] ?? '') !== (profile?.about?.[key] ?? ''));

  const save = async () => {
    setState('saving');
    const about = Object.fromEntries(FIELDS.map(({ key }) => [key, (draft[key] ?? '').trim()]).filter(([key, value]) => value !== (profile?.about?.[key as Field] ?? '')));
    const response = await fetch(withBase('/api/agent-controller/business'), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ about }) }).catch(() => null);
    if (!response) {
      setError('Your website couldn’t answer just now. Try again in a minute.');
      setState('error');
      return;
    }
    await answer(response);
    if (response.ok) setState('saved');
  };

  const rows = profile?.site ? siteRows(profile.site) : [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="About your business" title="About your business">
          <StoreIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>About your business</DialogTitle>
          <DialogDescription>The assistant reads this before every answer, so it writes about your business, not a made-up one.</DialogDescription>
        </DialogHeader>

        {state === 'loading' && (
          <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
            <Spinner /> Reading your website…
          </div>
        )}

        {state === 'error' && !profile && <p className="text-sm text-destructive">{error}</p>}

        {profile && (
          <>
            <section className="space-y-2">
              <h3 className="font-medium text-sm">From your website</h3>
              {rows.length ? (
                <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
                  {rows.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="min-w-0 break-words">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-muted-foreground text-sm">Nothing yet.</p>
              )}
              <p className="text-muted-foreground text-xs">These come from your purchase and your website’s settings, shop, bookings and forms, and update when those change.</p>
            </section>

            <section className="space-y-3">
              <h3 className="font-medium text-sm">What you’ve told the assistant</h3>
              {FIELDS.map(({ key, label, hint }) => (
                <label key={key} className="block space-y-1.5">
                  <span className="text-sm">{label}</span>
                  <Textarea
                    value={draft[key] ?? ''}
                    placeholder={hint}
                    maxLength={key === 'notes' ? 1500 : 500}
                    rows={key === 'notes' ? 3 : 1}
                    className="min-h-10 py-2"
                    onChange={(event) => {
                      setDraft((now) => ({ ...now, [key]: event.target.value }));
                      if (state === 'saved' || state === 'error') setState('ready');
                    }}
                  />
                </label>
              ))}
            </section>

            <div className="flex items-center justify-end gap-3">
              {state === 'error' && <p className="mr-auto text-sm text-destructive">{error}</p>}
              {state === 'saved' && (
                <span className="mr-auto inline-flex items-center gap-1 text-muted-foreground text-sm" role="status">
                  <CheckIcon className="size-4" /> Saved
                </span>
              )}
              <Button onClick={save} disabled={!changed || state === 'saving'}>
                {state === 'saving' ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
